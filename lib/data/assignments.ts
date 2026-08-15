import 'server-only'

import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { assignmentInvitations, assignments, groupAssignments } from '@/db/schema'
import {
  findSlugClash,
  invitationKey,
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

export type AssignmentListItem = {
  id: number
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  /** The key of the invitation URL. AssignmentInvitation#to_param */
  invitationKey: string
  /** Assignment#starter_code? is `starterCodeRepoId !== null` */
  starterCodeRepoId: number | null
}

export type NewAssignmentInput = {
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  /** `owner/name` of the template repo, or empty for no starter code */
  starterCodeRepo: string
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
      starterCodeRepoId: assignments.starterCodeRepoId,
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
      starterCodeRepoId: assignments.starterCodeRepoId,
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
 * Steps 1 to 3 carry over as they are; step 4 does not exist here (no
 * deadlines, see db/schema.ts).
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
      error: 'No se pueden crear assignments en un classroom archivado.',
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
      error: `Ya existe un assignment llamado "${title}" en este classroom.`,
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
          publicRepo: input.publicRepo,
          invitationsEnabled: input.invitationsEnabled,
          studentsAreRepoAdmins: input.studentsAreRepoAdmins,
        })
        .returning({ id: assignments.id })

      await tx.insert(assignmentInvitations).values({
        assignmentId: row.id,
        key: invitationKey(),
      })
    })
  } catch (error) {
    // The checks above race: two teachers can submit the same name at once.
    // The unique indexes are the backstop, and losing the race is not an error
    // worth a stack trace.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: `Ya existe un assignment con ese nombre o prefijo en este classroom.`,
        field: 'title',
      }
    }

    throw error
  }

  return { success: true, slug }
}

/** `Assignment.where(title:, organization:)` — the title stays scoped to the classroom */
async function isTitleTaken(organizationId: number, title: string): Promise<boolean> {
  const rows = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.organizationId, organizationId),
        eq(assignments.title, title),
        isNull(assignments.deletedAt),
      ),
    )
    .limit(1)

  return rows.length > 0
}
