import type { Session } from 'next-auth'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  groupAssignmentRepos,
  groupAssignments,
  groupings,
  groups,
  organizations,
  organizationsUsers,
  rosters,
  teachingAssistantAllocations,
  teachingAssistantRepoAccesses,
  teachingAssistants,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * A TA's read access on GitHub to their teams' repositories, granted when
 * they open the dashboard and revoked when a teacher takes the allocation or
 * the TA away — docs/teaching-assistants.md. Nothing to port: the original
 * has no TA role. GitHub is mocked; the real run is in that doc.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const findInstallationAccount = vi.fn()

vi.mock('@/lib/github/organizations', () => ({
  listUserOrganizations: vi.fn(async () => []),
  setDefaultRepositoryPermissionToNone: vi.fn(),
  findOrganizationByInstallation: vi.fn(),
  findInstallationAccount: (...args: unknown[]) => findInstallationAccount(...args),
}))

const findGitHubLoginById = vi.fn()

vi.mock('@/lib/github/users', () => ({
  findGitHubUserByLogin: vi.fn(),
  findGitHubLoginById: (...args: unknown[]) => findGitHubLoginById(...args),
}))

const addCollaborator = vi.fn()
const removeCollaborator = vi.fn()
const acceptRepositoryInvitation = vi.fn()

/** 9999 is gone on GitHub; 8888 is behind an outage */
vi.mock('@/lib/github/repositories', () => ({
  findRepositoryFullNameById: async (_installationId: number, id: number) => {
    if (id === 8888) throw Object.assign(new Error('Bad gateway'), { status: 502 })
    return id === 9999 ? null : `org/repo-${id}`
  },
  addCollaborator: (...args: unknown[]) => addCollaborator(...args),
  removeCollaborator: (...args: unknown[]) => removeCollaborator(...args),
  acceptRepositoryInvitation: (...args: unknown[]) => acceptRepositoryInvitation(...args),
  secondaryRateLimitDelay: (error: unknown) =>
    (error as { status?: number })?.status === 429 ? 60 : null,
}))

const { syncAssistantRepoAccess } = await import('@/lib/data/assistant-repo-access')
const { removeTeachingAssistant, setAllocation } = await import('@/lib/data/teaching-assistants')

const SLUG = 'sd-2026-1'

let nextUid = 1

async function user(login: string): Promise<Session> {
  const uid = nextUid++
  const [row] = await db
    .insert(users)
    .values({ uid, githubLogin: login })
    .returning({ id: users.id })
  return {
    accessToken: `gho_${login}`,
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    via: 'browser',
    user: { id: String(row.id), uid, githubLogin: login },
  } as Session
}

const idOf = (session: Session) => Number(session.user.id)

type World = {
  profe: Session
  ta: Session
  orgId: number
  taId: number
  teams: { mine: number; theirs: number }
  repos: { mine: number; theirs: number }
}

/** Two teams with a repository each in tp1; the TA corrects the first */
async function world(): Promise<World> {
  const profe = await user('profe')
  const ta = await user('ayudante')

  const [roster] = await db.insert(rosters).values({ identifierName: 'Padrón' }).returning({ id: rosters.id })
  const [org] = await db
    .insert(organizations)
    .values({ githubId: 4321, installationId: 99, title: 'SD', slug: SLUG, rosterId: roster.id })
    .returning({ id: organizations.id })
  await db.insert(organizationsUsers).values({ organizationId: org.id, userId: idOf(profe) })
  const [taRow] = await db
    .insert(teachingAssistants)
    .values({ organizationId: org.id, userId: idOf(ta), createdByUserId: idOf(profe) })
    .returning({ id: teachingAssistants.id })

  const [set] = await db
    .insert(groupings)
    .values({ organizationId: org.id, title: 'Equipos', slug: 'equipos' })
    .returning({ id: groupings.id })
  const [t1, t2] = await db
    .insert(groups)
    .values([
      { groupingId: set.id, organizationId: org.id, title: 'Los Raft', slug: 'los-raft' },
      { groupingId: set.id, organizationId: org.id, title: 'Los Paxos', slug: 'los-paxos' },
    ])
    .returning({ id: groups.id })
  const [tp1] = await db
    .insert(groupAssignments)
    .values({
      organizationId: org.id,
      groupingId: set.id,
      creatorId: idOf(profe),
      title: 'TP1',
      slug: 'tp1',
    })
    .returning({ id: groupAssignments.id })
  const [g1, g2] = await db
    .insert(groupAssignmentRepos)
    .values([
      { githubRepoId: 2001, groupAssignmentId: tp1.id, groupId: t1.id },
      { githubRepoId: 2002, groupAssignmentId: tp1.id, groupId: t2.id },
    ])
    .returning({ id: groupAssignmentRepos.id })

  await db.insert(teachingAssistantAllocations).values({
    teachingAssistantId: taRow.id,
    organizationId: org.id,
    groupAssignmentId: tp1.id,
    groupingId: set.id,
    groupId: t1.id,
    createdByUserId: idOf(profe),
  })

  return {
    profe,
    ta,
    orgId: org.id,
    taId: taRow.id,
    teams: { mine: t1.id, theirs: t2.id },
    repos: { mine: g1.id, theirs: g2.id },
  }
}

