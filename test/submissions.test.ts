import { eq, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  checkpoints,
  organizations,
  organizationsUsers,
  submissions,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * The student's confirmed submission. There is no spec to port: the original
 * has no submission of the student's own — its `submission_sha` is written by
 * `DeadlineJob` — so these cases come from the rules in docs/entregas.md.
 *
 * Real Postgres (PGlite) and a stubbed GitHub, the same split as
 * test/repositories.test.ts: what is worth testing here is append-only, the
 * dedupe, the cooldown and the authorization, and all four are database
 * behaviour. Resolving a ref was measured against real GitHub instead.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

/** What the fake GitHub answers, set per test */
const github = {
  /** ref → sha. A ref outside this map does not resolve */
  refs: new Map<string, string>(),
  reachable: true as boolean | null,
  resolveCalls: 0,
}

vi.mock('@/lib/github/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/repositories')>()

  return {
    ...actual,
    resolveRepositoryRef: async (_installationId: number, _repositoryId: number, ref: string) => {
      github.resolveCalls += 1
      const sha = github.refs.get(ref)
      if (!sha) return null

      return {
        fullName: 'fiubaTA050-labs/tp0-alumna',
        defaultBranch: 'main',
        commit: {
          sha,
          committedAt: new Date('2026-09-01T12:00:00Z'),
          messageHeadline: 'Resuelve el punto 3',
        },
      }
    },
    isReachableFromDefaultBranch: async () => github.reachable,
  }
})

const { confirmSubmission, findSubmissionPanel } = await import('@/lib/data/submissions')

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

type Fixture = {
  key: string
  assignmentId: number
  repoId: number
  checkpointId: number | null
}

async function assignmentWithRepo(
  alumna: Session,
  options: {
    deadlineAt?: Date | null
    /** false leaves the assignment with no entrega at all */
    checkpoint?: boolean
    invitationsEnabled?: boolean
    archived?: boolean
  } = {},
): Promise<Fixture> {
  const githubId = nextGithubId++

  const [teacher] = await db
    .insert(users)
    .values({ uid: nextUid++, githubLogin: `profe-${githubId}` })
    .returning({ id: users.id })

  const [classroom] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: `${githubId}`,
      slug: `${githubId}-classroom`,
      archivedAt: options.archived ? new Date() : null,
    })
    .returning({ id: organizations.id })

  await db.insert(organizationsUsers).values({ organizationId: classroom.id, userId: teacher.id })

  const [assignment] = await db
    .insert(assignments)
    .values({
      organizationId: classroom.id,
      creatorId: teacher.id,
      title: `TP ${githubId}`,
      slug: `tp-${githubId}`,
      invitationsEnabled: options.invitationsEnabled ?? true,
    })
    .returning({ id: assignments.id })

  const key = `key-${githubId}`
  await db.insert(assignmentInvitations).values({ assignmentId: assignment.id, key })

  const [repo] = await db
    .insert(assignmentRepos)
    .values({
      assignmentId: assignment.id,
      userId: Number(alumna.user.id),
      githubRepoId: githubId * 10,
    })
    .returning({ id: assignmentRepos.id })

  let checkpointId: number | null = null
  if (options.checkpoint !== false) {
    const [checkpoint] = await db
      .insert(checkpoints)
      .values({
        assignmentId: assignment.id,
        title: null,
        deadlineAt: options.deadlineAt ?? null,
      })
      .returning({ id: checkpoints.id })
    checkpointId = checkpoint.id
  }

  return { key, assignmentId: assignment.id, repoId: repo.id, checkpointId }
}

/** Moves the last confirmation into the past, so the cooldown is not what answers */
async function ageLastSubmission(): Promise<void> {
  await db.execute(sql`update submissions set submitted_at = now() - interval '1 minute'`)
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
  github.refs = new Map([
    ['main', 'a'.repeat(40)],
    ['v1', 'b'.repeat(40)],
    ['entrega-final', 'c'.repeat(40)],
  ])
  github.reachable = true
  github.resolveCalls = 0
})

