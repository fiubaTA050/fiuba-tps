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
 * The two grading endpoints end to end (route → lib/data/grading.ts → a real
 * database), with GitHub stubbed — same split as test/grading.test.ts, which
 * covers the eligibility logic in more depth. These tests are about the HTTP
 * boundary: auth, status codes, and the request/response shapes.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

vi.mock('@/lib/github/client', () => ({
  mintRepositoryScopedToken: async () => ({
    token: 'scoped-token',
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
}))

vi.mock('@/lib/github/repositories', () => ({
  findRepositoryOwnerAndName: async (_installationId: number, repositoryId: number) => ({
    owner: 'fiubaTA050-labs',
    name: `repo-${repositoryId}`,
  }),
}))

const { POST: leaseRoute } = await import('@/app/api/grading/lease/route')
const { POST: resultRoute } = await import('@/app/api/grading/lease/[id]/result/route')

let nextId = 1000

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextId = 1000
})

async function teacher(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ uid: nextId, githubLogin: `profe-${nextId++}` })
    .returning({ id: users.id })
  return row.id
}

async function student(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ uid: nextId, githubLogin: `alumna-${nextId++}` })
    .returning({ id: users.id })
  return row.id
}

async function apiKey(userId: number, scopes = ['grading']): Promise<{ id: number; rawKey: string }> {
  const rawKey = `raw-${nextId++}`
  const { createHash } = await import('node:crypto')
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      label: 'test',
      keyHash: createHash('sha256').update(rawKey).digest('hex'),
      scopes,
    })
    .returning({ id: apiKeys.id })
  return { id: row.id, rawKey }
}

async function classroom(teacherId: number): Promise<number> {
  const githubId = nextId++
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
      title: `TP ${nextId}`,
      slug: `tp-${nextId++}`,
    })
    .returning({ id: assignments.id })
  return assignment.id
}

async function submittedRepo(assignmentId: number, studentId: number): Promise<{ submissionId: number }> {
  const githubRepoId = nextId++
  const [repo] = await db
    .insert(assignmentRepos)
    .values({ assignmentId, userId: studentId, githubRepoId })
    .returning({ id: assignmentRepos.id })

  let [checkpoint] = await db
    .select({ id: checkpoints.id })
    .from(checkpoints)
    .where(and(eq(checkpoints.assignmentId, assignmentId), isNull(checkpoints.title)))
  if (!checkpoint) {
    ;[checkpoint] = await db
      .insert(checkpoints)
      .values({ assignmentId, title: null, autograderId: 'tp1', closedAt: new Date() })
      .returning({ id: checkpoints.id })
  }

  const [submission] = await db
    .insert(submissions)
    .values({
      assignmentRepoId: repo.id,
      checkpointId: checkpoint.id,
      sha: '1'.repeat(40),
      ref: 'main',
      committedAt: new Date('2026-09-01T00:00:00Z'),
      submittedAt: new Date('2026-09-01T00:00:00Z'),
      submittedByUserId: studentId,
    })
    .returning({ id: submissions.id })

  return { submissionId: submission.id }
}

function request(body?: unknown, key?: string): Request {
  return new Request('https://example.com/api/grading/lease', {
    method: 'POST',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/grading/lease', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await leaseRoute(request())
    expect(response.status).toBe(401)
  })

  it('rejects a key that does not exist', async () => {
    const response = await leaseRoute(request(undefined, 'garbage'))
    expect(response.status).toBe(401)
  })

  it('rejects a key without the grading scope', async () => {
    const profe = await teacher()
    const { rawKey } = await apiKey(profe, ['something-else'])
    const response = await leaseRoute(request(undefined, rawKey))
    expect(response.status).toBe(401)
  })

  it('answers 204 when there is nothing to grade', async () => {
    const profe = await teacher()
    const { rawKey } = await apiKey(profe)
    const response = await leaseRoute(request(undefined, rawKey))
    expect(response.status).toBe(204)
  })

  it('answers 200 with the lease and inserts a leased row', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const assignment = await gradableAssignment(org, profe)
    const { submissionId } = await submittedRepo(assignment, alumna)
    const { rawKey } = await apiKey(profe)

    const response = await leaseRoute(request(undefined, rawKey))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toMatchObject({
      sha: '1'.repeat(40),
      autograderId: 'tp1',
      token: 'scoped-token',
      repo: { owner: 'fiubaTA050-labs' },
    })

    const [run] = await db.select().from(gradingRuns).where(eq(gradingRuns.id, body.leaseId))
    expect(run).toMatchObject({ submissionId, status: 'leased' })
  })
})

describe('POST /api/grading/lease/:id/result', () => {
  async function leaseFor(profe: number, alumna: number, org: number): Promise<{ leaseId: number; rawKey: string }> {
    const assignment = await gradableAssignment(org, profe)
    await submittedRepo(assignment, alumna)
    const { rawKey } = await apiKey(profe)

    const response = await leaseRoute(request(undefined, rawKey))
    const body = await response.json()
    return { leaseId: body.leaseId, rawKey }
  }

  it('rejects a request with no Authorization header', async () => {
    const response = await resultRoute(request({ status: 'succeeded' }), {
      params: Promise.resolve({ id: '1' }),
    })
    expect(response.status).toBe(401)
  })

  it('rejects a malformed body', async () => {
    const profe = await teacher()
    const { rawKey } = await apiKey(profe)

    const response = await resultRoute(request({ status: 'not-a-status' }, rawKey), {
      params: Promise.resolve({ id: '1' }),
    })
    expect(response.status).toBe(400)
  })

  it('answers 404 for a lease that is not this key\'s', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const { leaseId } = await leaseFor(profe, alumna, org)

    const otherProfe = await teacher()
    const { rawKey: otherKey } = await apiKey(otherProfe)

    const response = await resultRoute(request({ status: 'succeeded', score: 100 }, otherKey), {
      params: Promise.resolve({ id: String(leaseId) }),
    })
    expect(response.status).toBe(404)
  })

  it('writes the result and answers 200', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const { leaseId, rawKey } = await leaseFor(profe, alumna, org)

    const response = await resultRoute(
      request({ status: 'succeeded', score: 87.5, output: 'ok', tests: [{ name: 'a' }] }, rawKey),
      { params: Promise.resolve({ id: String(leaseId) }) },
    )
    expect(response.status).toBe(200)

    const [run] = await db.select().from(gradingRuns).where(eq(gradingRuns.id, leaseId))
    expect(run).toMatchObject({ status: 'succeeded', score: 87.5, output: 'ok' })
    expect(run.tests).toEqual([{ name: 'a' }])
  })

  it('answers 409 when the lease is no longer open', async () => {
    const profe = await teacher()
    const alumna = await student()
    const org = await classroom(profe)
    const { leaseId, rawKey } = await leaseFor(profe, alumna, org)

    // First result closes it
    await resultRoute(request({ status: 'succeeded', score: 1 }, rawKey), {
      params: Promise.resolve({ id: String(leaseId) }),
    })

    const response = await resultRoute(request({ status: 'succeeded', score: 2 }, rawKey), {
      params: Promise.resolve({ id: String(leaseId) }),
    })
    expect(response.status).toBe(409)
  })
})
