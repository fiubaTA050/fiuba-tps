import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  groupAssignmentInvitations,
  groupAssignmentRepos,
  groupAssignments,
  groupInviteStatuses,
  groupings,
  groups,
  groupsUsers,
  organizations,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * The group half of spec/services/create_github_repo_service_spec.rb, and of
 * the `POST #create_repo` cases of
 * spec/controllers/group_assignment_invitations_controller_spec.rb.
 *
 * Same split as test/repositories.test.ts: GitHub is stubbed and the database
 * is real, because what is worth testing here is the lock shared by a whole
 * team, the compensating rollback and who ends up with access.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

vi.mock('@/lib/github/organizations', () => ({
  findInstallationAccount: async () => ({
    githubId: 1,
    login: 'fiubaTA050-labs',
    name: null,
    avatarUrl: '',
    installationId: 1,
  }),
}))

const github = {
  created: [] as { id: number; fullName: string }[],
  deleted: [] as string[],
  accepted: [] as number[],
  invited: [] as { fullName: string; login: string; permission: string }[],
  existingNames: new Set<string>(),
  nextRepoId: 5000,
  failCreate: null as unknown,
  /** null = 204 for somebody who already has access, a number = a fresh invitation */
  invitationId: 42 as number | null,
}

vi.mock('@/lib/github/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/repositories')>()

  const create = async (_installationId: number, input: { owner: string; name: string }) => {
    if (github.failCreate) throw github.failCreate
    const repo = { id: (github.nextRepoId += 1), fullName: `${input.owner}/${input.name}` }
    github.created.push(repo)
    github.existingNames.add(repo.fullName)
    return {
      ...repo,
      htmlUrl: `https://github.com/${repo.fullName}`,
      private: true,
      isTemplate: false,
    }
  }

  return {
    ...actual,
    createRepositoryFromTemplate: create,
    createRepository: create,
    deleteRepository: async (_installationId: number, fullName: string) => {
      github.deleted.push(fullName)
      github.existingNames.delete(fullName)
    },
    addCollaborator: async (
      _installationId: number,
      fullName: string,
      login: string,
      permission: string,
    ) => {
      github.invited.push({ fullName, login, permission })
      return github.invitationId
    },
    acceptRepositoryInvitation: async (_session: Session, invitationId: number) => {
      github.accepted.push(invitationId)
    },
    repositoryExists: async (_installationId: number, fullName: string) =>
      github.existingNames.has(fullName),
    findRepositoryById: async (_installationId: number, id: number) => {
      const repo = github.created.find((candidate) => candidate.id === id)
      if (!repo) {
        return id === TEMPLATE_ID
          ? {
              id,
              fullName: 'fiubaTA050-labs/raft-starter',
              htmlUrl: '',
              private: false,
              isTemplate: true,
            }
          : null
      }
      return {
        id: repo.id,
        fullName: repo.fullName,
        htmlUrl: `https://github.com/${repo.fullName}`,
        private: true,
        isTemplate: false,
      }
    },
  }
})

const TEMPLATE_ID = 999

const { claimPendingTeamInvitation, createTeamRepository, findTeamRepository } = await import(
  '@/lib/data/repositories'
)
const { acceptGroupInvitation } = await import('@/lib/data/group-invitations')

let nextUid = 1
let nextGithubId = 1000

async function student(login: string): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: login })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: login },
  } as Session
}

async function classroomWithGroupAssignment(options: { admins?: boolean } = {}) {
  const githubId = nextGithubId++
  const teacher = await student(`docente-${githubId}`)

  const [classroom] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: `${githubId}`,
      slug: `${githubId}-classroom`,
    })
    .returning({ id: organizations.id })

  const [grouping] = await db
    .insert(groupings)
    .values({ organizationId: classroom.id, title: 'Equipos', slug: 'equipos' })
    .returning({ id: groupings.id })

  const [assignment] = await db
    .insert(groupAssignments)
    .values({
      organizationId: classroom.id,
      groupingId: grouping.id,
      creatorId: Number(teacher.user.id),
      title: 'TP1',
      slug: '2026a-tp1',
      starterCodeRepoId: TEMPLATE_ID,
      studentsAreRepoAdmins: options.admins ?? false,
    })
    .returning({ id: groupAssignments.id })

  const key = `key-${githubId}`
  await db.insert(groupAssignmentInvitations).values({ groupAssignmentId: assignment.id, key })

  return { classroomId: classroom.id, assignmentId: assignment.id, key }
}

