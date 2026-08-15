import 'server-only'

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  inviteStatuses,
  organizations,
  users,
} from '@/db/schema'
import { isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'
import { findInstallationAccount } from '@/lib/github/organizations'
import {
  acceptRepositoryInvitation,
  addCollaborator,
  createRepository,
  createRepositoryFromTemplate,
  deleteRepository,
  findRepositoryById,
  repositoryExists,
  secondaryRateLimitDelay,
  type GitHubRepository,
} from '@/lib/github/repositories'

/**
 * Port of CreateGitHubRepoService, for individual assignments.
 *
 * The original ran this in a Sidekiq job that the student's browser kicked off
 * with `POST create_repo`. Here it runs inside that same request — see
 * docs/creacion-de-repos.md for the measurements and for the condition that
 * would move it back out of the request.
 *
 * The split the doc asks for is real and load-bearing:
 *
 *  - `createStudentRepository` needs only the installation token. A request or
 *    a worker can call it; it does not know what a session is.
 *  - `claimPendingInvitation` needs only the student's token, and is idempotent.
 *
 * Group assignments are not ported, so there is no `Exercise` hierarchy here —
 * this is `IndividualExercise` inlined.
 */

export type CreateRepositoryResult =
  /** The repository exists and the student can reach it */
  | { status: 'completed'; repoUrl: string }
  /** Somebody else already holds the lock: another tab, an impatient retry */
  | { status: 'working' }
  /** GitHub's secondary rate limit. Not an error — come back in N seconds */
  | { status: 'retry'; retryAfter: number }
  | { status: 'errored'; error: string }
  /** They never accepted, so there is nothing to build */
  | { status: 'unaccepted' }

/**
 * Port of AssignmentInvitationsController#create_repo plus
 * CreateGitHubRepoService#perform.
 *
 * The original took the lock in two steps — the controller set `waiting!`, the
 * job then checked `waiting?` — leaving a window between them. One conditional
 * UPDATE closes it: whoever moves the row out of `accepted` owns the work, and
 * everyone else gets `working` and keeps polling.
 */
export async function createStudentRepository(
  session: Session,
  key: string,
): Promise<CreateRepositoryResult> {
  const context = await loadContext(session, key)
  if (!context) return { status: 'errored', error: 'No encontramos esa invitación.' }

  // `redeem_for` answering :success — the repo is already there. Checked before
  // the lock so a reload after completion is a plain read.
  const existing = await findExistingRepository(context)
  if (existing) return { status: 'completed', repoUrl: existing.htmlUrl }

  // AssignmentInvitation#enabled?, revalidated here: the teacher may have
  // turned invitations off between accepting and this request.
  if (!context.invitationsEnabled || context.archivedAt) {
    return { status: 'errored', error: 'Las invitaciones para este assignment están cerradas.' }
  }

  // The lock. `create_repo` in the original starts from `accepted` or one of
  // the errored states — the latter is what makes the retry button work.
  const [locked] = await db
    .update(inviteStatuses)
    .set({ status: 'creating_repo', updatedAt: new Date() })
    .where(
      and(
        eq(inviteStatuses.id, context.inviteStatusId),
        inArray(inviteStatuses.status, ['accepted', 'errored_creating_repo']),
      ),
    )
    .returning({ id: inviteStatuses.id })

  if (!locked) {
    // Either somebody is mid-flight, or they never accepted at all
    return context.status === 'unaccepted' ? { status: 'unaccepted' } : { status: 'working' }
  }

  let repository: GitHubRepository | null = null

  try {
    repository = await createOnGitHub(context)

    await db.insert(assignmentRepos).values({
      assignmentId: context.assignmentId,
      userId: context.userId,
      githubRepoId: repository.id,
    })

    // add_collaborator_to_github_repository! — invite, then accept it for them
    const invitationId = await addCollaborator(
      context.installationId,
      repository.fullName,
      context.githubLogin,
      context.studentsAreRepoAdmins ? 'admin' : 'push',
    )

    if (invitationId !== null) await acceptRepositoryInvitation(session, invitationId)

    // `use_importer?` is false on the template path, so the original completes
    // right here without waiting for the content to land. Measured: the repo
    // has commits ~3 s later, and nothing needs to watch that.
    await setStatus(context.inviteStatusId, 'completed')

    return { status: 'completed', repoUrl: repository.htmlUrl }
  } catch (error) {
    // Not a failure: the cohort arrived at once and GitHub asked us to wait.
    // Give the lock back so the student's own polling retries.
    const retryAfter = secondaryRateLimitDelay(error)
    if (retryAfter !== null) {
      await rollback(context, repository)
      await setStatus(context.inviteStatusId, 'accepted')
      return { status: 'retry', retryAfter }
    }

    // Two tabs raced past the lock into the same insert. Somebody else built
    // it; that is a success, not an error.
    if (isUniqueViolation(error)) {
      await rollback(context, repository)
      const built = await findExistingRepository(context)
      if (built) {
        await setStatus(context.inviteStatusId, 'completed')
        return { status: 'completed', repoUrl: built.htmlUrl }
      }
    }

    // The `rescue Result::Error` of the original: delete the half-built repo so
    // it does not survive to confuse anyone, and let the retry button show.
    await rollback(context, repository)
    await setStatus(context.inviteStatusId, 'errored_creating_repo')

    return { status: 'errored', error: errorMessage(error) }
  }
}

/**
 * The student's half of `add_user_to_github_repository!`, on its own.
 *
 * Runs whenever the student passes through the setup screen: if the repository
 * exists but they never accepted the collaborator invitation — the request that
 * created it died right after the invite, or a worker created it with no
 * session at hand — this picks it up with their token. Idempotent and cheap
 * when there is nothing pending.
 */
export async function claimPendingInvitation(session: Session, key: string): Promise<void> {
  const context = await loadContext(session, key)
  if (!context) return

  const repository = await findExistingRepository(context)
  if (!repository) return

  const invitationId = await addCollaborator(
    context.installationId,
    repository.fullName,
    context.githubLogin,
    context.studentsAreRepoAdmins ? 'admin' : 'push',
  )

  if (invitationId !== null) await acceptRepositoryInvitation(session, invitationId)
}

/** The student's repository for this assignment, resolved against GitHub (DA-2) */
export async function findStudentRepository(
  session: Session,
  key: string,
): Promise<GitHubRepository | null> {
  const context = await loadContext(session, key)
  return context ? findExistingRepository(context) : null
}

type Context = Awaited<ReturnType<typeof loadContext>>

/** Everything the creation needs, in one query plus the org lookup */
async function loadContext(session: Session, key: string) {
  const userId = Number(session.user.id)

  const [row] = await db
    .select({
      assignmentId: assignments.id,
      assignmentSlug: assignments.slug,
      assignmentTitle: assignments.title,
      publicRepo: assignments.publicRepo,
      studentsAreRepoAdmins: assignments.studentsAreRepoAdmins,
      starterCodeRepoId: assignments.starterCodeRepoId,
      invitationsEnabled: assignments.invitationsEnabled,
      installationId: organizations.installationId,
      archivedAt: organizations.archivedAt,
      inviteStatusId: inviteStatuses.id,
      status: inviteStatuses.status,
      githubLogin: users.githubLogin,
    })
    .from(assignmentInvitations)
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentInvitations.assignmentId), isNull(assignments.deletedAt)),
    )
    .innerJoin(
      organizations,
      and(eq(organizations.id, assignments.organizationId), isNull(organizations.deletedAt)),
    )
    // Inner: with no status row the student never accepted, and there is
    // nothing here for them. The route answers `unaccepted`.
    .innerJoin(
      inviteStatuses,
      and(
        eq(inviteStatuses.assignmentInvitationId, assignmentInvitations.id),
        eq(inviteStatuses.userId, userId),
      ),
    )
    .innerJoin(users, eq(users.id, userId))
    .where(and(eq(assignmentInvitations.key, key), isNull(assignmentInvitations.deletedAt)))

  if (!row?.githubLogin) return null

  const organization = await findInstallationAccount(row.installationId)
  if (!organization) return null

  return { ...row, githubLogin: row.githubLogin, userId, orgLogin: organization.login }
}

