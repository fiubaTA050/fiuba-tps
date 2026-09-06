import { and, eq, isNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apiKeys,
  assignmentRepos,
  assignments,
  checkpoints,
  gradingRuns,
  organizations,
  organizationsUsers,
  submissions,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * The grading worker's lease query. No spec to port — see grading.ts's own
 * header on why there is no original equivalent.
 *
 * Real Postgres (PGlite) for the eligibility logic — the attempt cap, the
 * FIFO order, the append-only "current submission" read — and a stubbed
 * GitHub for the repo/token half, same split as test/submissions.test.ts.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const github = {
  repos: new Map<number, { owner: string; name: string } | null>(),
  tokenCalls: 0,
}

vi.mock('@/lib/github/client', () => ({
  mintRepositoryScopedToken: async () => {
    github.tokenCalls += 1
    return { token: `scoped-token-${github.tokenCalls}`, expiresAt: new Date(Date.now() + 3_600_000) }
  },
}))

vi.mock('@/lib/github/repositories', () => ({
  findRepositoryOwnerAndName: async (_installationId: number, repositoryId: number) => {
    if (github.repos.has(repositoryId)) return github.repos.get(repositoryId)!
    return { owner: 'fiubaTA050-labs', name: `repo-${repositoryId}` }
  },
}))

const { leaseSubmissionForGrading } = await import('@/lib/data/grading')

let nextGithubId = 1000

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextGithubId = 1000
  github.repos.clear()
  github.tokenCalls = 0
})

async function teacher(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ uid: nextGithubId, githubLogin: `profe-${nextGithubId++}` })
    .returning({ id: users.id })
  return row.id
}

/** A real row, since `grading_runs.api_key_id` is a foreign key */
async function apiKey(userId: number): Promise<number> {
  const [row] = await db
    .insert(apiKeys)
    .values({ userId, label: 'test', keyHash: `hash-${nextGithubId++}`, scopes: ['grading'] })
    .returning({ id: apiKeys.id })
  return row.id
}

async function student(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ uid: nextGithubId, githubLogin: `alumna-${nextGithubId++}` })
    .returning({ id: users.id })
  return row.id
}

async function classroom(teacherId: number): Promise<number> {
  const githubId = nextGithubId++
  const [org] = await db
    .insert(organizations)
    .values({ githubId, installationId: githubId, title: `${githubId}`, slug: `${githubId}-classroom` })
    .returning({ id: organizations.id })

  await db.insert(organizationsUsers).values({ organizationId: org.id, userId: teacherId })
  return org.id
}

async function gradableAssignment(organizationId: number, teacherId: number): Promise<number> {
  const [assignment] = await db
    .insert(assignments)
    .values({
      organizationId,
      creatorId: teacherId,
      title: `TP ${nextGithubId}`,
      slug: `tp-${nextGithubId++}`,
    })
    .returning({ id: assignments.id })
  return assignment.id
}

/**
 * The one unnamed checkpoint of an assignment — unique per assignment, so
 * shared across its repos. Defaults to `autograderId: 'tp1'` and `closed:
 * true` (eligible), matching what most tests here want; only the tests that
 * exercise those two conditions override them.
 */
async function openCheckpoint(
  assignmentId: number,
  options: { autograderId?: string | null; closed?: boolean } = {},
): Promise<number> {
  // `??` would treat an explicit `null` the same as "not passed" — has to be undefined-only
  const autograderId = options.autograderId === undefined ? 'tp1' : options.autograderId
  const closedAt = (options.closed ?? true) ? new Date() : null

  const [checkpoint] = await db
    .insert(checkpoints)
    .values({ assignmentId, title: null, autograderId, closedAt })
    .onConflictDoNothing()
    .returning({ id: checkpoints.id })

  if (checkpoint) return checkpoint.id

  const [existing] = await db
    .select({ id: checkpoints.id })
    .from(checkpoints)
    .where(and(eq(checkpoints.assignmentId, assignmentId), isNull(checkpoints.title)))
  return existing.id
}

/** One repo, one confirmed submission on the assignment's checkpoint — the unit these tests grade */
async function submittedRepo(
  assignmentId: number,
  studentId: number,
  options: {
    sha?: string
    submittedAt?: Date
    autograderId?: string | null
    closed?: boolean
  } = {},
): Promise<{ githubRepoId: number; submissionId: number }> {
  const githubRepoId = nextGithubId++
  const [repo] = await db
    .insert(assignmentRepos)
    .values({ assignmentId, userId: studentId, githubRepoId })
    .returning({ id: assignmentRepos.id })

  const checkpointId = await openCheckpoint(assignmentId, {
    autograderId: options.autograderId,
    closed: options.closed,
  })

  const [submission] = await db
    .insert(submissions)
    .values({
      assignmentRepoId: repo.id,
      checkpointId,
      sha: options.sha ?? '1'.repeat(40),
      ref: 'main',
      committedAt: options.submittedAt ?? new Date('2026-09-01T00:00:00Z'),
      submittedAt: options.submittedAt ?? new Date('2026-09-01T00:00:00Z'),
      submittedByUserId: studentId,
    })
    .returning({ id: submissions.id })

  return { githubRepoId, submissionId: submission.id }
}