const accessRows = () =>
  db
    .select({
      teachingAssistantId: teachingAssistantRepoAccesses.teachingAssistantId,
      groupAssignmentRepoId: teachingAssistantRepoAccesses.groupAssignmentRepoId,
    })
    .from(teachingAssistantRepoAccesses)

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  vi.clearAllMocks()
  addCollaborator.mockResolvedValue(555)
  removeCollaborator.mockResolvedValue(undefined)
  acceptRepositoryInvitation.mockResolvedValue(undefined)
  findGitHubLoginById.mockResolvedValue('ayudante')
  findInstallationAccount.mockResolvedValue({ login: 'org' })
})

/** More teams of tp1 with a repository each, all allocated to the TA */
async function moreTeams(w: World, count: number) {
  const [{ groupingId, groupAssignmentId }] = await db
    .select({
      groupingId: groupAssignments.groupingId,
      groupAssignmentId: groupAssignments.id,
    })
    .from(groupAssignments)
  for (let i = 0; i < count; i++) {
    const [team] = await db
      .insert(groups)
      .values({ groupingId, organizationId: w.orgId, title: `Extra ${i}`, slug: `extra-${i}` })
      .returning({ id: groups.id })
    await db
      .insert(groupAssignmentRepos)
      .values({ githubRepoId: 3000 + i, groupAssignmentId, groupId: team.id })
    await db.insert(teachingAssistantAllocations).values({
      teachingAssistantId: w.taId,
      organizationId: w.orgId,
      groupAssignmentId,
      groupingId,
      groupId: team.id,
      createdByUserId: idOf(w.profe),
    })
  }
}

