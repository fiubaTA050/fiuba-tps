import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  inviteStatuses,
  organizations,
  organizationsUsers,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of spec/services/create_github_repo_service_spec.rb and of the
 * `POST #create_repo` cases of
 * spec/controllers/assignment_invitations_controller_spec.rb.
 *
 * The original's specs went through VCR cassettes against real GitHub. Here
 * the GitHub module is stubbed and the database is real (PGlite), which is the
 * split that matters: the parts worth testing are the lock, the compensating
 * rollback and the rate-limit branch, and all three are database behaviour.
 * The GitHub calls themselves were measured for real instead — see
 * docs/creacion-de-repos.md.
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

/** What the fake GitHub does on the next call, set per test */
const github = {
  created: [] as { id: number; fullName: string }[],
  deleted: [] as string[],
  accepted: [] as number[],
  existingNames: new Set<string>(),
  nextRepoId: 5000,
  failCreate: null as unknown,
  failCollaborator: null as unknown,
  /** null = 204, a number = 201 with that invitation id */
  invitationId: 42 as number | null,
}

vi.mock('@/lib/github/repositories', async (importOriginal) => {
  // `secondaryRateLimitDelay` is pure and is exactly what these tests exercise,
  // so it comes from the real module rather than being reimplemented here.
  const actual = await importOriginal<typeof import('@/lib/github/repositories')>()

  return {
    ...actual,
    createRepositoryFromTemplate: async (
      _installationId: number,
      input: { owner: string; name: string },
    ) => {
      if (github.failCreate) throw github.failCreate
      const repo = { id: (github.nextRepoId += 1), fullName: `${input.owner}/${input.name}` }
      github.created.push(repo)
      github.existingNames.add(repo.fullName)
      return { ...repo, htmlUrl: `https://github.com/${repo.fullName}`, private: true, isTemplate: false }
    },
    createRepository: async (_installationId: number, input: { owner: string; name: string }) => {
      if (github.failCreate) throw github.failCreate
      const repo = { id: (github.nextRepoId += 1), fullName: `${input.owner}/${input.name}` }
      github.created.push(repo)
      github.existingNames.add(repo.fullName)
      return { ...repo, htmlUrl: `https://github.com/${repo.fullName}`, private: true, isTemplate: false }
    },
    deleteRepository: async (_installationId: number, fullName: string) => {
      github.deleted.push(fullName)
      github.existingNames.delete(fullName)
    },
    addCollaborator: async () => {
      if (github.failCollaborator) throw github.failCollaborator
      return github.invitationId
    },
    acceptRepositoryInvitation: async (_session: Session, invitationId: number) => {
      github.accepted.push(invitationId)
    },
    repositoryExists: async (_installationId: number, fullName: string) =>
      github.existingNames.has(fullName),
    findRepositoryById: async (_installationId: number, id: number) => {
      const repo = github.created.find((candidate) => candidate.id === id)
      // The template lookup, and the NullGitHubRepository case for a deleted one
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

const { createStudentRepository } = await import('@/lib/data/repositories')
const { acceptInvitation } = await import('@/lib/data/invitations')

let nextUid = 1
let nextGithubId = 1000

async function student(login: string): Promise<Session> {
  const uid = nextUid++
  const [user] = await db.insert(users).values({ uid, githubLogin: login }).returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: login },
  } as Session
}

async function classroomWithAssignment(
  teacher: Session,
  options: { starterCode?: boolean; admins?: boolean } = {},
) {
  const githubId = nextGithubId++

  const [classroom] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: `${githubId}`,
      slug: `${githubId}-classroom`,
    })
    .returning({ id: organizations.id, slug: organizations.slug })

  await db
    .insert(organizationsUsers)
    .values({ organizationId: classroom.id, userId: Number(teacher.user.id) })

  const [assignment] = await db
    .insert(assignments)
    .values({
      organizationId: classroom.id,
      creatorId: Number(teacher.user.id),
      title: 'TP0',
      slug: 'tp0',
      starterCodeRepoId: options.starterCode === false ? null : TEMPLATE_ID,
      studentsAreRepoAdmins: options.admins ?? false,
    })
    .returning({ id: assignments.id })

  const key = `key-${githubId}`
  await db.insert(assignmentInvitations).values({ assignmentId: assignment.id, key })

  return { classroom, assignmentId: assignment.id, key }
}

/** A 403 shaped like GitHub's secondary rate limit answer */
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
  github.existingNames = new Set()
  github.nextRepoId = 5000
  github.failCreate = null
  github.failCollaborator = null
  github.invitationId = 42
})

