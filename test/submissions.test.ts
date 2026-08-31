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

const { confirmSubmission, findSubmissionPanel, findSubmissionHistory, listAssignmentSubmissions } =
  await import('@/lib/data/submissions')

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

/**
 * The teacher-facing fixtures — a classroom, an assignment, a repo owned by
 * some student and an open checkpoint — shared by `listAssignmentSubmissions`
 * and `findSubmissionHistory`, which read the same tables from the docente's
 * side rather than a single student's own.
 */
async function classroomWithAssignment(
  profe: Session,
): Promise<{ classroomSlug: string; assignmentSlug: string; assignmentId: number }> {
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
    .values({ organizationId: classroom.id, userId: Number(profe.user.id) })

  const [assignment] = await db
    .insert(assignments)
    .values({
      organizationId: classroom.id,
      creatorId: Number(profe.user.id),
      title: `TP ${githubId}`,
      slug: `tp-${githubId}`,
    })
    .returning({ id: assignments.id, slug: assignments.slug })

  return {
    classroomSlug: classroom.slug,
    assignmentSlug: assignment.slug,
    assignmentId: assignment.id,
  }
}

async function repoFor(
  assignmentId: number,
  owner: Session,
): Promise<{ repoId: number; githubRepoId: number }> {
  const githubRepoId = nextGithubId++
  const [repo] = await db
    .insert(assignmentRepos)
    .values({ assignmentId, userId: Number(owner.user.id), githubRepoId })
    .returning({ id: assignmentRepos.id })

  return { repoId: repo.id, githubRepoId }
}

async function openCheckpoint(assignmentId: number, deadlineAt: Date | null = null): Promise<number> {
  const [checkpoint] = await db
    .insert(checkpoints)
    .values({ assignmentId, title: null, deadlineAt })
    .returning({ id: checkpoints.id })

  return checkpoint.id
}

async function submit(
  repoId: number,
  checkpointId: number,
  by: Session,
  sha: string,
  submittedAt?: Date,
): Promise<void> {
  await db.insert(submissions).values({
    assignmentRepoId: repoId,
    checkpointId,
    sha,
    ref: 'main',
    committedAt: submittedAt ?? new Date(),
    ...(submittedAt ? { submittedAt } : {}),
    submittedByUserId: Number(by.user.id),
  })
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

/**
 * The cohort-wide read for the teacher dashboard: every repo's current
 * submission on the assignment's single checkpoint, in one query. No spec to
 * port — this is new. Serves the `distinct on` that
 * `index_submissions_on_repo_and_checkpoint`'s comment anticipates.
 */
describe('listAssignmentSubmissions', () => {
  it('keys the map by the github repo id, leaving out repos that never confirmed', async () => {
    const profe = await student('profe')
    const alumna1 = await student('alumna1')
    const alumna2 = await student('alumna2')
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)
    const checkpointId = await openCheckpoint(assignmentId)
    const repo1 = await repoFor(assignmentId, alumna1)
    const repo2 = await repoFor(assignmentId, alumna2)

    await submit(repo1.repoId, checkpointId, alumna1, 'a'.repeat(40))

    const result = await listAssignmentSubmissions(profe, classroomSlug, assignmentSlug)

    expect(result?.byRepoId.get(repo1.githubRepoId)).toMatchObject({ sha: 'a'.repeat(40), late: false })
    expect(result?.byRepoId.has(repo2.githubRepoId)).toBe(false)
  })

  it("marks late by comparing to the checkpoint's own deadline", async () => {
    const profe = await student('profe')
    const alumna = await student('alumna')
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)
    const deadlineAt = new Date('2026-09-11T02:59:00Z')
    const checkpointId = await openCheckpoint(assignmentId, deadlineAt)
    const { repoId, githubRepoId } = await repoFor(assignmentId, alumna)

    await submit(repoId, checkpointId, alumna, 'a'.repeat(40), new Date('2026-09-12T00:00:00Z'))

    const result = await listAssignmentSubmissions(profe, classroomSlug, assignmentSlug)

    expect(result?.byRepoId.get(githubRepoId)?.late).toBe(true)
  })

  it('keeps the latest row by id on a re-submission, not by submitted_at', async () => {
    const profe = await student('profe')
    const alumna = await student('alumna')
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)
    const checkpointId = await openCheckpoint(assignmentId)
    const { repoId, githubRepoId } = await repoFor(assignmentId, alumna)

    await submit(repoId, checkpointId, alumna, 'a'.repeat(40), new Date('2026-09-10T00:00:00Z'))
    // Deliberately timestamped earlier than the first — append-only means the
    // serial id breaks the tie, not submitted_at
    await submit(repoId, checkpointId, alumna, 'b'.repeat(40), new Date('2026-09-01T00:00:00Z'))

    const result = await listAssignmentSubmissions(profe, classroomSlug, assignmentSlug)

    expect(result?.byRepoId.get(githubRepoId)?.sha).toBe('b'.repeat(40))
  })

  it('reports no checkpoint as an empty map, not an error', async () => {
    const profe = await student('profe')
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await listAssignmentSubmissions(profe, classroomSlug, assignmentSlug)

    expect(result).toEqual({ checkpoint: null, byRepoId: new Map() })
  })

  it('does not let a teacher of another classroom read it', async () => {
    const profe = await student('profe')
    const ajeno = await student('ajeno')
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    expect(await listAssignmentSubmissions(ajeno, classroomSlug, assignmentSlug)).toBeNull()
  })
})