describe('syncAssistantRepoAccess', () => {
  it("invites the TA with pull to their team's repository and accepts it with their token", async () => {
    const w = await world()

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(addCollaborator).toHaveBeenCalledWith(99, 'org/repo-2001', 'ayudante', 'pull')
    expect(acceptRepositoryInvitation).toHaveBeenCalledWith(w.ta, 555)
    expect(await accessRows()).toEqual([
      { teachingAssistantId: w.taId, groupAssignmentRepoId: w.repos.mine },
    ])
  })

  it('does nothing on a second visit', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    vi.clearAllMocks()

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(addCollaborator).not.toHaveBeenCalled()
    expect(removeCollaborator).not.toHaveBeenCalled()
  })

  it('records an org member, whom GitHub adds without an invitation', async () => {
    const w = await world()
    addCollaborator.mockResolvedValue(null)

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(acceptRepositoryInvitation).not.toHaveBeenCalled()
    expect(await accessRows()).toHaveLength(1)
  })

  it('does nothing for a teacher, or for somebody who is neither', async () => {
    const w = await world()
    const stranger = await user('extraño')

    await syncAssistantRepoAccess(w.profe, SLUG, 'tp1')
    await syncAssistantRepoAccess(stranger, SLUG, 'tp1')

    expect(addCollaborator).not.toHaveBeenCalled()
    expect(await accessRows()).toEqual([])
  })

  it('grants nothing on an archived classroom', async () => {
    const w = await world()
    await db
      .update(organizations)
      .set({ archivedAt: new Date() })
      .where(eq(organizations.id, w.orgId))

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('skips a repository that is gone on GitHub, without recording it', async () => {
    const w = await world()
    await db
      .update(groupAssignmentRepos)
      .set({ githubRepoId: 9999 })
      .where(eq(groupAssignmentRepos.id, w.repos.mine))

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(addCollaborator).not.toHaveBeenCalled()
    expect(await accessRows()).toEqual([])
  })

  it('records the invitation even when the accept fails, so it is not sent again', async () => {
    const w = await world()
    acceptRepositoryInvitation.mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(addCollaborator).toHaveBeenCalledTimes(1)
    expect(await accessRows()).toHaveLength(1)
  })

  it('invites the login the account has now, not the one in the session', async () => {
    const w = await world()
    findGitHubLoginById.mockResolvedValue('ayudante-renombrado')

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(findGitHubLoginById).toHaveBeenCalledWith(w.ta, w.ta.user.uid)
    expect(addCollaborator).toHaveBeenCalledWith(99, 'org/repo-2001', 'ayudante-renombrado', 'pull')
  })

  it('asks GitHub nothing when there is nothing to do', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    vi.clearAllMocks()

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(findInstallationAccount).not.toHaveBeenCalled()
    expect(findGitHubLoginById).not.toHaveBeenCalled()
  })

  it('grants at most 20 repositories per visit', async () => {
    const w = await world()
    await moreTeams(w, 24)

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(addCollaborator).toHaveBeenCalledTimes(20)
    expect(await accessRows()).toHaveLength(20)
  })

  it('stops at the batch where GitHub asks to slow down', async () => {
    const w = await world()
    await moreTeams(w, 9)
    addCollaborator.mockRejectedValue(Object.assign(new Error('slow down'), { status: 429 }))

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(addCollaborator).toHaveBeenCalledTimes(5)
  })

  it('revokes what no allocation covers any more', async () => {
    const w = await world()
    await db
      .insert(teachingAssistantRepoAccesses)
      .values({ teachingAssistantId: w.taId, groupAssignmentRepoId: w.repos.theirs })

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(removeCollaborator).toHaveBeenCalledWith(99, 'org/repo-2002', 'ayudante')
    expect(await accessRows()).toEqual([
      { teachingAssistantId: w.taId, groupAssignmentRepoId: w.repos.mine },
    ])
  })

  it('takes the access back when the TA is removed while it is being granted', async () => {
    const w = await world()
    addCollaborator.mockImplementation(async () => {
      await db.delete(teachingAssistants).where(eq(teachingAssistants.id, w.taId))
      return 555
    })

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(removeCollaborator).toHaveBeenCalledWith(99, 'org/repo-2001', 'ayudante')
    expect(await accessRows()).toEqual([])
  })

  it('takes the access back when the team is deallocated while it is being granted', async () => {
    const w = await world()
    // The teacher's revoke runs here and finds no row yet
    addCollaborator.mockImplementation(async () => {
      await setAllocation(w.profe, SLUG, 'tp1', 'group', {
        teachingAssistantId: w.taId,
        targetIds: [w.teams.mine],
        allocate: false,
      })
      return 555
    })

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    expect(removeCollaborator).toHaveBeenCalledWith(99, 'org/repo-2001', 'ayudante')
    expect(acceptRepositoryInvitation).not.toHaveBeenCalled()
    expect(await accessRows()).toEqual([])
  })

  it('takes the invitation back when it cannot be recorded', async () => {
    const w = await world()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    addCollaborator.mockImplementation(async () => {
      await db.execute(sql`alter table teaching_assistant_repo_accesses rename to broken`)
      return 555
    })

    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    await db.execute(sql`alter table broken rename to teaching_assistant_repo_accesses`)

    expect(removeCollaborator).toHaveBeenCalledWith(99, 'org/repo-2001', 'ayudante')
    expect(acceptRepositoryInvitation).not.toHaveBeenCalled()
    expect(await accessRows()).toEqual([])
  })
})

