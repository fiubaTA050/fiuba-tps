import 'server-only'

import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { assignmentInvitations, assignments, groupAssignments } from '@/db/schema'
import {
  findSlugClash,
  invitationKey,
  invitationShortKey,
  resolveStarterCode,
  slugClashMessage,
  validateTitleAndSlug,
  type AssignmentField,
} from '@/lib/data/assignment-fields'
import { findTeachingClassroom } from '@/lib/data/organizations'
import { isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'

/**
 * Individual assignments data layer. DA-4: no query lives outside here, and
 * every function receives the session and filters by user — the boundary is
 * `findTeachingClassroom`, which joins against `organizations_users`; there is
 * no RLS.
 *
 * Port of AssignmentsController#new/#create and the Assignment model. What the
 * two kinds of assignment share lives in lib/data/assignment-fields.ts; the
 * group flow is in lib/data/group-assignments.ts.
 */

export type { AssignmentField }

export type CreateAssignmentResult =
  | { success: true; slug: string }
  | { success: false; error: string; field: AssignmentField }

/** #destroy has nothing to say about a field: it either happened or it did not */
export type DeleteAssignmentResult = { success: true } | { success: false; error: string }

export type AssignmentListItem = {
  id: number
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  /** The key of the invitation URL. AssignmentInvitation#to_param */
  invitationKey: string
  /** Null on invitations created before short keys existed */
  invitationShortKey: string | null
  /** Assignment#starter_code? is `starterCodeRepoId !== null` */
  starterCodeRepoId: number | null
  /** Null means no automated grading. See worker-corrector-plan memory. */
  autograderId: string | null
}

export type NewAssignmentInput = {
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  /** `owner/name` of the template repo, or empty for no starter code */
  starterCodeRepo: string
  /** Free text id an external autograder worker reads, or null for none */
  autograderId: string | null
}

/**
 * Port of the `@assignments` of OrganizationsController#show.
 *
 * Ordered by id like the original's default; it reads as creation order, which
 * is the order the teacher built the course in.
 */
export async function listAssignments(
  session: Session,
  classroomSlug: string,
): Promise<AssignmentListItem[]> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return []

  const rows = await db
    .select({
      id: assignments.id,
      title: assignments.title,
      slug: assignments.slug,
      publicRepo: assignments.publicRepo,
      invitationsEnabled: assignments.invitationsEnabled,
      studentsAreRepoAdmins: assignments.studentsAreRepoAdmins,
      invitationKey: assignmentInvitations.key,
      invitationShortKey: assignmentInvitations.shortKey,
      starterCodeRepoId: assignments.starterCodeRepoId,
      autograderId: assignments.autograderId,
    })
    .from(assignments)
    // An inner join: `validates :assignment_invitation, presence: true` makes
    // an assignment without one impossible, and one that slipped through has
    // no shareable link, so listing it would only mislead.
    .innerJoin(
      assignmentInvitations,
      and(
        eq(assignmentInvitations.assignmentId, assignments.id),
        isNull(assignmentInvitations.deletedAt),
      ),
    )
    .where(and(eq(assignments.organizationId, classroom.id), isNull(assignments.deletedAt)))
    .orderBy(asc(assignments.id))

  return rows
}

/**
 * The counter of the Assignments tab. `@organization.assignments.count` in the
 * original's terms, except the original never showed one — the tab bar with
 * counters comes from the live site, see components/ClassroomNav.
 *
 * Counts both kinds: the tab lists both, so a counter that only saw the
 * individual ones would contradict the page under it.
 */
export async function countAssignments(session: Session, classroomSlug: string): Promise<number> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return 0

  const [individual] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(eq(assignments.organizationId, classroom.id), isNull(assignments.deletedAt)))

  const [group] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(groupAssignments)
    .where(
      and(eq(groupAssignments.organizationId, classroom.id), isNull(groupAssignments.deletedAt)),
    )

  return individual.count + group.count
}

/**
 * Port of AssignmentsController#set_assignment:
 *
 *   @organization.assignments.includes(:assignment_invitation).find_by!(slug:)
 *
 * Returns null instead of raising, so the page answers 404 without leaking
 * whether the assignment exists.
 */
export async function findAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<AssignmentListItem | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [row] = await db
    .select({
      id: assignments.id,
      title: assignments.title,
      slug: assignments.slug,
      publicRepo: assignments.publicRepo,
      invitationsEnabled: assignments.invitationsEnabled,
      studentsAreRepoAdmins: assignments.studentsAreRepoAdmins,
      invitationKey: assignmentInvitations.key,
      invitationShortKey: assignmentInvitations.shortKey,
      starterCodeRepoId: assignments.starterCodeRepoId,
      autograderId: assignments.autograderId,
    })
    .from(assignments)
    .innerJoin(
      assignmentInvitations,
      and(
        eq(assignmentInvitations.assignmentId, assignments.id),
        isNull(assignmentInvitations.deletedAt),
      ),
    )
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
      ),
    )

  return row ?? null
}

