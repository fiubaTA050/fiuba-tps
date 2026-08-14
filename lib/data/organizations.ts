import 'server-only'

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { organizations, organizationsUsers } from '@/db/schema'
import { organizationSlug } from '@/lib/data/slug'
import { db } from '@/lib/db'
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

/**
 * Port of OrganizationsController#index, including the
 * `add_current_user_to_organizations` before_action: if the teacher is an
 * admin of an org that already has classrooms created by someone else, they
 * get associated automatically. That is what lets a teaching assistant who
 * was just made an admin see the classrooms without anyone inviting them.
 */
export async function listClassrooms(session: Session): Promise<ClassroomListItem[]> {
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

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    archivedAt: row.archivedAt,
    organization: byGithubId.get(row.githubId) ?? null,
  }))
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

  // DA-2: the org data is read from GitHub, not the database. It resolves by
  // installation_id instead of walking every installation of the teacher just
  // to filter down to the one we already had.
  const organization = await findOrganizationByInstallation(
    row.installationId,
    session.user.githubLogin,
  )

  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    archivedAt: row.archivedAt,
    organization,
  }
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

/**
 * Postgres unique violation. Drizzle wraps driver errors, and the drivers
 * disagree on the field name — postgres.js uses `constraint_name`, pglite and
 * node-postgres use `constraint` — so walk the cause chain and accept either.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (typeof current !== 'object') return false
    if ((current as { code?: string }).code === '23505') return true
  }
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
