import 'server-only'

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { assignments, groupAssignments, organizations, organizationsUsers } from '@/db/schema'
import { isUniqueViolation } from '@/lib/data/postgres'
import { organizationSlug } from '@/lib/data/slug'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import {
  findOrganizationByInstallation,
  listUserOrganizations,
  setDefaultRepositoryPermissionToNone,
  type GitHubOrganization,
} from '@/lib/github/organizations'

/**
 * Classrooms data layer. DA-4: no query lives outside here, and every function
 * receives the session and filters by user.
 */

const TITLE_MAX_LENGTH = 255

/** Port of Organization::Creator::Result */
export type CreatorResult =
  | { success: true; slug: string }
  | { success: false; error: string }

/** A classroom with its org data resolved against GitHub (DA-2) */
export type ClassroomListItem = {
  id: number
  title: string
  slug: string
  archivedAt: Date | null
  /** null when the org is no longer reachable: installation removed, or access lost */
  organization: GitHubOrganization | null
}

/** One line of the assignment list a classroom card shows */
export type ClassroomCardAssignment = {
  key: string
  title: string
  slug: string
  /** Which of the two tables it came from: they have separate URLs and icons */
  group: boolean
}

/** A classroom as the index renders it: the card also lists its assignments */
export type ClassroomCard = ClassroomListItem & {
  assignments: ClassroomCardAssignment[]
}

/** `all_assignments.sort_by(&:created_at).reverse.take(5)` of the card partial */
const CARD_ASSIGNMENTS = 5

/**
 * Port of OrganizationsController#index, including the
 * `add_current_user_to_organizations` before_action: if the teacher is an
 * admin of an org that already has classrooms created by someone else, they
 * get associated automatically. That is what lets a teaching assistant who
 * was just made an admin see the classrooms without anyone inviting them.
 */
export async function listClassrooms(session: Session): Promise<ClassroomCard[]> {
  const githubOrganizations = await listUserOrganizations(session)
  const adminOrganizations = githubOrganizations.filter((organization) => organization.admin)

  if (adminOrganizations.length > 0) {
    await linkUserToExistingClassrooms(session, adminOrganizations)
  }

  const rows = await db
    .select({
      id: organizations.id,
      title: organizations.title,
      slug: organizations.slug,
      githubId: organizations.githubId,
      archivedAt: organizations.archivedAt,
    })
    .from(organizations)
    .innerJoin(organizationsUsers, eq(organizationsUsers.organizationId, organizations.id))
    .where(
      and(
        eq(organizationsUsers.userId, Number(session.user.id)),
        isNull(organizations.deletedAt), // default_scope { where(deleted_at: nil) }
      ),
    )
    .orderBy(desc(organizations.createdAt))

  const byGithubId = new Map(githubOrganizations.map((org) => [org.githubId, org]))
  const cardAssignments = await listCardAssignments(rows.map((row) => row.id))

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    archivedAt: row.archivedAt,
    organization: byGithubId.get(row.githubId) ?? null,
    assignments: cardAssignments.get(row.id) ?? [],
  }))
}

/**
 * The `organization.all_assignments` of _organization_card_layout.html.erb, for
 * every card at once.
 *
 * Two queries for the whole page instead of the original's `includes(:assignments,
 * :group_assignments)` — the same idea, and the id lists are small enough that
 * the trim to five happens here rather than in SQL.
 */
async function listCardAssignments(
  organizationIds: number[],
): Promise<Map<number, ClassroomCardAssignment[]>> {
  const byOrganization = new Map<number, (ClassroomCardAssignment & { createdAt: Date })[]>()
  if (organizationIds.length === 0) return byOrganization

  const [individual, group] = await Promise.all([
    db
      .select({
        id: assignments.id,
        organizationId: assignments.organizationId,
        title: assignments.title,
        slug: assignments.slug,
        createdAt: assignments.createdAt,
      })
      .from(assignments)
      .where(
        and(
          inArray(assignments.organizationId, organizationIds),
          isNull(assignments.deletedAt),
        ),
      ),
    db
      .select({
        id: groupAssignments.id,
        organizationId: groupAssignments.organizationId,
        title: groupAssignments.title,
        slug: groupAssignments.slug,
        createdAt: groupAssignments.createdAt,
      })
      .from(groupAssignments)
      .where(
        and(
          inArray(groupAssignments.organizationId, organizationIds),
          isNull(groupAssignments.deletedAt),
        ),
      ),
  ])

  for (const row of individual) {
    push(byOrganization, row.organizationId, { ...row, key: `individual-${row.id}`, group: false })
  }
  for (const row of group) {
    push(byOrganization, row.organizationId, { ...row, key: `group-${row.id}`, group: true })
  }

  return new Map(
    [...byOrganization].map(([organizationId, rows]) => [
      organizationId,
      rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, CARD_ASSIGNMENTS)
        .map(({ key, title, slug, group }) => ({ key, title, slug, group })),
    ]),
  )
}

function push<T>(target: Map<number, T[]>, key: number, value: T) {
  const existing = target.get(key)
  if (existing) existing.push(value)
  else target.set(key, [value])
}