async function findExistingRepository(context: NonNullable<Context>) {
  const [row] = await db
    .select({ githubRepoId: assignmentRepos.githubRepoId })
    .from(assignmentRepos)
    .where(
      and(
        eq(assignmentRepos.assignmentId, context.assignmentId),
        eq(assignmentRepos.userId, context.userId),
      ),
    )

  if (!row) return null

  // Null when the repo was deleted on GitHub — the NullGitHubRepository case.
  // The row stays: deciding what to do about an orphan belongs to the teacher.
  return findRepositoryById(context.installationId, row.githubRepoId)
}

async function createOnGitHub(context: NonNullable<Context>): Promise<GitHubRepository> {
  const name = await availableRepoName(context)

  const options = {
    owner: context.orgLogin,
    name,
    // `visibility=` in the original: public_repo = visibility != "private"
    private: !context.publicRepo,
    description: `${name} creado por FIUBA Classroom`,
  }

  // `use_template_repos?`, which in this port is just `starter_code?`
  if (context.starterCodeRepoId === null) {
    return createRepository(context.installationId, options)
  }

  const template = await findRepositoryById(context.installationId, context.starterCodeRepoId)

  if (!template) {
    // CreateGitHubRepoService::Errors template_repository_not_found
    throw new Error(
      'El starter code del assignment ya no está disponible. Avisale al docente.',
    )
  }

  const [templateOwner, templateName] = template.fullName.split('/')

  return createRepositoryFromTemplate(context.installationId, {
    ...options,
    template: { owner: templateOwner, name: templateName },
  })
}

/**
 * Port of Exercise#generate_repo_name and #suffixed_repo_name: `<slug>-<login>`,
 * and if that is taken, the same truncated to 100 characters with `-1`, `-2`.
 *
 * The original looped without a bound. Ten is plenty — past that something is
 * wrong that another request will not fix, and an unbounded loop inside a
 * request is a way to spend the whole function budget on 404s.
 */
async function availableRepoName(context: NonNullable<Context>): Promise<string> {
  const base = `${context.assignmentSlug}-${context.githubLogin}`

  for (let suffixCount = 0; suffixCount < 10; suffixCount += 1) {
    const suffix = suffixCount === 0 ? '' : `-${suffixCount}`
    const name = base.slice(0, 100 - suffix.length) + suffix

    if (!(await repositoryExists(context.installationId, `${context.orgLogin}/${name}`))) {
      return name
    }
  }

  throw new Error(`Ya existen demasiados repositorios llamados "${base}".`)
}

/** Undo whatever got as far as GitHub, so a retry starts from nothing */
async function rollback(context: NonNullable<Context>, repository: GitHubRepository | null) {
  if (!repository) return

  await db.delete(assignmentRepos).where(eq(assignmentRepos.githubRepoId, repository.id))
  await deleteRepository(context.installationId, repository.fullName)
}

async function setStatus(
  inviteStatusId: number,
  status: 'accepted' | 'completed' | 'errored_creating_repo',
) {
  await db
    .update(inviteStatuses)
    .set({ status, updatedAt: new Date() })
    .where(eq(inviteStatuses.id, inviteStatusId))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'No pudimos crear tu repositorio. Probá de nuevo en un momento.'
}
