import 'server-only'

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  groupAssignmentInvitations,
  groupAssignmentRepos,
  groupAssignments,
  groupInviteStatuses,
  groups,
  groupsUsers,
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
 * The two kinds of assignment live side by side rather than behind an
 * `Exercise` hierarchy: what they actually share is the plan for the
 * repository — `RepositoryPlan`, `createOnGitHub`, `availableRepoName` — and
 * the pair of GitHub calls that grant a collaborator access. Everything else
 * differs in which table holds the lock and which row records the repository,
 * which is where the original's polymorphism ends up leaking anyway.
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
  //
  // The third case is the one the original does not have, and `fiubaTA050-labs`
  // shows what its absence costs: 92 repositories for 49 students, one of them
  // with seven, most of them with no student access. A request that dies
  // mid-flight — a function timeout, a deploy, a crash — never reaches the
  // rescue, so nothing moves the status off `creating_repo`. The lock is then
  // held by a request that no longer exists: the student watches "Creando el
  // repositorio" forever and no retry can take over, because the retry button
  // only shows on the errored states.
  //
  // So the lock expires. Anything older than this was abandoned, since the
  // whole thing is measured at ~3 s and the route's ceiling is 60.
  const staleLock = sql`${inviteStatuses.status} = 'creating_repo' and ${inviteStatuses.updatedAt} < now() - interval '5 minutes'`

  const [locked] = await db
    .update(inviteStatuses)
    .set({ status: 'creating_repo', updatedAt: new Date() })
    .where(
      and(
        eq(inviteStatuses.id, context.inviteStatusId),
        or(inArray(inviteStatuses.status, ['accepted', 'errored_creating_repo']), staleLock),
      ),
    )
    .returning({ id: inviteStatuses.id })

  if (!locked) {
    // Either somebody is mid-flight, or they never accepted at all
    return context.status === 'unaccepted' ? { status: 'unaccepted' } : { status: 'working' }
  }

  let repository: GitHubRepository | null = null

  try {
    repository = await createOnGitHub({
      installationId: context.installationId,
      orgLogin: context.orgLogin,
      baseName: `${context.assignmentSlug}-${context.githubLogin}`,
      publicRepo: context.publicRepo,
      starterCodeRepoId: context.starterCodeRepoId,
    })

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

/**
 * Everything creating a repository needs, with nothing about who it is for.
 *
 * This is the port's `CreateGitHubRepoService::Exercise`: the original's
 * service is written against `exercise.repo_name`, `assignment.private?` and
 * `organization_login`, and its two subclasses differ only in where the last
 * part of the name comes from — `github_user.login` for a student,
 * `github_team.slug_no_cache` for a team.
 */
type RepositoryPlan = {
  installationId: number
  orgLogin: string
  /** `<assignment-slug>-<login>` or `<assignment-slug>-<team-slug>`, before any suffix */
  baseName: string
  publicRepo: boolean
  starterCodeRepoId: number | null
}

async function createOnGitHub(plan: RepositoryPlan): Promise<GitHubRepository> {
  const name = await availableRepoName(plan)

  const options = {
    owner: plan.orgLogin,
    name,
    // `visibility=` in the original: public_repo = visibility != "private"
    private: !plan.publicRepo,
    description: `${name} creado por FIUBA Classroom`,
  }

  // `use_template_repos?`, which in this port is just `starter_code?`
  if (plan.starterCodeRepoId === null) {
    return createRepository(plan.installationId, options)
  }

  const template = await findRepositoryById(plan.installationId, plan.starterCodeRepoId)

  if (!template) {
    // CreateGitHubRepoService::Errors template_repository_not_found
    throw new Error(
      'El starter code del assignment ya no está disponible. Avisale al docente.',
    )
  }

  const [templateOwner, templateName] = template.fullName.split('/')

  return createRepositoryFromTemplate(plan.installationId, {
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
async function availableRepoName(plan: RepositoryPlan): Promise<string> {
  for (let suffixCount = 0; suffixCount < 10; suffixCount += 1) {
    const suffix = suffixCount === 0 ? '' : `-${suffixCount}`
    const name = plan.baseName.slice(0, 100 - suffix.length) + suffix

    if (!(await repositoryExists(plan.installationId, `${plan.orgLogin}/${name}`))) {
      return name
    }
  }

  throw new Error(`Ya existen demasiados repositorios llamados "${plan.baseName}".`)
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

/**
 * The same thing for a team. Port of the GroupExercise branch of
 * CreateGitHubRepoService.
 *
 * Two things differ from the individual flow, and only two:
 *
 *  - the repository is named after the team, `<slug>-<team-slug>`, and the row
 *    that records it hangs off the team, so the whole team shares one
 *    repository and one `group_invite_statuses` row;
 *  - access is granted **per member, by that member's own request**. The
 *    original adds the GitHub team to the repository once and every member
 *    inherits it; with outside collaborators there is no such handle, and
 *    inviting somebody who is not making the request would leave them a
 *    pending invitation in their email — the exact thing
 *    docs/creacion-de-repos.md keeps this flow in the browser to avoid. So
 *    whoever gets here grants themselves access, and the teammates who arrive
 *    later grant themselves theirs through `claimPendingTeamInvitation`, which
 *    their own setup screen calls.
 */
export async function createTeamRepository(
  session: Session,
  key: string,
): Promise<CreateRepositoryResult> {
  const context = await loadTeamContext(session, key)
  if (!context) return { status: 'errored', error: 'No encontramos esa invitación.' }

  const existing = await findExistingTeamRepository(context)

  if (existing) {
    // Already built by a teammate: this member still needs their own access
    await grantAccess(session, context, existing.fullName)
    return { status: 'completed', repoUrl: existing.htmlUrl }
  }

  if (!context.invitationsEnabled || context.archivedAt) {
    return { status: 'errored', error: 'Las invitaciones para este assignment están cerradas.' }
  }

  // The same lock as the individual flow, including the expiry that a request
  // dying mid-flight would otherwise leave held forever
  const staleLock = sql`${groupInviteStatuses.status} = 'creating_repo' and ${groupInviteStatuses.updatedAt} < now() - interval '5 minutes'`

  const [locked] = await db
    .update(groupInviteStatuses)
    .set({ status: 'creating_repo', updatedAt: new Date() })
    .where(
      and(
        eq(groupInviteStatuses.id, context.statusId),
        or(
          inArray(groupInviteStatuses.status, ['accepted', 'errored_creating_repo']),
          staleLock,
        ),
      ),
    )
    .returning({ id: groupInviteStatuses.id })

  if (!locked) {
    // A teammate is mid-flight — or nobody on this team ever accepted
    return context.status === 'unaccepted' ? { status: 'unaccepted' } : { status: 'working' }
  }

  let repository: GitHubRepository | null = null

  try {
    repository = await createOnGitHub({
      installationId: context.installationId,
      orgLogin: context.orgLogin,
      baseName: `${context.assignmentSlug}-${context.teamSlug}`,
      publicRepo: context.publicRepo,
      starterCodeRepoId: context.starterCodeRepoId,
    })

    await db.insert(groupAssignmentRepos).values({
      groupAssignmentId: context.assignmentId,
      groupId: context.teamId,
      githubRepoId: repository.id,
    })

    await grantAccess(session, context, repository.fullName)

    await setTeamStatus(context.statusId, 'completed')

    return { status: 'completed', repoUrl: repository.htmlUrl }
  } catch (error) {
    const retryAfter = secondaryRateLimitDelay(error)
    if (retryAfter !== null) {
      await rollbackTeam(context, repository)
      await setTeamStatus(context.statusId, 'accepted')
      return { status: 'retry', retryAfter }
    }

    // Two teammates raced past the lock into the same insert. Whoever won built
    // the team's repository, which is a success for both of them.
    if (isUniqueViolation(error)) {
      await rollbackTeam(context, repository)
      const built = await findExistingTeamRepository(context)
      if (built) {
        await grantAccess(session, context, built.fullName)
        await setTeamStatus(context.statusId, 'completed')
        return { status: 'completed', repoUrl: built.htmlUrl }
      }
    }

    await rollbackTeam(context, repository)
    await setTeamStatus(context.statusId, 'errored_creating_repo')

    return { status: 'errored', error: errorMessage(error) }
  }
}

/**
 * One member's own access to their team's repository, on its own.
 *
 * This is what every member except the one who created the repository goes
 * through, and it is idempotent: `addCollaborator` answers 204 with no
 * invitation for somebody who already has access.
 */
export async function claimPendingTeamInvitation(session: Session, key: string): Promise<void> {
  const context = await loadTeamContext(session, key)
  if (!context) return

  const repository = await findExistingTeamRepository(context)
  if (!repository) return

  await grantAccess(session, context, repository.fullName)
}

/** The team's repository for this assignment, resolved against GitHub (DA-2) */
export async function findTeamRepository(
  session: Session,
  key: string,
): Promise<GitHubRepository | null> {
  const context = await loadTeamContext(session, key)
  return context ? findExistingTeamRepository(context) : null
}

type TeamContext = NonNullable<Awaited<ReturnType<typeof loadTeamContext>>>

/** `add_user_to_github_repository!` for the member making the request */
async function grantAccess(session: Session, context: TeamContext, fullName: string) {
  const invitationId = await addCollaborator(
    context.installationId,
    fullName,
    context.githubLogin,
    context.studentsAreRepoAdmins ? 'admin' : 'push',
  )

  if (invitationId !== null) await acceptRepositoryInvitation(session, invitationId)
}

/** Everything the creation needs, for the caller's team */
async function loadTeamContext(session: Session, key: string) {
  const userId = Number(session.user.id)

  const [row] = await db
    .select({
      assignmentId: groupAssignments.id,
      assignmentSlug: groupAssignments.slug,
      publicRepo: groupAssignments.publicRepo,
      studentsAreRepoAdmins: groupAssignments.studentsAreRepoAdmins,
      starterCodeRepoId: groupAssignments.starterCodeRepoId,
      invitationsEnabled: groupAssignments.invitationsEnabled,
      installationId: organizations.installationId,
      archivedAt: organizations.archivedAt,
      teamId: groups.id,
      teamSlug: groups.slug,
      statusId: groupInviteStatuses.id,
      status: groupInviteStatuses.status,
      githubLogin: users.githubLogin,
    })
    .from(groupAssignmentInvitations)
    .innerJoin(
      groupAssignments,
      and(
        eq(groupAssignments.id, groupAssignmentInvitations.groupAssignmentId),
        isNull(groupAssignments.deletedAt),
      ),
    )
    .innerJoin(
      organizations,
      and(eq(organizations.id, groupAssignments.organizationId), isNull(organizations.deletedAt)),
    )
    // Inner: without a team of this set the caller never accepted, and there is
    // nothing here for them
    .innerJoin(
      groupsUsers,
      and(
        eq(groupsUsers.groupingId, groupAssignments.groupingId),
        eq(groupsUsers.userId, userId),
      ),
    )
    .innerJoin(groups, eq(groups.id, groupsUsers.groupId))
    .innerJoin(
      groupInviteStatuses,
      and(
        eq(groupInviteStatuses.groupAssignmentInvitationId, groupAssignmentInvitations.id),
        eq(groupInviteStatuses.groupId, groupsUsers.groupId),
      ),
    )
    .innerJoin(users, eq(users.id, userId))
    .where(
      and(eq(groupAssignmentInvitations.key, key), isNull(groupAssignmentInvitations.deletedAt)),
    )

  if (!row?.githubLogin) return null

  const organization = await findInstallationAccount(row.installationId)
  if (!organization) return null

  return { ...row, githubLogin: row.githubLogin, userId, orgLogin: organization.login }
}

async function findExistingTeamRepository(context: TeamContext) {
  const [row] = await db
    .select({ githubRepoId: groupAssignmentRepos.githubRepoId })
    .from(groupAssignmentRepos)
    .where(
      and(
        eq(groupAssignmentRepos.groupAssignmentId, context.assignmentId),
        eq(groupAssignmentRepos.groupId, context.teamId),
      ),
    )

  if (!row) return null

  return findRepositoryById(context.installationId, row.githubRepoId)
}

async function rollbackTeam(context: TeamContext, repository: GitHubRepository | null) {
  if (!repository) return

  await db
    .delete(groupAssignmentRepos)
    .where(eq(groupAssignmentRepos.githubRepoId, repository.id))
  await deleteRepository(context.installationId, repository.fullName)
}

async function setTeamStatus(
  statusId: number,
  status: 'accepted' | 'completed' | 'errored_creating_repo',
) {
  await db
    .update(groupInviteStatuses)
    .set({ status, updatedAt: new Date() })
    .where(eq(groupInviteStatuses.id, statusId))
}