describe('leaseSubmissionForGrading', () => {
  it('returns null when the user teaches no classroom', async () => {
    const profe = await teacher()
    expect(await leaseSubmissionForGrading(profe, 1)).toBeNull()
  })

  it('returns null when no checkpoint has autograderId set', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    await submittedRepo(assignment, alumna, { autograderId: null })

    expect(await leaseSubmissionForGrading(profe, 1)).toBeNull()
  })

  it('returns null when the checkpoint has autograderId but is not closed', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    await submittedRepo(assignment, alumna, { autograderId: 'tp1', closed: false })

    expect(await leaseSubmissionForGrading(profe, 1)).toBeNull()
  })

  it('leases the only eligible submission and inserts a leased row', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    const { githubRepoId, submissionId } = await submittedRepo(assignment, alumna, {
      sha: 'a'.repeat(40),
    })

    const keyId = await apiKey(profe)
    const lease = await leaseSubmissionForGrading(profe, keyId)

    expect(lease).toMatchObject({
      sha: 'a'.repeat(40),
      autograderId: 'tp1',
      repo: { owner: 'fiubaTA050-labs', name: `repo-${githubRepoId}` },
    })
    expect(lease!.token).toMatch(/^scoped-token-/)

    const [row] = await db.select().from(gradingRuns).where(eq(gradingRuns.id, lease!.leaseId))
    expect(row).toMatchObject({ submissionId, apiKeyId: keyId, status: 'leased' })
  })

  it('does not lease a submission with a succeeded attempt', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    const { submissionId } = await submittedRepo(assignment, alumna)

    await db.insert(gradingRuns).values({
      submissionId,
      status: 'succeeded',
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    expect(await leaseSubmissionForGrading(profe, 1)).toBeNull()
  })

  it('does not lease a submission with an active (non-expired) lease', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    const { submissionId } = await submittedRepo(assignment, alumna)

    await db.insert(gradingRuns).values({
      submissionId,
      status: 'leased',
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    expect(await leaseSubmissionForGrading(profe, 1)).toBeNull()
  })

  it('re-offers a submission whose only lease already expired', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    const { submissionId } = await submittedRepo(assignment, alumna)

    await db.insert(gradingRuns).values({
      submissionId,
      status: 'leased',
      expiresAt: new Date(Date.now() - 1_000),
    })

    const lease = await leaseSubmissionForGrading(profe, await apiKey(profe))
    expect(lease).not.toBeNull()
  })

  it('stops offering a submission after 3 attempts with none succeeded', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    const { submissionId } = await submittedRepo(assignment, alumna)

    for (let i = 0; i < 3; i++) {
      await db.insert(gradingRuns).values({
        submissionId,
        status: 'failed',
        expiresAt: new Date(Date.now() - 1_000),
      })
    }

    expect(await leaseSubmissionForGrading(profe, 1)).toBeNull()
  })

  it('offers the oldest eligible submission first (FIFO)', async () => {
    const profe = await teacher()
    const alumnaA = await student()
    const alumnaB = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)

    // Two different students: a repo is one per (assignment, student)
    const newer = await submittedRepo(assignment, alumnaA, {
      sha: 'a'.repeat(40),
      submittedAt: new Date('2026-09-02T00:00:00Z'),
    })
    const older = await submittedRepo(assignment, alumnaB, {
      sha: 'b'.repeat(40),
      submittedAt: new Date('2026-09-01T00:00:00Z'),
    })

    const lease = await leaseSubmissionForGrading(profe, await apiKey(profe))
    expect(lease?.sha).toBe('b'.repeat(40))

    const [row] = await db.select().from(gradingRuns).where(eq(gradingRuns.submissionId, older.submissionId))
    expect(row).toBeDefined()

    const newerRuns = await db
      .select()
      .from(gradingRuns)
      .where(eq(gradingRuns.submissionId, newer.submissionId))
    expect(newerRuns).toHaveLength(0)
  })

  it('never leases another teacher\'s classroom', async () => {
    const profeA = await teacher()
    const profeB = await teacher()
    const alumna = await student()
    const orgB = await classroom(profeB)
    const assignment = await gradableAssignment(orgB, profeB)
    await submittedRepo(assignment, alumna)

    expect(await leaseSubmissionForGrading(profeA, 1)).toBeNull()
  })

  it('writes nothing when the repository cannot be resolved on GitHub', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    const { githubRepoId, submissionId } = await submittedRepo(assignment, alumna)
    github.repos.set(githubRepoId, null)

    expect(await leaseSubmissionForGrading(profe, 1)).toBeNull()

    const runs = await db.select().from(gradingRuns).where(eq(gradingRuns.submissionId, submissionId))
    expect(runs).toHaveLength(0)
  })
})
