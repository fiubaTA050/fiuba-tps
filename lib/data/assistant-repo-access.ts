import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  groupAssignmentRepos,
  organizations,
  teachingAssistantAllocations,
  teachingAssistantRepoAccesses,
  teachingAssistants,
  users,
} from '@/db/schema'
import { currentInstallationId } from '@/lib/data/organizations'
import { isForeignKeyViolation } from '@/lib/data/postgres'
import { findStaffAssignment } from '@/lib/data/staff'
import { db } from '@/lib/db'
import {
  acceptRepositoryInvitation,
  addCollaborator,
  findRepositoryFullNameById,
  removeCollaborator,
  secondaryRateLimitDelay,
} from '@/lib/github/repositories'
import { findGitHubLoginById } from '@/lib/github/users'

/**
 * A teaching assistant's read access to the repositories of their teams, on
 * GitHub: an outside collaborator with `pull`, the same mechanism a student
 * gets with `push` (docs/creacion-de-repos.md). No equivalent in the
 * original, where TAs were owners of the org and read every repository.
 *
 * The allocation says what should be; `teaching_assistant_repo_accesses` is
 * what was done. Granting needs the TA's own token — the invitation is
 * accepted for them, as it is for a student — so it happens when they open
 * the dashboard. Revoking only needs the installation, so it happens when a
 * teacher takes an allocation or the TA away. Whatever slips between the two
 * (a call that failed, a race) is caught by the next pass of either.
 *
 * GitHub still emails the invitation, accepted or not: its docs say the
 * invitee is notified, and that is not something the API lets us skip.
 *
 * Group assignments only, for now: allocation has controls only there.
 */

/**
 * Grants per dashboard visit. Each one is an invitation and an accept, both
 * content-creating, under GitHub's 80 per minute; a TA with more teams than
 * this gets the rest on their next visit.
 */
const MAX_GRANTS_PER_VISIT = 20

/** As in `listRepositorySnapshots`: parallel, but not a burst */
const BATCH_SIZE = 5

type RepoRef = { groupAssignmentRepoId: number; githubRepoId: number }
type Allocated = RepoRef & { groupId: number }
type Granted = RepoRef & { accessId: number }

/**
 * Called in `after()` by the group dashboard, for whoever opened it: does
 * nothing unless that is a TA. Grants what their allocations reach and they
 * do not have yet — a repository created after the allocation is picked up
 * here — and revokes, in this assignment, what no allocation covers any more.
 *
 * Nothing is granted on an archived classroom, which every writer refuses;
 * taking access away still runs there, as `removeTeachingAssistant` does.
 */
export async function syncAssistantRepoAccess(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<void> {
  const staff = await findStaffAssignment(session, classroomSlug, assignmentSlug, 'group', {
    allowAssistant: true,
  })
  if (!staff?.assignment || staff.role !== 'assistant') return

  const teachingAssistantId = staff.teachingAssistantId!
  const groupAssignmentId = staff.assignment.id

  const [allocated, granted] = await Promise.all([
    allocatedRepos(teachingAssistantId, groupAssignmentId),
    grantedRepos(teachingAssistantId, groupAssignmentId),
  ])

  const wanted = new Set(allocated.map((repo) => repo.groupAssignmentRepoId))
  const stale = granted.filter((repo) => !wanted.has(repo.groupAssignmentRepoId))

  const have = new Set(granted.map((repo) => repo.groupAssignmentRepoId))
  const missing = staff.classroom.archivedAt
    ? []
    : allocated
        .filter((repo) => !have.has(repo.groupAssignmentRepoId))
        .slice(0, MAX_GRANTS_PER_VISIT)

  // The common visit: nothing to do, and nothing asked of GitHub
  if (stale.length === 0 && missing.length === 0) return

  const installationId = await liveInstallationId(session, staff.classroom.id)
  if (installationId === null) return

  // The login in the session is the one they signed in with. After a rename
  // somebody else can hold it, and inviting by it would invite them
  const login = await findGitHubLoginById(session, session.user.uid)
  if (login === null) return

  if (stale.length > 0) await revoke(installationId, login, stale)

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const results = await Promise.allSettled(
      missing
        .slice(i, i + BATCH_SIZE)
        .map((repo) =>
          grant(session, installationId, login, teachingAssistantId, groupAssignmentId, repo),
        ),
    )

    let slowDown = false
    for (const result of results) {
      if (result.status === 'fulfilled') continue
      // GitHub asked us to wait: what is left goes on the next visit
      if (secondaryRateLimitDelay(result.reason) !== null) slowDown = true
      else console.error('syncAssistantRepoAccess: grant failed', result.reason)
    }
    if (slowDown) return
  }
}

