import 'server-only'

import { randomBytes } from 'node:crypto'

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentInvitations,
  assignments,
  organizations,
  organizationsUsers,
} from '@/db/schema'
import { isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'
import {
  findRepositoryByFullName,
  isRepositoryEmpty,
  REPOSITORY_FULL_NAME,
} from '@/lib/github/repositories'

/**
 * Individual assignments data layer. DA-4: no query lives outside here, and
 * every function receives the session and filters by user — the join against
 * `organizations_users` is the authorization boundary, there is no RLS.
 *
 * Port of AssignmentsController#new/#create and the Assignment model.
 * Group assignments are not ported: they need groupings and GitHub teams.
 */

// validates :title, length: { maximum: 60 } / validates :slug, length: { maximum: 60 }
const TITLE_MAX_LENGTH = 60
const SLUG_MAX_LENGTH = 60

// validates :slug, format: { with: /\A[-a-zA-Z0-9_]*\z/ }
const SLUG_FORMAT = /^[-a-zA-Z0-9_]+$/

/**
 * GitHubClassroom::Blacklist::NAMES, from config/initializers/03_blacklist.rb.
 * They are reserved because they collide with the routes that hang off the
 * assignment path: `/classrooms/:slug/assignments/new` would be shadowed by an
 * assignment whose slug is "new".
 */
const RESERVED_NAMES = ['new', 'edit']

/** Which field the message belongs to, so the form can mark the input */
export type AssignmentField = 'title' | 'slug' | 'starterCode' | 'base'

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
  const classroom = await findClassroomRow(session, classroomSlug)
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
 */
export async function countAssignments(session: Session, classroomSlug: string): Promise<number> {
  const classroom = await findClassroomRow(session, classroomSlug)
  if (!classroom) return 0

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(eq(assignments.organizationId, classroom.id), isNull(assignments.deletedAt)))

  return row.count
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
  const classroom = await findClassroomRow(session, classroomSlug)
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

  const classroom = await findClassroomRow(session, classroomSlug)

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

  const invalid = validate(title, slug)
  if (invalid) return invalid

  // Rails resolved uniqueness with a query before hitting the constraint,
  // which is what makes the message specific. Both indexes cover the same row,
  // so without this Postgres reports whichever it happens to check first.
  const clash = await findClash(classroom.id, title, slug)

  if (clash === 'title') {
    return {
      success: false,
      error: `Ya existe un assignment llamado "${title}" en este classroom.`,
      field: 'title',
    }
  }

  if (clash === 'slug') {
    return {
      success: false,
      error: `Ya existe un assignment con el prefijo "${slug}" en este classroom.`,
      field: 'slug',
    }
  }

  // Last, because it is the only step that costs GitHub API calls: a
  // submission that repeats a title is rejected without spending any. Rails
  // ran every validation on every save and did not have that option.
  const starterCode = await resolveStarterCode(classroom.installationId, input.starterCodeRepo)
  if (starterCode.error) return starterCode.error

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

/**
 * Port of the StarterCode controller concern plus the two validations of
 * StarterCodeImportable, which the original ran in different places.
 *
 * The original had a second path: the autocomplete posted a `repo_id` next to
 * the typed name, and `validate_starter_code_repository_id` trusted it after a
 * cheap existence check. There is no autocomplete here, so everything comes in
 * as `owner/name` and is resolved to an id the same way
 * `starter_code_repository_id` did.
 */
async function resolveStarterCode(
  installationId: number,
  input: string,
): Promise<{ repositoryId: number | null; error?: CreateAssignmentResult }> {
  const fullName = input.trim()

  // Starter code is optional, exactly as in the original
  if (fullName.length === 0) return { repositoryId: null }

  const invalid = (error: string) => ({
    repositoryId: null,
    error: { success: false as const, error, field: 'starterCode' as const },
  })

  // StarterCode::WRONG_FORMAT
  if (!REPOSITORY_FULL_NAME.test(fullName)) {
    return invalid('Usá el formato owner/nombre, por ejemplo fiubaTA050-labs/raft-starter.')
  }

  const repository = await findRepositoryByFullName(installationId, fullName)

  // StarterCode::INVALID_SELECTION. GitHub answers 404 both when the repo does
  // not exist and when it exists but the App cannot see it, and it does that on
  // purpose — so the message has to offer both readings. Measured: the
  // installation token reaches any repo in an org where the App is installed,
  // and any public repo anywhere; a private repo elsewhere is the blind spot.
  if (!repository) {
    return invalid(
      `No encontramos "${fullName}". Si es privado y está en otra organización, instalá ahí ` +
        'la App de FIUBA Classroom o hacé público el repositorio.',
    )
  }

  // validate :starter_code_repository_is_template. The original only enforced
  // this when template_repos_enabled; with the source importer gone it is the
  // only way to copy starter code, so it always applies.
  if (!repository.isTemplate) {
    return invalid(
      `"${repository.fullName}" no es un template repository. Activá "Template repository" ` +
        'en Settings del repo para poder clonarlo a cada alumno.',
    )
  }

  // validate :starter_code_repository_not_empty
  if (await isRepositoryEmpty(installationId, repository.fullName)) {
    return invalid(
      `"${repository.fullName}" está vacío. Elegí un repo con contenido, o dejá el campo ` +
        'en blanco para crear el assignment sin starter code.',
    )
  }

  return { repositoryId: repository.id }
}

/** AssignmentInvitation#assign_key: `SecureRandom.hex(16)` */
function invitationKey(): string {
  return randomBytes(16).toString('hex')
}

/** The Assignment model's validations on title and slug, in the original's order */
function validate(title: string, slug: string): CreateAssignmentResult | null {
  // validates :title, presence: true
  if (title.length === 0) {
    return { success: false, error: 'El título no puede estar vacío.', field: 'title' }
  }

  if (title.length > TITLE_MAX_LENGTH) {
    return {
      success: false,
      error: `El título no puede superar los ${TITLE_MAX_LENGTH} caracteres.`,
      field: 'title',
    }
  }

  // validates_not_reserved_word :title
  if (RESERVED_NAMES.includes(title.toLowerCase())) {
    return { success: false, error: `"${title}" es una palabra reservada.`, field: 'title' }
  }

  // validates :slug, presence: true
  if (slug.length === 0) {
    return { success: false, error: 'El prefijo no puede estar vacío.', field: 'slug' }
  }

  if (slug.length > SLUG_MAX_LENGTH) {
    return {
      success: false,
      error: `El prefijo no puede superar los ${SLUG_MAX_LENGTH} caracteres.`,
      field: 'slug',
    }
  }

  if (!SLUG_FORMAT.test(slug)) {
    return {
      success: false,
      error: 'El prefijo sólo puede tener letras, números, guiones y guiones bajos.',
      field: 'slug',
    }
  }

  // Divergence: the original only ran validates_not_reserved_word on the
  // title, even though `to_param` returns the slug and the slug is what ends
  // up in the URL. A title of "Trabajo Práctico" with the slug hand-edited to
  // "new" would have shadowed the new-assignment route. Checking both closes
  // that; the JS-derived slug means the title check almost always fires first.
  if (RESERVED_NAMES.includes(slug.toLowerCase())) {
    return { success: false, error: `"${slug}" es una palabra reservada.`, field: 'slug' }
  }

  return null
}

/** Which uniqueness validation a pending insert would break, if any */
async function findClash(
  organizationId: number,
  title: string,
  slug: string,
): Promise<'title' | 'slug' | null> {
  const rows = await db
    .select({ title: assignments.title, slug: assignments.slug })
    .from(assignments)
    .where(
      and(
        eq(assignments.organizationId, organizationId),
        isNull(assignments.deletedAt),
        or(eq(assignments.title, title), eq(assignments.slug, slug)),
      ),
    )

  if (rows.length === 0) return null
  return rows.some((row) => row.title === title) ? 'title' : 'slug'
}

/**
 * The classroom row, filtered by teacher. Port of
 * Orgs::Controller#ensure_current_organization_visible_to_current_user.
 *
 * Deliberately not `findClassroom` from lib/data/organizations: that one also
 * resolves the org against GitHub, and none of the functions here need the
 * avatar or the login — only the id and whether it is archived.
 */
async function findClassroomRow(
  session: Session,
  slug: string,
): Promise<{ id: number; installationId: number; archivedAt: Date | null } | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      installationId: organizations.installationId,
      archivedAt: organizations.archivedAt,
    })
    .from(organizations)
    .innerJoin(organizationsUsers, eq(organizationsUsers.organizationId, organizations.id))
    .where(
      and(
        eq(organizations.slug, slug),
        eq(organizationsUsers.userId, Number(session.user.id)),
        isNull(organizations.deletedAt),
      ),
    )

  return row ?? null
}