/**
 * Port of AssignmentsController#create.
 *
 * The original's order:
 *   1. Assignment.new(new_assignment_params) — creator and organization merged in
 *   2. build_assignment_invitation
 *   3. save → runs every validation, both records at once via autosave
 *   4. deadline&.create_job
 *
 * Steps 1 to 3 carry over as they are; step 4 does not exist here — this
 * assignment-level `deadline` was never ported. What exists instead is a
 * per-checkpoint `deadline_at` (`db/schema.ts`, `lib/data/checkpoints.ts`), a
 * deliberately different concept: see docs/entregas.md.
 */
export async function createAssignment(
  session: Session,
  classroomSlug: string,
  input: NewAssignmentInput,
): Promise<CreateAssignmentResult> {
  const title = input.title.trim()
  const slug = input.slug.trim()

  const classroom = await findTeachingClassroom(session, classroomSlug)

  // OrganizationAuthorization: not a teacher of this classroom, or it is gone
  if (!classroom) {
    return {
      success: false,
      error: 'No encontramos ese classroom.',
      field: 'base',
    }
  }

  // validate :organization_is_not_archived
  if (classroom.archivedAt) {
    return {
      success: false,
      error: 'No se pueden crear trabajos prácticos en un classroom archivado.',
      field: 'base',
    }
  }

  const invalid = validateTitleAndSlug(title, slug)
  if (invalid) return { success: false, ...invalid }

  // Rails resolved uniqueness with a query before hitting the constraint,
  // which is what makes the message specific. Both indexes cover the same row,
  // so without this Postgres reports whichever it happens to check first.
  if (await isTitleTaken(classroom.id, title)) {
    return {
      success: false,
      error: `Ya existe un trabajo práctico llamado "${title}" en este classroom.`,
      field: 'title',
    }
  }

  // Widened from the original's `uniqueness_of_slug_across_organization`: the
  // slug is a repository prefix, and repository names belong to the GitHub
  // organization, not to the classroom. See lib/data/assignment-fields.ts.
  const clash = await findSlugClash(classroom.githubId, slug)

  if (clash) {
    return { success: false, error: slugClashMessage(slug, clash, classroom.id), field: 'slug' }
  }

  // Last, because it is the only step that costs GitHub API calls: a
  // submission that repeats a title is rejected without spending any. Rails
  // ran every validation on every save and did not have that option.
  const starterCode = await resolveStarterCode(classroom.installationId, input.starterCodeRepo)
  if (starterCode.error) return { success: false, ...starterCode.error }

  try {
    // `build_assignment_invitation` + autosave: the original saves both records
    // in one transaction. It has to — an assignment without an invitation is
    // invalid, and it would still be holding the title and the slug.
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(assignments)
        .values({
          organizationId: classroom.id,
          creatorId: Number(session.user.id),
          title,
          slug,
          starterCodeRepoId: starterCode.repositoryId,
          autograderId: input.autograderId,
          publicRepo: input.publicRepo,
          invitationsEnabled: input.invitationsEnabled,
          studentsAreRepoAdmins: input.studentsAreRepoAdmins,
        })
        .returning({ id: assignments.id })

      await tx.insert(assignmentInvitations).values({
        assignmentId: row.id,
        key: invitationKey(),
        shortKey: invitationShortKey(),
      })
    })
  } catch (error) {
    // The checks above race: two teachers can submit the same name at once.
    // The unique indexes are the backstop, and losing the race is not an error
    // worth a stack trace.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: `Ya existe un trabajo práctico con ese nombre o prefijo en este classroom.`,
        field: 'title',
      }
    }

    throw error
  }

  return { success: true, slug }
}

/**
 * Port of AssignmentsController#update, which delegated to
 * `Assignment::Editor#perform`.
 *
 * The editor did three things: recreate the deadline, `update_attributes` and
 * then walk `previous_changes` handing each one to
 * `update_attribute_for_all_assignment_repos`. The first does not exist here —
 * this is the assignment-level deadline, not the checkpoint's own
 * `deadline_at`, which is edited through `lib/data/checkpoints.ts` instead —
 * and **the third is deliberately dropped**: its `case` had a
 * single `when "public_repo"`, which enqueued `AssignmentRepositoryVisibilityJob`
 * to flip every repository already created. There is no queue here, and doing
 * it inline is one GitHub call per student against a 60 s function ceiling —
 * so nothing propagates, the same stance the original already took for
 * `students_are_repo_admins`. See docs/edicion-y-borrado-de-assignments.md.
 *
 * The validations run in the same order as #create, GitHub last, for the same
 * reason: a submission that repeats a title costs no API calls.
 */