/**
 * Invite the TA with `pull`, record it, and accept it with their token.
 *
 * Recorded before the accept, not after: once the invitation exists there is
 * something to revoke, and `removeCollaborator` takes a pending invitation
 * back too. An accept that fails leaves the invitation in their email —
 * waiting for the next visit instead would send it again every time.
 *
 * Whatever is not recorded is taken back on the spot: a row is the only thing
 * a later revoke reads, so access without one would outlive every revoke.
 */
async function grant(
  session: Session,
  installationId: number,
  login: string,
  teachingAssistantId: number,
  groupAssignmentId: number,
  repo: Allocated,
): Promise<void> {
  const fullName = await findRepositoryFullNameById(installationId, repo.githubRepoId)
  // Gone on GitHub: nothing to grant (NullGitHubRepository)
  if (fullName === null) return

  // Null when GitHub answers 204: an org member, reached without an invitation
  const invitationId = await addCollaborator(installationId, fullName, login, 'pull')

  let recorded: boolean
  try {
    recorded = await record(teachingAssistantId, groupAssignmentId, repo)
  } catch (error) {
    await removeCollaborator(installationId, fullName, login).catch((undoError) =>
      console.error('syncAssistantRepoAccess: could not undo an unrecorded grant', undoError),
    )
    throw error
  }
  if (!recorded) {
    await removeCollaborator(installationId, fullName, login)
    return
  }

  if (invitationId === null) return
  try {
    await acceptRepositoryInvitation(session, invitationId)
  } catch (error) {
    console.error('syncAssistantRepoAccess: accept failed, left to the email', error)
  }
}

/**
 * Records a grant, but only while the TA and the allocation behind it still
 * exist — and holds both until it commits. A teacher taking either away
 * while the invitation was in flight has already revoked, before this row
 * existed: here the delete waits, and its revoke then finds the row, or it
 * came first and nothing is recorded. The TA is locked before the
 * allocation, the order `removeTeachingAssistant` takes them in (the TA row,
 * then its allocations by cascade), so the two cannot deadlock.
 */
async function record(
  teachingAssistantId: number,
  groupAssignmentId: number,
  repo: Allocated,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const [assistant] = await tx
        .select({ id: teachingAssistants.id })
        .from(teachingAssistants)
        .where(eq(teachingAssistants.id, teachingAssistantId))
        .for('key share')
      if (!assistant) return false

      const [allocation] = await tx
        .select({ id: teachingAssistantAllocations.id })
        .from(teachingAssistantAllocations)
        .where(
          and(
            eq(teachingAssistantAllocations.teachingAssistantId, teachingAssistantId),
            eq(teachingAssistantAllocations.groupAssignmentId, groupAssignmentId),
            eq(teachingAssistantAllocations.groupId, repo.groupId),
          ),
        )
        .for('share')
      if (!allocation) return false

      await tx
        .insert(teachingAssistantRepoAccesses)
        .values({ teachingAssistantId, groupAssignmentRepoId: repo.groupAssignmentRepoId })
        .onConflictDoNothing()
      return true
    })
  } catch (error) {
    // The team's repository row was deleted meanwhile
    if (isForeignKeyViolation(error)) return false
    throw error
  }
}

/**
 * Who to revoke from, and through which installation. Resolved once per
 * removal: its retry rounds would otherwise ask GitHub again each time.
 */
type RevokeTarget =
  // The installation is dead, or the TA is gone: nothing can be revoked
  | { kind: 'unreachable' }
  // The account no longer exists, and its collaborator access with it
  | { kind: 'deleted' }
  | { kind: 'live'; installationId: number; login: string }

/** Holds the target across calls; a fresh one per removal or allocation change */
export type RevokeMemo = { target?: Promise<RevokeTarget> }

/**
 * Takes back a TA's access, for a teacher: in one assignment, what no
 * allocation covers any more (`groupAssignmentId`), or everything they were
 * granted in the classroom (`null`, before removing them). Returns how many
 * repositories it could not revoke; those keep their row, so the next pass
 * tries again.
 *
 * For `lib/data/` only: the caller has already authorized the classroom as
 * its teacher, and `teachingAssistantId` as one of its TAs.
 */