describe('confirmSubmission', () => {
  it('freezes the resolved sha and keeps what the student typed', async () => {
    const alumna = await student('alumna')
    const { key, repoId, checkpointId } = await assignmentWithRepo(alumna)

    const result = await confirmSubmission(alumna, key, 'main')

    expect(result).toMatchObject({ success: true, sha: 'a'.repeat(40), unchanged: false })

    const rows = await db.select().from(submissions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      assignmentRepoId: repoId,
      checkpointId,
      sha: 'a'.repeat(40),
      // The ref is evidence of intent, the sha is what gets graded
      ref: 'main',
      submittedByUserId: Number(alumna.user.id),
    })
    expect(rows[0].committedAt).toEqual(new Date('2026-09-01T12:00:00Z'))
  })

  it('appends a row per confirmation instead of overwriting', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)

    await confirmSubmission(alumna, key, 'main')
    await ageLastSubmission()
    await confirmSubmission(alumna, key, 'entrega-final')

    const rows = await db.select().from(submissions).orderBy(submissions.id)
    expect(rows.map((row) => row.ref)).toEqual(['main', 'entrega-final'])
  })

  it('does not insert when the sha is the one already handed in', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)

    await confirmSubmission(alumna, key, 'main')
    await ageLastSubmission()

    // A different ref resolving to the same commit is the same submission
    github.refs.set('HEAD', 'a'.repeat(40))
    const again = await confirmSubmission(alumna, key, 'HEAD')

    expect(again).toMatchObject({ success: true, unchanged: true })
    expect(await db.select().from(submissions)).toHaveLength(1)
  })

  it('writes nothing when the ref does not resolve', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)

    const result = await confirmSubmission(alumna, key, 'no-existe')

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(submissions)).toHaveLength(0)
  })

  it('rejects a blank ref before asking GitHub anything', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)

    const result = await confirmSubmission(alumna, key, '   ')

    expect(result).toMatchObject({ success: false })
    expect(github.resolveCalls).toBe(0)
  })

  it('accepts a late submission and marks it, because the deadline closes nothing', async () => {
    const alumna = await student('alumna')
    const deadlineAt = new Date(Date.now() - 60_000)
    const { key } = await assignmentWithRepo(alumna, { deadlineAt })

    const result = await confirmSubmission(alumna, key, 'main')
    expect(result).toMatchObject({ success: true })

    const panel = await findSubmissionPanel(alumna, key)
    expect(panel?.current?.late).toBe(true)
  })

  it('does not mark a submission made before the deadline', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna, {
      deadlineAt: new Date(Date.now() + 3_600_000),
    })

    await confirmSubmission(alumna, key, 'main')

    const panel = await findSubmissionPanel(alumna, key)
    expect(panel?.current?.late).toBe(false)
  })

  it('refuses while the assignment is inactive', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna, { invitationsEnabled: false })

    expect(await confirmSubmission(alumna, key, 'main')).toMatchObject({ success: false })
    expect(await db.select().from(submissions)).toHaveLength(0)
  })

  it('refuses in an archived classroom', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna, { archived: true })

    expect(await confirmSubmission(alumna, key, 'main')).toMatchObject({ success: false })
  })

  it('refuses when the assignment has no entrega at all', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna, { checkpoint: false })

    const result = await confirmSubmission(alumna, key, 'main')

    expect(result).toMatchObject({ success: false })
    expect(github.resolveCalls).toBe(0)
  })

  it('holds a second confirmation inside the cooldown', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)

    await confirmSubmission(alumna, key, 'main')
    // A different sha, so the dedupe is not what answers — this is the case
    // the dedupe cannot cover: a script that commits before each confirmation
    const second = await confirmSubmission(alumna, key, 'v1')

    expect(second).toMatchObject({ success: false })
    expect(await db.select().from(submissions)).toHaveLength(1)
  })

  it('warns, without refusing, when the commit is outside the default branch', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)
    github.reachable = false

    const result = await confirmSubmission(alumna, key, 'v1')

    expect(result).toMatchObject({ success: true })
    expect(result.success && result.warning).toContain('main')
    expect(await db.select().from(submissions)).toHaveLength(1)
  })

  it('says nothing when GitHub cannot tell where the commit is', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)
    github.reachable = null

    const result = await confirmSubmission(alumna, key, 'v1')

    expect(result).toMatchObject({ success: true, warning: null })
  })

  it('does not let a student confirm on somebody else’s repository', async () => {
    const alumna = await student('alumna')
    const otro = await student('otro')
    const { key } = await assignmentWithRepo(alumna)

    // Same invitation key, a different signed-in user: there is no repo row of
    // theirs, so there is nothing to confirm against
    const result = await confirmSubmission(otro, key, 'main')

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(submissions)).toHaveLength(0)
  })
})

describe('findSubmissionPanel', () => {
  it('puts the newest submission first and keeps the whole history', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna)

    await confirmSubmission(alumna, key, 'main')
    await ageLastSubmission()
    await confirmSubmission(alumna, key, 'v1')

    const panel = await findSubmissionPanel(alumna, key)

    expect(panel?.current?.ref).toBe('v1')
    expect(panel?.history.map((row) => row.ref)).toEqual(['v1', 'main'])
  })

  it('reports the assignment with no entrega as having no checkpoint', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna, { checkpoint: false })

    const panel = await findSubmissionPanel(alumna, key)

    expect(panel).toMatchObject({ hasCheckpoint: false, current: null, enabled: true })
  })

  it('carries the reason the entrega is closed', async () => {
    const alumna = await student('alumna')
    const { key } = await assignmentWithRepo(alumna, { invitationsEnabled: false })

    const panel = await findSubmissionPanel(alumna, key)

    expect(panel?.enabled).toBe(false)
    expect(panel?.disabledReason).toBeTruthy()
  })

  it('shows one student nothing of another', async () => {
    const alumna = await student('alumna')
    const otro = await student('otro')
    const { key } = await assignmentWithRepo(alumna)

    await confirmSubmission(alumna, key, 'main')

    const panel = await findSubmissionPanel(otro, key)
    expect(panel?.current).toBeNull()
    expect(panel?.history).toEqual([])
  })

  it('returns null for an invitation that does not exist', async () => {
    const alumna = await student('alumna')
    await assignmentWithRepo(alumna)

    expect(await findSubmissionPanel(alumna, 'no-existe')).toBeNull()
  })

  it('survives the deleted assignment, which is what the soft delete promises', async () => {
    const alumna = await student('alumna')
    const { key, assignmentId } = await assignmentWithRepo(alumna)

    await db.update(assignments).set({ deletedAt: new Date() }).where(eq(assignments.id, assignmentId))

    expect(await findSubmissionPanel(alumna, key)).toBeNull()
  })
})