export async function updateAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  input: NewAssignmentInput,
): Promise<CreateAssignmentResult> {
  const title = input.title.trim()
  const slug = input.slug.trim()

  const classroom = await findTeachingClassroom(session, classroomSlug)

  if (!classroom) {
    return { success: false, error: 'No encontramos ese classroom.', field: 'base' }
  }

  // validate :organization_is_not_archived, which reads "you cannot create or
  // modify assignments in archived classrooms" — it covers this path too.
  if (classroom.archivedAt) {
    return {
      success: false,
      error: 'No se pueden modificar trabajos prácticos en un classroom archivado.',
      field: 'base',
    }
  }

  const [existing] = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
      ),
    )

  // `find_by!` raised; the screen answers 404 and this is its message
  if (!existing) {
    return { success: false, error: 'No encontramos ese trabajo práctico.', field: 'base' }
  }

  const invalid = validateTitleAndSlug(title, slug)
  if (invalid) return { success: false, ...invalid }

  // Both uniqueness checks exclude the row being saved. Rails got that from
  // `uniqueness`; here it is the explicit argument, and without it saving
  // without touching the prefix collides with itself.
  if (await isTitleTaken(classroom.id, title, existing.id)) {
    return {
      success: false,
      error: `Ya existe un trabajo práctico llamado "${title}" en este classroom.`,
      field: 'title',
    }
  }

  const clash = await findSlugClash(classroom.githubId, slug, {
    kind: 'individual',
    id: existing.id,
  })

  if (clash) {
    return { success: false, error: slugClashMessage(slug, clash, classroom.id), field: 'slug' }
  }

  const starterCode = await resolveStarterCode(classroom.installationId, input.starterCodeRepo)
  if (starterCode.error) return { success: false, ...starterCode.error }

  try {
    await db
      .update(assignments)
      .set({
        title,
        slug,
        starterCodeRepoId: starterCode.repositoryId,
        autograderId: input.autograderId,
        publicRepo: input.publicRepo,
        invitationsEnabled: input.invitationsEnabled,
        studentsAreRepoAdmins: input.studentsAreRepoAdmins,
      })
      .where(eq(assignments.id, existing.id))
  } catch (error) {
    // Same race as #create, and the same backstop
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: 'Ya existe un trabajo práctico con ese nombre o prefijo en este classroom.',
        field: 'title',
      }
    }

    throw error
  }

  return { success: true, slug }
}

/**
 * Port of AssignmentsController#destroy, minus its second half.
 *
 * The original set `deleted_at` and then enqueued `DestroyResourceJob`, which
 * called `resource.destroy`; `assignment_repos` is `dependent: :destroy`, and
 * each one carries a `before_destroy` —
 * `AssignmentRepoable#silently_destroy_github_repository`,
 * app/models/concerns/assignment_repoable.rb:10 — that deletes the repository
 * from GitHub. Its own modal said so: "this will also delete N participant
 * repository under the X organization".
 *
 * **Deliberate divergence: only the soft delete.** For a cátedra the repository
 * is the submission and the evidence of the grading, and one click taking a
 * hundred of them away is a worse failure than leaving repositories behind.
 * The partial unique indexes are already `where deleted_at is null`, so the
 * title and the prefix are freed by this alone, and every read the student
 * reaches — findInvitationRow, loadContext — inner-joins on the same condition,
 * so the invitation link answers 404 without any further work.
 */
export async function deleteAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<DeleteAssignmentResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No encontramos ese classroom.' }

  const deletedAt = new Date()

  const deleted = await db
    .update(assignments)
    .set({ deletedAt })
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
      ),
    )
    .returning({ id: assignments.id })

  if (deleted.length === 0) return { success: false, error: 'No encontramos ese trabajo práctico.' }

  // The invitation is meaningless without its assignment, and `default_scope`
  // hid it along with it. Soft-deleted too so the two rows read consistently.
  await db
    .update(assignmentInvitations)
    .set({ deletedAt })
    .where(
      and(
        eq(assignmentInvitations.assignmentId, deleted[0].id),
        isNull(assignmentInvitations.deletedAt),
      ),
    )

  return { success: true }
}

/**
 * `Assignment.where(title:, organization:)` — the title stays scoped to the
 * classroom. `exclude` is the assignment being edited, which must not find
 * itself.
 */
async function isTitleTaken(
  organizationId: number,
  title: string,
  exclude?: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.organizationId, organizationId),
        eq(assignments.title, title),
        isNull(assignments.deletedAt),
        exclude === undefined ? undefined : ne(assignments.id, exclude),
      ),
    )
    .limit(1)

  return rows.length > 0
}