async function linkUserToExistingClassrooms(session: Session, admin: GitHubOrganization[]) {
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        isNull(organizations.deletedAt),
        inArray(
          organizations.githubId,
          admin.map((organization) => organization.githubId),
        ),
      ),
    )

  if (existing.length === 0) return

  await db
    .insert(organizationsUsers)
    .values(
      existing.map((row) => ({
        organizationId: row.id,
        userId: Number(session.user.id),
      })),
    )
    .onConflictDoNothing()
}

/**
 * Port of Orgs::Controller#ensure_current_organization +
 * #ensure_current_organization_visible_to_current_user: look up by slug and
 * confirm the user is a teacher of that classroom. Returns null otherwise, so
 * the page answers 404 without leaking whether it exists.
 */
export async function findClassroom(
  session: Session,
  slug: string,
): Promise<ClassroomListItem | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      title: organizations.title,
      slug: organizations.slug,
      githubId: organizations.githubId,
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

  if (!row) return null

  // DA-2: the org data is read from GitHub, not the database. Resolving by
  // installation_id avoids walking every installation of the teacher just to
  // filter down to the one we already had.
  const organization =
    (await findOrganizationByInstallation(row.installationId, session.user.githubLogin)) ??
    (await reresolveInstallation(session, row.id, row.githubId))

  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    archivedAt: row.archivedAt,
    organization,
  }
}

/** The classroom row a teacher is allowed to act on, with nothing read from GitHub */
export type TeachingClassroom = {
  id: number
  /** The GitHub organization behind it. Several classrooms can share one */
  githubId: number
  installationId: number
  archivedAt: Date | null
}

/**
 * The same authorization boundary as `findClassroom`, without the round trip to
 * GitHub. Port of Orgs::Controller#ensure_current_organization_visible_to_current_user.
 *
 * The writers — creating an assignment, a team, a roster — need the id and
 * whether the classroom is archived, and none of them need the avatar or the
 * login, so paying for the org lookup on every one of them would be waste.
 */
export async function findTeachingClassroom(
  session: Session,
  slug: string,
): Promise<TeachingClassroom | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      githubId: organizations.githubId,
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

/**
 * Port of Organization::Editor#update_archive_setting, reached from the kebab
 * menu of the classroom card exactly as in the original.
 *
 * Archiving is a flag and nothing else: no repository, no invitation and no
 * membership is touched. What it buys is that every writer already refuses to
 * run on an archived classroom — creating assignments, accepting invitations,
 * building repositories — so a past term stops moving without being deleted.
 */
export async function setClassroomArchived(
  session: Session,
  slug: string,
  archived: boolean,
): Promise<{ success: true } | { success: false; error: string }> {
  const classroom = await findTeachingClassroom(session, slug)
  if (!classroom) return { success: false, error: 'No encontramos ese classroom.' }

  await db
    .update(organizations)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(organizations.id, classroom.id))

  return { success: true }
}

/**
 * Port of OrganizationWebhook#retrieve_org_hook_id!
 *
 * GitHub issues a **new** installation id every time the App is reinstalled,
 * so the stored one is a cache, not an authority — the same status the
 * original gave `organization_webhook.github_id`, which it declared
 * `allow_nil: true` and re-derived from the stable org id whenever it went
 * missing.
 *
 * `github_id` is the stable key here too, so a classroom is never permanently
 * unreachable: when the stored installation 404s, find the org among the ones
 * the teacher currently has and write the new id back.
 *
 * Returns null when the org really is gone — the App was uninstalled and not
 * put back, or the teacher lost access. That is the NullGitHubOrganization
 * case and the UI shows the classroom as unreachable.
 */
async function reresolveInstallation(
  session: Session,
  organizationId: number,
  githubId: number,
): Promise<GitHubOrganization | null> {
  const current = (await listUserOrganizations(session)).find(
    (candidate) => candidate.githubId === githubId,
  )

  if (!current) return null

  await db
    .update(organizations)
    .set({ installationId: current.installationId, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))

  return current
}

/**
 * Deliberate divergence: the original had no allowlist and could not have one
 * — it was GitHub's public service, where being an admin of the organization
 * was the whole authorization model (`Organization::Creator#ensure_users_are_authorized!`).
 * This is a single-course deployment on our own database, so the organization
 * must also be one we run. See AGENTS.md.
 *
 * Enforced in `createClassroom`, which is the only path that creates one; the
 * new-classroom screen uses `allowedOrganizations` so it never offers an
 * organization the teacher would only be refused on submit.
 */
function isAllowedOrganization(githubId: number): boolean {
  return env.allowedOrganizationIds.includes(githubId)
}

/** The organizations of `listUserOrganizations` that may host a classroom */
export function allowedOrganizations<T extends { githubId: number }>(organizations: T[]): T[] {
  return organizations.filter((organization) => isAllowedOrganization(organization.githubId))
}