describe('setAllocation, taking a team off', () => {
  it("revokes the TA's access to that team's repository, by their current login", async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    findGitHubLoginById.mockResolvedValue('ayudante-renombrado')

    const result = await setAllocation(w.profe, SLUG, 'tp1', 'group', {
      teachingAssistantId: w.taId,
      targetIds: [w.teams.mine],
      allocate: false,
    })

    expect(result).toEqual({ success: true })
    expect(findGitHubLoginById).toHaveBeenCalledWith(w.profe, w.ta.user.uid)
    expect(removeCollaborator).toHaveBeenCalledWith(99, 'org/repo-2001', 'ayudante-renombrado')
    expect(await accessRows()).toEqual([])
  })

  it('still takes the allocation off when GitHub fails, keeping the row to retry', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    removeCollaborator.mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await setAllocation(w.profe, SLUG, 'tp1', 'group', {
      teachingAssistantId: w.taId,
      targetIds: [w.teams.mine],
      allocate: false,
    })

    expect(result).toEqual({ success: true })
    expect(await db.select().from(teachingAssistantAllocations)).toEqual([])
    expect(await accessRows()).toHaveLength(1)
  })

  it('does not touch GitHub when there was nothing granted', async () => {
    const w = await world()

    await setAllocation(w.profe, SLUG, 'tp1', 'group', {
      teachingAssistantId: w.taId,
      targetIds: [w.teams.mine],
      allocate: false,
    })

    expect(findGitHubLoginById).not.toHaveBeenCalled()
    expect(removeCollaborator).not.toHaveBeenCalled()
  })
})

describe('removeTeachingAssistant', () => {
  it('keeps the TA and the row when GitHub has an outage, instead of reading it as gone', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    await db
      .update(groupAssignmentRepos)
      .set({ githubRepoId: 8888 })
      .where(eq(groupAssignmentRepos.id, w.repos.mine))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await removeTeachingAssistant(w.profe, SLUG, w.taId)

    expect(result.success).toBe(false)
    expect(await db.select().from(teachingAssistants)).toHaveLength(1)
    expect(await accessRows()).toHaveLength(1)
  })

  it('refuses when the installation is gone and cannot be re-resolved', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    findInstallationAccount.mockResolvedValue(null)

    const result = await removeTeachingAssistant(w.profe, SLUG, w.taId)

    expect(result.success).toBe(false)
    expect(removeCollaborator).not.toHaveBeenCalled()
    expect(await accessRows()).toHaveLength(1)
  })

  it('revokes a grant that lands while it is being removed, then removes the TA', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    // The TA's dashboard grants the other team right after the first revoke
    removeCollaborator.mockImplementationOnce(async () => {
      await db
        .insert(teachingAssistantRepoAccesses)
        .values({ teachingAssistantId: w.taId, groupAssignmentRepoId: w.repos.theirs })
    })

    const result = await removeTeachingAssistant(w.profe, SLUG, w.taId)

    expect(result).toEqual({ success: true })
    expect(removeCollaborator).toHaveBeenCalledWith(99, 'org/repo-2002', 'ayudante')
    expect(await db.select().from(teachingAssistants)).toEqual([])
    // The second round reuses the installation and login of the first
    expect(findGitHubLoginById.mock.calls.filter(([s]) => s === w.profe)).toHaveLength(1)
  })

  it('revokes every repository first, then removes the TA', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')

    const result = await removeTeachingAssistant(w.profe, SLUG, w.taId)

    expect(result).toEqual({ success: true })
    expect(removeCollaborator).toHaveBeenCalledWith(99, 'org/repo-2001', 'ayudante')
    expect(await db.select().from(teachingAssistants)).toEqual([])
  })

  it('keeps the TA when GitHub fails, so the teacher can retry', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    removeCollaborator.mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await removeTeachingAssistant(w.profe, SLUG, w.taId)

    expect(result.success).toBe(false)
    expect(await db.select().from(teachingAssistants)).toHaveLength(1)
    expect(await accessRows()).toHaveLength(1)
  })

  it('just forgets the access of an account that no longer exists', async () => {
    const w = await world()
    await syncAssistantRepoAccess(w.ta, SLUG, 'tp1')
    findGitHubLoginById.mockResolvedValue(null)

    const result = await removeTeachingAssistant(w.profe, SLUG, w.taId)

    expect(result).toEqual({ success: true })
    expect(removeCollaborator).not.toHaveBeenCalled()
  })
})