function rateLimitError(retryAfter?: string) {
  return Object.assign(new Error('You have exceeded a secondary rate limit'), {
    status: 403,
    response: { headers: retryAfter ? { 'retry-after': retryAfter } : {} },
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
  github.created = []
  github.deleted = []
  github.accepted = []
  github.invited = []
  github.existingNames = new Set()
  github.nextRepoId = 5000
  github.failCreate = null
  github.invitationId = 42
})

describe('createTeamRepository', () => {
  it('names the repository after the team and gives the member access', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'Distreet boys' })

    const result = await createTeamRepository(session, fixture.key)

    expect(result).toMatchObject({ status: 'completed' })
    expect(github.created).toHaveLength(1)
    // GroupExercise#default_repo_name: `<assignment-slug>-<team-slug>`
    expect(github.created[0].fullName).toBe('fiubaTA050-labs/2026a-tp1-distreet-boys')

    expect(github.invited).toEqual([
      {
        fullName: 'fiubaTA050-labs/2026a-tp1-distreet-boys',
        login: 'lazcanoluca',
        permission: 'push',
      },
    ])
    // Accepted with the student's own token, so no email invitation is left
    expect(github.accepted).toEqual([42])

    const [repo] = await db.select().from(groupAssignmentRepos)
    expect(repo.githubRepoId).toBe(github.created[0].id)

    const [status] = await db.select().from(groupInviteStatuses)
    expect(status.status).toBe('completed')
  })

  it('honours students_are_repo_admins', async () => {
    const fixture = await classroomWithGroupAssignment({ admins: true })
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    await createTeamRepository(session, fixture.key)

    expect(github.invited[0].permission).toBe('admin')
  })

  // The case the whole design turns on: one repository for the team
  it('gives a teammate access to the repository that already exists', async () => {
    const fixture = await classroomWithGroupAssignment()
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'Distreet boys' })
    await createTeamRepository(first, fixture.key)

    const [team] = await db.select().from(groups)
    await acceptGroupInvitation(second, fixture.key, { groupId: team.id })

    const result = await createTeamRepository(second, fixture.key)

    expect(result).toMatchObject({ status: 'completed' })
    // No second repository, and no second row
    expect(github.created).toHaveLength(1)
    expect(await db.select().from(groupAssignmentRepos)).toHaveLength(1)

    // Each member granted their own access, with their own token
    expect(github.invited.map((call) => call.login)).toEqual(['primero', 'segundo'])
    expect(github.accepted).toEqual([42, 42])
  })

  it('reports working while a teammate is mid-flight', async () => {
    const fixture = await classroomWithGroupAssignment()
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'lala' })
    const [team] = await db.select().from(groups)
    await acceptGroupInvitation(second, fixture.key, { groupId: team.id })

    // Somebody took the lock and has not finished
    await db.update(groupInviteStatuses).set({ status: 'creating_repo' })

    expect(await createTeamRepository(second, fixture.key)).toEqual({ status: 'working' })
    expect(github.created).toHaveLength(0)
  })

  it('reports unaccepted for a student who is on no team', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('sin-equipo')

    expect(await createTeamRepository(session, fixture.key)).toMatchObject({ status: 'errored' })
    expect(github.created).toHaveLength(0)
  })

  it('takes over a lock left by a request that died', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    await db.update(groupInviteStatuses).set({
      status: 'creating_repo',
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    })

    expect(await createTeamRepository(session, fixture.key)).toMatchObject({
      status: 'completed',
    })
  })
})

describe('createTeamRepository — failures', () => {
  it('treats the secondary rate limit as a wait, and gives the lock back', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    github.failCreate = rateLimitError('30')

    expect(await createTeamRepository(session, fixture.key)).toEqual({
      status: 'retry',
      retryAfter: 30,
    })

    // Back where it was, so the polling that is already running retries
    const [status] = await db.select().from(groupInviteStatuses)
    expect(status.status).toBe('accepted')
  })

  it('rolls back the half-built repository and lets the team retry', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    github.failCreate = new Error('GitHub se cayó')

    expect(await createTeamRepository(session, fixture.key)).toMatchObject({ status: 'errored' })

    const [status] = await db.select().from(groupInviteStatuses)
    expect(status.status).toBe('errored_creating_repo')
    expect(await db.select().from(groupAssignmentRepos)).toHaveLength(0)

    // And the retry button works
    github.failCreate = null
    expect(await createTeamRepository(session, fixture.key)).toMatchObject({ status: 'completed' })
  })
})

describe('claimPendingTeamInvitation', () => {
  it('does nothing while the team has no repository', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    await claimPendingTeamInvitation(session, fixture.key)

    expect(github.invited).toHaveLength(0)
  })

  it('grants access to a member whose request died after the repo was built', async () => {
    const fixture = await classroomWithGroupAssignment()
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'lala' })
    await createTeamRepository(first, fixture.key)

    const [team] = await db.select().from(groups)
    await acceptGroupInvitation(second, fixture.key, { groupId: team.id })
    github.invited = []
    github.accepted = []

    await claimPendingTeamInvitation(second, fixture.key)

    expect(github.invited.map((call) => call.login)).toEqual(['segundo'])
    expect(github.accepted).toEqual([42])
  })

  it('costs nothing when the member already has access', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })
    await createTeamRepository(session, fixture.key)

    // GitHub answers 204 and hands back no invitation for a collaborator
    github.invitationId = null
    github.accepted = []

    await claimPendingTeamInvitation(session, fixture.key)

    expect(github.accepted).toEqual([])
  })
})

describe('findTeamRepository', () => {
  it('returns the repository of the caller’s team, and null once it is gone', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('lazcanoluca')
    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })
    await createTeamRepository(session, fixture.key)

    expect(await findTeamRepository(session, fixture.key)).toMatchObject({
      fullName: 'fiubaTA050-labs/2026a-tp1-lala',
    })

    // The NullGitHubRepository case: deleted on GitHub, the row stays
    const [repo] = await db.select().from(groupAssignmentRepos)
    github.created = github.created.filter((candidate) => candidate.id !== repo.githubRepoId)

    expect(await findTeamRepository(session, fixture.key)).toBeNull()
  })

  it('returns null for a student on no team', async () => {
    const fixture = await classroomWithGroupAssignment()
    const session = await student('sin-equipo')

    expect(await findTeamRepository(session, fixture.key)).toBeNull()
  })
})

describe('the membership rows', () => {
  it('keeps one status row for the whole team', async () => {
    const fixture = await classroomWithGroupAssignment()
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'lala' })
    const [team] = await db.select().from(groups)
    await acceptGroupInvitation(second, fixture.key, { groupId: team.id })
    await createTeamRepository(first, fixture.key)
    await createTeamRepository(second, fixture.key)

    expect(await db.select().from(groupInviteStatuses)).toHaveLength(1)
    expect(
      await db.select().from(groupsUsers).where(eq(groupsUsers.groupId, team.id)),
    ).toHaveLength(2)
  })
})
