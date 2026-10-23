import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apiKeys,
  assignmentInvitations,
  assignmentRepos,
  assignments,
  checkpoints,
  groupAssignmentInvitations,
  groupAssignments,
  groupings,
  inviteStatuses,
  organizations,
  organizationsUsers,
  submissions,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * The MCP endpoint end to end: route → lib/mcp/server.ts → lib/data/ → a real
 * database, with GitHub stubbed. What matters here is the boundary — the key,
 * its scopes, and that a tool reaches only the key owner's classrooms.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

vi.mock('@/lib/github/repositories', () => ({
  listRepositorySnapshots: async (_installationId: number, wanted: Iterable<number>) =>
    new Map(
      [...wanted].map((id) => [
        id,
        {
          id,
          fullName: `fiubaTA050-labs/repo-${id}`,
          htmlUrl: `https://github.com/fiubaTA050-labs/repo-${id}`,
          latestCommitAt: new Date('2026-10-01T12:00:00Z'),
          commitCount: 3,
        },
      ]),
    ),
}))

// `baseUrl` reads the request headers through next/headers, which only exists
// inside a real Next request
vi.mock('@/lib/url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url')>()),
  baseUrl: async () => 'https://classroom.test',
}))

const { POST } = await import('@/app/api/mcp/route')

let nextId = 1000

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextId = 1000
})

async function user(login = `profe-${nextId}`): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ uid: nextId++, githubLogin: login })
    .returning({ id: users.id })
  return row.id
}

async function apiKey(userId: number, scopes: string[]): Promise<string> {
  const rawKey = `raw-${nextId++}`
  await db.insert(apiKeys).values({
    userId,
    label: 'test',
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
    scopes,
  })
  return rawKey
}

async function classroom(teacherId: number, archived = false): Promise<{ id: number; slug: string }> {
  const githubId = nextId++
  const slug = `${githubId}-classroom`
  const [org] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: `Classroom ${githubId}`,
      slug,
      archivedAt: archived ? new Date() : null,
    })
    .returning({ id: organizations.id })
  await db.insert(organizationsUsers).values({ organizationId: org.id, userId: teacherId })
  return { id: org.id, slug }
}

async function assignment(
  organizationId: number,
  creatorId: number,
): Promise<{ id: number; slug: string; invitationId: number }> {
  const slug = `tp-${nextId++}`
  const [row] = await db
    .insert(assignments)
    .values({ organizationId, creatorId, title: `TP ${slug}`, slug })
    .returning({ id: assignments.id })
  const [invitation] = await db
    .insert(assignmentInvitations)
    .values({ assignmentId: row.id, key: `key-${slug}`, shortKey: `s${nextId++}` })
    .returning({ id: assignmentInvitations.id })
  return { id: row.id, slug, invitationId: invitation.id }
}

async function groupAssignment(organizationId: number, creatorId: number): Promise<{ id: number; slug: string }> {
  const [grouping] = await db
    .insert(groupings)
    .values({ organizationId, title: 'Equipos', slug: `equipos-${nextId++}` })
    .returning({ id: groupings.id })
  const slug = `tp-grupal-${nextId++}`
  const [row] = await db
    .insert(groupAssignments)
    .values({ organizationId, creatorId, groupingId: grouping.id, title: `TP ${slug}`, slug })
    .returning({ id: groupAssignments.id })
  await db.insert(groupAssignmentInvitations).values({ groupAssignmentId: row.id, key: `key-${slug}` })
  return { id: row.id, slug }
}