export async function revokeAssistantRepoAccess(
  session: Session,
  classroomId: number,
  teachingAssistantId: number,
  groupAssignmentId: number | null,
  memo: RevokeMemo = {},
): Promise<number> {
  const [granted, allocated] = await Promise.all([
    grantedRepos(teachingAssistantId, groupAssignmentId),
    groupAssignmentId === null ? [] : allocatedRepos(teachingAssistantId, groupAssignmentId),
  ])

  const wanted = new Set(allocated.map((repo) => repo.groupAssignmentRepoId))
  const stale = granted.filter((repo) => !wanted.has(repo.groupAssignmentRepoId))
  if (stale.length === 0) return 0

  memo.target ??= revokeTarget(session, classroomId, teachingAssistantId)
  const target = await memo.target

  if (target.kind === 'unreachable') return stale.length
  if (target.kind === 'deleted') {
    await db.delete(teachingAssistantRepoAccesses).where(
      inArray(
        teachingAssistantRepoAccesses.id,
        stale.map((repo) => repo.accessId),
      ),
    )
    return 0
  }

  return revoke(target.installationId, target.login, stale)
}

async function revokeTarget(
  session: Session,
  classroomId: number,
  teachingAssistantId: number,
): Promise<RevokeTarget> {
  const [installationId, account] = await Promise.all([
    liveInstallationId(session, classroomId),
    db
      .select({ uid: users.uid })
      .from(teachingAssistants)
      .innerJoin(users, eq(users.id, teachingAssistants.userId))
      .where(eq(teachingAssistants.id, teachingAssistantId)),
  ])
  if (installationId === null || account.length === 0) return { kind: 'unreachable' }

  // By id, not the stored login: that one is only as fresh as the TA's last
  // sign-in, and a revoke against a renamed login answers 404 — which reads as
  // done and would leave the access in place
  const login = await findGitHubLoginById(session, account[0].uid)
  if (login === null) return { kind: 'deleted' }

  return { kind: 'live', installationId, login }
}

/** Removes the collaborator and its row, repository by repository */
async function revoke(installationId: number, login: string, repos: Granted[]): Promise<number> {
  let failed = 0

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const results = await Promise.allSettled(
      repos.slice(i, i + BATCH_SIZE).map(async (repo) => {
        // Only a 404 reads as gone — a deleted repository takes its
        // collaborators with it. An outage throws and keeps the row
        const fullName = await findRepositoryFullNameById(installationId, repo.githubRepoId)
        if (fullName !== null) await removeCollaborator(installationId, fullName, login)
        await db
          .delete(teachingAssistantRepoAccesses)
          .where(eq(teachingAssistantRepoAccesses.id, repo.accessId))
      }),
    )

    for (const result of results) {
      if (result.status === 'fulfilled') continue
      failed++
      console.error('revokeAssistantRepoAccess: revoke failed', result.reason)
    }
  }

  return failed
}

/** The repositories of the teams allocated to the TA in this assignment */
function allocatedRepos(
  teachingAssistantId: number,
  groupAssignmentId: number,
): Promise<Allocated[]> {
  return db
    .select({
      groupAssignmentRepoId: groupAssignmentRepos.id,
      githubRepoId: groupAssignmentRepos.githubRepoId,
      groupId: groupAssignmentRepos.groupId,
    })
    .from(teachingAssistantAllocations)
    .innerJoin(
      groupAssignmentRepos,
      and(
        eq(groupAssignmentRepos.groupAssignmentId, teachingAssistantAllocations.groupAssignmentId),
        eq(groupAssignmentRepos.groupId, teachingAssistantAllocations.groupId),
      ),
    )
    .where(
      and(
        eq(teachingAssistantAllocations.teachingAssistantId, teachingAssistantId),
        eq(teachingAssistantAllocations.groupAssignmentId, groupAssignmentId),
      ),
    )
}

/** What the TA was granted, in one assignment or (`null`) in all of them */
function grantedRepos(
  teachingAssistantId: number,
  groupAssignmentId: number | null,
): Promise<Granted[]> {
  return db
    .select({
      accessId: teachingAssistantRepoAccesses.id,
      groupAssignmentRepoId: groupAssignmentRepos.id,
      githubRepoId: groupAssignmentRepos.githubRepoId,
    })
    .from(teachingAssistantRepoAccesses)
    .innerJoin(
      groupAssignmentRepos,
      eq(groupAssignmentRepos.id, teachingAssistantRepoAccesses.groupAssignmentRepoId),
    )
    .where(
      and(
        eq(teachingAssistantRepoAccesses.teachingAssistantId, teachingAssistantId),
        groupAssignmentId === null
          ? undefined
          : eq(groupAssignmentRepos.groupAssignmentId, groupAssignmentId),
      ),
    )
}

/**
 * The classroom's installation, re-resolved after a reinstall. A stale one
 * would 404 on the token mint, and a revoke would read that as "repository
 * gone" and drop the row with the access still in place.
 */
async function liveInstallationId(session: Session, classroomId: number): Promise<number | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      githubId: organizations.githubId,
      installationId: organizations.installationId,
    })
    .from(organizations)
    .where(eq(organizations.id, classroomId))
  if (!row) return null

  return currentInstallationId(session, row)
}