/**
 * Port of Organization::Creator#perform.
 *
 * The original's order:
 *   1. ensure_users_are_authorized!  → the user must be an admin of the org
 *   2. create the row
 *   3. update_default_repository_permission_to_none!
 *   4. if anything fails, destroy_organization → it rolls back
 *
 * The original also created the organization webhook (step 1.5); here the App
 * installation replaces it, and it already exists by the time we get to this
 * point. And the title is chosen by the teacher instead of being generated as
 * `<org>-classroom-1`, because the new flow asks for it before creating.
 */
export async function createClassroom(
  session: Session,
  input: { githubId: number; installationId: number; title: string },
): Promise<CreatorResult> {
  const title = input.title.trim()

  // validates :title, presence: true, length: { maximum: 255 }
  if (title.length === 0) {
    return { success: false, error: 'El nombre del classroom no puede estar vacío.' }
  }
  if (title.length > TITLE_MAX_LENGTH) {
    return {
      success: false,
      error: `El nombre del classroom no puede superar los ${TITLE_MAX_LENGTH} caracteres.`,
    }
  }

  // ensure_users_are_authorized!
  //
  // Revalidated against GitHub instead of trusting the githubId/installationId
  // that arrived from the form: those are client input. First we confirm that
  // installation is one the user can see, and only then ask about the role.
  const organization = (await listUserOrganizations(session)).find(
    (candidate) =>
      candidate.githubId === input.githubId &&
      candidate.installationId === input.installationId,
  )

  if (!organization) {
    return {
      success: false,
      error: 'No encontramos esa organización. Puede que la App ya no esté instalada.',
    }
  }

  // `listUserOrganizations` already resolved the role via GitHubOrganization#admin?
  if (!organization.admin) {
    return {
      success: false,
      error: `@${session.user.githubLogin} no es admin de la organización @${organization.login}.`,
    }
  }

  // The allowlist, after the role check so an outsider learns nothing about
  // which organizations we run that they could not already see themselves.
  if (!isAllowedOrganization(organization.githubId)) {
    return {
      success: false,
      error:
        `La organización @${organization.login} no está habilitada para crear classrooms. ` +
        'Si es de la cátedra, pedile a quien administra el deploy que la agregue.',
    }
  }

  const slug = organizationSlug(organization.githubId, title)

  // Rails resolved both of these with a validation query before hitting the
  // constraint, which is what makes the message specific. Checking here does
  // the same, and it matters: when the title repeats, the slug repeats too,
  // and Postgres reports whichever index it happens to check first.
  const clash = await findClash(organization.githubId, title, slug)

  // validates :title, uniqueness: { scope: :github_id }
  if (clash === 'title') {
    return {
      success: false,
      error: `Ya existe un classroom llamado "${title}" en @${organization.login}.`,
    }
  }

  // validates :slug, uniqueness: true. Two different titles can parameterize
  // to the same slug ("Algo 2026" and "Algo/2026"), so this case is not a
  // repeated title and saying so would be confusing.
  if (clash === 'slug') {
    return {
      success: false,
      error:
        `El nombre "${title}" genera la misma URL que otro classroom de @${organization.login} ` +
        `(/classrooms/${slug}). Cambiá alguna palabra para diferenciarlos.`,
    }
  }

  let created: { id: number; slug: string }
  try {
    // The row and its teacher go in together or not at all: a classroom with
    // no rows in organizations_users is invisible to everyone, yet still holds
    // the title and the slug, leaving the teacher unable to recreate it.
    created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(organizations)
        .values({
          githubId: organization.githubId,
          installationId: organization.installationId,
          title,
          slug,
        })
        .returning({ id: organizations.id, slug: organizations.slug })

      await tx.insert(organizationsUsers).values({
        organizationId: row.id,
        userId: Number(session.user.id),
      })

      return row
    })
  } catch (error) {
    // The checks above race: two teachers can submit the same name at once.
    // The unique indexes are the backstop, and losing the race is not an
    // error worth a stack trace.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: `Ya existe un classroom llamado "${title}" en @${organization.login}.`,
      }
    }

    throw error
  }

  try {
    await setDefaultRepositoryPermissionToNone(organization.installationId, organization.login)
  } catch (error) {
    // destroy_organization(organization) — the original rolls back and fails
    await db.delete(organizations).where(eq(organizations.id, created.id))
    return {
      success: false,
      error:
        'No pudimos poner el permiso de repositorio por defecto en "none" para la organización. ' +
        'Verificá que la App tenga el permiso Organization → Administration: write. ' +
        `Detalle: ${errorMessage(error)}`,
    }
  }

  return { success: true, slug: created.slug }
}

/** Which uniqueness validation a pending insert would break, if any */
async function findClash(
  githubId: number,
  title: string,
  slug: string,
): Promise<'title' | 'slug' | null> {
  const rows = await db
    .select({ title: organizations.title, slug: organizations.slug })
    .from(organizations)
    .where(
      and(
        isNull(organizations.deletedAt),
        or(
          and(eq(organizations.githubId, githubId), eq(organizations.title, title)),
          eq(organizations.slug, slug),
        ),
      ),
    )

  if (rows.length === 0) return null
  return rows.some((row) => row.title === title) ? 'title' : 'slug'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