/** One JSON-RPC call, the way Claude Code sends it */
async function rpc(rawKey: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await POST(
    new Request('https://classroom.test/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(rawKey ? { authorization: `Bearer ${rawKey}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  return response
}

async function callTool(rawKey: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(rawKey, 'tools/call', { name, arguments: args })
  expect(response.status).toBe(200)
  const body = await response.json()
  const result = body.result as { isError?: boolean; content: { type: string; text: string }[] }
  return {
    isError: result.isError ?? false,
    text: result.content[0].text,
    data: result.isError ? null : JSON.parse(result.content[0].text),
  }
}

async function toolNames(rawKey: string): Promise<string[]> {
  const response = await rpc(rawKey, 'tools/list')
  const body = await response.json()
  return body.result.tools.map((tool: { name: string }) => tool.name)
}

describe('authentication', () => {
  it('refuses a request with no key', async () => {
    expect((await rpc(null, 'tools/list')).status).toBe(401)
  })

  it('refuses a key that does not exist', async () => {
    expect((await rpc('nope', 'tools/list')).status).toBe(401)
  })

  it('refuses a key with only the grading scope', async () => {
    const rawKey = await apiKey(await user(), ['grading:write'])
    expect((await rpc(rawKey, 'tools/list')).status).toBe(401)
  })
})

describe('tools/list', () => {
  it('hides the write tools from a read-only key', async () => {
    const rawKey = await apiKey(await user(), ['classroom:read'])

    const names = await toolNames(rawKey)

    expect(names).toContain('list_classrooms')
    expect(names).toContain('get_dashboard')
    expect(names).not.toContain('set_assignment_active')
  })

  it('lists the write tools, and the read ones, for a write key', async () => {
    const rawKey = await apiKey(await user(), ['classroom:write'])

    const names = await toolNames(rawKey)

    expect(names).toContain('list_classrooms')
    expect(names).toContain('set_assignment_active')
  })
})

describe('list_classrooms', () => {
  it("lists only the key owner's classrooms", async () => {
    const profe = await user()
    const otra = await user()
    const mine = await classroom(profe)
    await classroom(otra)
    const rawKey = await apiKey(profe, ['classroom:read'])

    const { data } = await callTool(rawKey, 'list_classrooms')

    expect(data.map((row: { slug: string }) => row.slug)).toEqual([mine.slug])
  })
})

describe('list_assignments', () => {
  it('returns both kinds with their state, link and entregas', async () => {
    const profe = await user()
    const room = await classroom(profe)
    const tp = await assignment(room.id, profe)
    const grupal = await groupAssignment(room.id, profe)
    await db.insert(checkpoints).values({
      assignmentId: tp.id,
      title: '1A',
      deadlineAt: new Date('2026-10-10T02:59:00Z'),
    })
    const rawKey = await apiKey(profe, ['classroom:read'])

    const { data } = await callTool(rawKey, 'list_assignments', { classroom: room.slug })

    expect(data).toHaveLength(2)
    expect(data[0]).toMatchObject({
      kind: 'individual',
      slug: tp.slug,
      active: true,
      entregas: [{ title: '1A', deadlineAt: '2026-10-10T02:59:00.000Z', closed: false, submissionCount: 0 }],
    })
    expect(data[0].invitationUrl).toMatch(/^https:\/\/classroom\.test\/a\//)
    expect(data[1]).toMatchObject({ kind: 'group', slug: grupal.slug, active: true, entregas: [] })
  })

  it("answers an error for somebody else's classroom", async () => {
    const room = await classroom(await user())
    const rawKey = await apiKey(await user(), ['classroom:read'])

    const result = await callTool(rawKey, 'list_assignments', { classroom: room.slug })

    expect(result.isError).toBe(true)
  })
})

describe('get_dashboard', () => {
  it("joins each student's repository and their current submission per entrega", async () => {
    const profe = await user()
    const alumna = await user('alumna')
    const room = await classroom(profe)
    const tp = await assignment(room.id, profe)
    const [checkpoint] = await db
      .insert(checkpoints)
      .values({ assignmentId: tp.id, title: '1A', deadlineAt: new Date('2026-10-10T02:59:00Z') })
      .returning({ id: checkpoints.id })
    await db
      .insert(inviteStatuses)
      .values({ assignmentInvitationId: tp.invitationId, userId: alumna, status: 'completed' })
    const [repo] = await db
      .insert(assignmentRepos)
      .values({ assignmentId: tp.id, userId: alumna, githubRepoId: 555 })
      .returning({ id: assignmentRepos.id })
    await db.insert(submissions).values({
      assignmentRepoId: repo.id,
      checkpointId: checkpoint.id,
      sha: 'a'.repeat(40),
      ref: 'main',
      committedAt: new Date('2026-10-11T00:00:00Z'),
      submittedAt: new Date('2026-10-11T00:00:00Z'),
      submittedByUserId: alumna,
    })
    const rawKey = await apiKey(profe, ['classroom:read'])

    const { data } = await callTool(rawKey, 'get_dashboard', {
      classroom: room.slug,
      assignment: tp.slug,
    })

    expect(data.students).toEqual([
      {
        identifier: null,
        githubLogin: 'alumna',
        state: 'accepted_unlinked',
        repoId: 555,
        repository: {
          id: 555,
          fullName: 'fiubaTA050-labs/repo-555',
          url: 'https://github.com/fiubaTA050-labs/repo-555',
          commitCount: 3,
          latestCommitAt: '2026-10-01T12:00:00.000Z',
        },
        entregas: [
          {
            entregaId: checkpoint.id,
            entrega: '1A',
            exempt: false,
            submission: expect.objectContaining({
              sha: 'a'.repeat(40),
              late: true,
              lateJustified: false,
              passed: null,
            }),
          },
        ],
      },
    ])
  })
})

describe('set_assignment_active', () => {
  it('marks an individual assignment Inactive and back', async () => {
    const profe = await user()
    const room = await classroom(profe)
    const tp = await assignment(room.id, profe)
    const rawKey = await apiKey(profe, ['classroom:write'])

    const closed = await callTool(rawKey, 'set_assignment_active', {
      classroom: room.slug,
      assignment: tp.slug,
      active: false,
    })

    expect(closed.isError).toBe(false)
    const [row] = await db.select().from(assignments).where(eq(assignments.id, tp.id))
    expect(row.invitationsEnabled).toBe(false)

    await callTool(rawKey, 'set_assignment_active', {
      classroom: room.slug,
      assignment: tp.slug,
      active: true,
    })
    const [reopened] = await db.select().from(assignments).where(eq(assignments.id, tp.id))
    expect(reopened.invitationsEnabled).toBe(true)
  })

  it('marks a group assignment Inactive', async () => {
    const profe = await user()
    const room = await classroom(profe)
    const grupal = await groupAssignment(room.id, profe)
    const rawKey = await apiKey(profe, ['classroom:write'])

    await callTool(rawKey, 'set_assignment_active', {
      classroom: room.slug,
      assignment: grupal.slug,
      kind: 'group',
      active: false,
    })

    const [row] = await db.select().from(groupAssignments).where(eq(groupAssignments.id, grupal.id))
    expect(row.invitationsEnabled).toBe(false)
  })

  it("does not touch somebody else's assignment", async () => {
    const owner = await user()
    const room = await classroom(owner)
    const tp = await assignment(room.id, owner)
    const rawKey = await apiKey(await user(), ['classroom:write'])

    const result = await callTool(rawKey, 'set_assignment_active', {
      classroom: room.slug,
      assignment: tp.slug,
      active: false,
    })

    expect(result.isError).toBe(true)
    const [row] = await db.select().from(assignments).where(eq(assignments.id, tp.id))
    expect(row.invitationsEnabled).toBe(true)
  })

  it('refuses an archived classroom', async () => {
    const profe = await user()
    const room = await classroom(profe, true)
    const tp = await assignment(room.id, profe)
    const rawKey = await apiKey(profe, ['classroom:write'])

    const result = await callTool(rawKey, 'set_assignment_active', {
      classroom: room.slug,
      assignment: tp.slug,
      active: false,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/archivado/)
  })

  it('cannot be called with a read-only key', async () => {
    const profe = await user()
    const room = await classroom(profe)
    const tp = await assignment(room.id, profe)
    const rawKey = await apiKey(profe, ['classroom:read'])

    const result = await callTool(rawKey, 'set_assignment_active', {
      classroom: room.slug,
      assignment: tp.slug,
      active: false,
    })

    expect(result.isError).toBe(true)
    const [row] = await db.select().from(assignments).where(eq(assignments.id, tp.id))
    expect(row.invitationsEnabled).toBe(true)
  })
})