/**
 * The per-row read for the teacher dashboard's "Ver entregas anteriores"
 * disclosure — fetched on demand for one repo, not eagerly for the whole
 * cohort. No spec to port — this is new.
 */
describe('findSubmissionHistory', () => {
  it('returns every confirmation for that repo, newest first, with late marked', async () => {
    const profe = await student('profe')
    const alumna = await student('alumna')
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)
    const deadlineAt = new Date('2026-09-11T02:59:00Z')
    const checkpointId = await openCheckpoint(assignmentId, deadlineAt)
    const { repoId, githubRepoId } = await repoFor(assignmentId, alumna)

    await submit(repoId, checkpointId, alumna, 'a'.repeat(40), new Date('2026-09-10T00:00:00Z'))
    await submit(repoId, checkpointId, alumna, 'b'.repeat(40), new Date('2026-09-12T00:00:00Z'))

    const history = await findSubmissionHistory(profe, classroomSlug, assignmentSlug, githubRepoId)

    expect(history).toMatchObject([
      { sha: 'b'.repeat(40), late: true },
      { sha: 'a'.repeat(40), late: false },
    ])
  })

  it('returns an empty list for a repo that never confirmed', async () => {
    const profe = await student('profe')
    const alumna = await student('alumna')
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)
    // A repo exists and a checkpoint is open, but nobody confirmed anything
    await openCheckpoint(assignmentId)
    const { githubRepoId } = await repoFor(assignmentId, alumna)

    expect(await findSubmissionHistory(profe, classroomSlug, assignmentSlug, githubRepoId)).toEqual([])
  })

  it('returns an empty list when the assignment has no entrega at all', async () => {
    const profe = await student('profe')
    const alumna = await student('alumna')
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)
    const { githubRepoId } = await repoFor(assignmentId, alumna)

    expect(await findSubmissionHistory(profe, classroomSlug, assignmentSlug, githubRepoId)).toEqual([])
  })

  it('returns an empty list for a repo id that is not this assignment\'s', async () => {
    const profe = await student('profe')
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    expect(
      await findSubmissionHistory(profe, classroomSlug, assignmentSlug, 999_999_999),
    ).toEqual([])
  })

  it('does not let a teacher of another classroom read it', async () => {
    const profe = await student('profe')
    const ajeno = await student('ajeno')
    const alumna = await student('alumna')
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)
    const checkpointId = await openCheckpoint(assignmentId)
    const { repoId, githubRepoId } = await repoFor(assignmentId, alumna)
    await submit(repoId, checkpointId, alumna, 'a'.repeat(40))

    expect(await findSubmissionHistory(ajeno, classroomSlug, assignmentSlug, githubRepoId)).toBeNull()
  })
})