describe('createStudentRepository', () => {
  it('creates the repo, records it and completes', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key, assignmentId } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    const result = await createStudentRepository(alumno, key)

    expect(result).toEqual({
      status: 'completed',
      repoUrl: 'https://github.com/fiubaTA050-labs/tp0-ana',
    })

    const [repo] = await db
      .select()
      .from(assignmentRepos)
      .where(eq(assignmentRepos.assignmentId, assignmentId))
    expect(repo.userId).toBe(Number(alumno.user.id))

    const [status] = await db.select().from(inviteStatuses)
    expect(status.status).toBe('completed')
  })

  // add_user_to_github_repository!, the half that needs the student's token
  it('accepts the repository invitation on the student behalf', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    await createStudentRepository(alumno, key)

    expect(github.accepted).toEqual([42])
  })

  // 204: an org owner testing their own assignment already has access
  it('does not accept anything when GitHub reports no invitation', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    github.invitationId = null
    await createStudentRepository(alumno, key)

    expect(github.accepted).toEqual([])
  })

  // Exercise#generate_repo_name / #suffixed_repo_name
  it('suffixes the name when it is already taken', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    github.existingNames.add('fiubaTA050-labs/tp0-ana')

    const result = await createStudentRepository(alumno, key)

    expect(result).toEqual({
      status: 'completed',
      repoUrl: 'https://github.com/fiubaTA050-labs/tp0-ana-1',
    })
  })

  // `redeem_for` returning :success when an AssignmentRepo already exists
  it('is idempotent: a second call returns the same repo without building one', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    const first = await createStudentRepository(alumno, key)
    const second = await createStudentRepository(alumno, key)

    expect(second).toEqual(first)
    expect(github.created).toHaveLength(1)
  })

  // The `return unless status.waiting?` guard of the original's job, tightened
  // into one conditional UPDATE
  it('refuses to start while another request holds the lock', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    await db.update(inviteStatuses).set({ status: 'creating_repo' })

    expect(await createStudentRepository(alumno, key)).toEqual({ status: 'working' })
    expect(github.created).toEqual([])
  })

  it('refuses to build for somebody who never accepted', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)

    const result = await createStudentRepository(alumno, key)

    expect(result.status).toBe('errored')
    expect(github.created).toEqual([])
  })

  /**
   * The `rescue Result::Error` of CreateGitHubRepoService#perform, which calls
   * `delete_github_repository` so a half-built repo does not survive.
   */
  it('deletes the repo and marks the error when a later step fails', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    github.failCollaborator = new Error('Boom')

    const result = await createStudentRepository(alumno, key)

    expect(result).toEqual({ status: 'errored', error: 'Boom' })
    expect(github.deleted).toEqual(['fiubaTA050-labs/tp0-ana'])
    expect(await db.select().from(assignmentRepos)).toEqual([])

    const [status] = await db.select().from(inviteStatuses)
    expect(status.status).toBe('errored_creating_repo')
  })

  // `create_repo` starting from an errored state is what the retry button is
  it('can be retried after an error', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    github.failCollaborator = new Error('Boom')
    await createStudentRepository(alumno, key)

    github.failCollaborator = null
    const result = await createStudentRepository(alumno, key)

    expect(result.status).toBe('completed')
    const [status] = await db.select().from(inviteStatuses)
    expect(status.status).toBe('completed')
  })

  /**
   * The branch the original does not have: GitHub's secondary rate limit is a
   * wait, not a failure. The lock has to go back so the student's own polling
   * can retry. See docs/creacion-de-repos.md.
   */
  it('gives the lock back and reports retryAfter on a secondary rate limit', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    github.failCreate = rateLimitError('37')

    expect(await createStudentRepository(alumno, key)).toEqual({ status: 'retry', retryAfter: 37 })

    // Back to `accepted`, so the retry is allowed to take the lock again
    const [status] = await db.select().from(inviteStatuses)
    expect(status.status).toBe('accepted')

    github.failCreate = null
    expect((await createStudentRepository(alumno, key)).status).toBe('completed')
  })

  // "otherwise, wait for at least one minute before retrying"
  it('falls back to a minute when GitHub sends no retry-after', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    github.failCreate = rateLimitError()

    expect(await createStudentRepository(alumno, key)).toEqual({ status: 'retry', retryAfter: 60 })
  })

  // A plain permission 403 must not be mistaken for "slow down"
  it('treats a permission 403 as an error, not a wait', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    github.failCreate = Object.assign(new Error('Resource not accessible by integration'), {
      status: 403,
      response: { headers: {} },
    })

    const result = await createStudentRepository(alumno, key)

    expect(result.status).toBe('errored')
    const [status] = await db.select().from(inviteStatuses)
    expect(status.status).toBe('errored_creating_repo')
  })

  it('builds an empty repo when the assignment has no starter code', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key } = await classroomWithAssignment(teacher, { starterCode: false })
    await acceptInvitation(alumno, key)

    expect((await createStudentRepository(alumno, key)).status).toBe('completed')
    expect(github.created).toHaveLength(1)
  })

  // AssignmentInvitation#enabled?, revalidated at build time
  it('refuses once the classroom is archived', async () => {
    const teacher = await student('docente')
    const alumno = await student('ana')
    const { key, classroom } = await classroomWithAssignment(teacher)
    await acceptInvitation(alumno, key)

    await db
      .update(organizations)
      .set({ archivedAt: new Date() })
      .where(eq(organizations.id, classroom.id))

    expect((await createStudentRepository(alumno, key)).status).toBe('errored')
    expect(github.created).toEqual([])
  })

  it('gives each student their own repo', async () => {
    const teacher = await student('docente')
    const ana = await student('ana')
    const juan = await student('juan')
    const { key } = await classroomWithAssignment(teacher)

    await acceptInvitation(ana, key)
    await acceptInvitation(juan, key)

    await createStudentRepository(ana, key)
    await createStudentRepository(juan, key)

    expect(github.created.map((repo) => repo.fullName)).toEqual([
      'fiubaTA050-labs/tp0-ana',
      'fiubaTA050-labs/tp0-juan',
    ])
    expect(await db.select().from(assignmentRepos)).toHaveLength(2)
  })
})
