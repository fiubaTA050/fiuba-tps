import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
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
 * An assignment's entregas, from the teacher's side.
 *
 * No spec to port — the original hangs one `deadline` off the assignment and
 * has no notion of an entrega you can open and close, let alone several of
 * them. The rules under test are the ones in docs/entregas.md: no checkpoint
 * means nothing to hand in, and a checkpoint with submissions cannot be
 * removed.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const { listCheckpoints, saveCheckpoints } = await import('@/lib/data/checkpoints')

let nextUid = 1
let nextGithubId = 1000

async function teacher(): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: `profe-${uid}` })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: `profe-${uid}` },
  } as Session
}

async function classroomWithAssignment(
  profe: Session,
  options: { archived?: boolean } = {},
): Promise<{ classroomSlug: string; assignmentSlug: string; assignmentId: number }> {
  const githubId = nextGithubId++

  const [classroom] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: `${githubId}`,
      slug: `${githubId}-classroom`,
      archivedAt: options.archived ? new Date() : null,
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

/** One confirmed submission on that checkpoint, which is what blocks closing it */
async function handIn(assignmentId: number, checkpointId: number, profe: Session): Promise<void> {
  const [repo] = await db
    .insert(assignmentRepos)
    .values({ assignmentId, userId: Number(profe.user.id), githubRepoId: nextGithubId++ })
    .returning({ id: assignmentRepos.id })

  await db.insert(submissions).values({
    assignmentRepoId: repo.id,
    checkpointId,
    sha: 'a'.repeat(40),
    ref: 'main',
    committedAt: new Date(),
    submittedByUserId: Number(profe.user.id),
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
})

describe('the schema itself', () => {
  it('refuses a second unnamed entrega for the same assignment', async () => {
    const profe = await teacher()
    const { assignmentId } = await classroomWithAssignment(profe)

    await db.insert(checkpoints).values({ assignmentId, title: null })

    // Two NULLs do not collide in a plain unique index, which is why the
    // partial one on `title is null` exists
    await expect(db.insert(checkpoints).values({ assignmentId, title: null })).rejects.toThrow()
  })

  it('refuses two entregas with the same name', async () => {
    const profe = await teacher()
    const { assignmentId } = await classroomWithAssignment(profe)

    await db.insert(checkpoints).values({ assignmentId, title: '2A', position: 0 })

    await expect(
      db.insert(checkpoints).values({ assignmentId, title: '2A', position: 1 }),
    ).rejects.toThrow()
  })

  it('allows the named entregas TP2 needs alongside each other', async () => {
    const profe = await teacher()
    const { assignmentId } = await classroomWithAssignment(profe)

    await db.insert(checkpoints).values([
      { assignmentId, title: '2A', position: 0 },
      { assignmentId, title: '2B', position: 1 },
      { assignmentId, title: '2C', position: 2 },
      { assignmentId, title: '2D', position: 3 },
    ])

    expect(await db.select().from(checkpoints)).toHaveLength(4)
  })
})

describe('listCheckpoints', () => {
  it('is an empty list for an assignment with no entregas yet', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    expect(await listCheckpoints(profe, classroomSlug, assignmentSlug)).toEqual([])
  })

  it('orders entregas the way the teacher arranged them', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)

    await db.insert(checkpoints).values([
      { assignmentId, title: '2B', position: 1 },
      { assignmentId, title: '2A', position: 0 },
    ])

    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found?.map((row) => row.title)).toEqual(['2A', '2B'])
  })

  it('counts submissions per entrega', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)

    const [checkpoint] = await db
      .insert(checkpoints)
      .values({ assignmentId, title: '2A', position: 0 })
      .returning({ id: checkpoints.id })
    await handIn(assignmentId, checkpoint.id, profe)

    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found).toMatchObject([{ title: '2A', submissionCount: 1 }])
  })

  it('does not let a teacher of another classroom see it', async () => {
    const profe = await teacher()
    const ajeno = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    expect(await listCheckpoints(ajeno, classroomSlug, assignmentSlug)).toBeNull()
  })
})

describe('saveCheckpoints', () => {
  it('creates the four entregas TP2 needs, in one call', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2B', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2C', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2D', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toEqual({ success: true })
    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found?.map((row) => row.title)).toEqual(['2A', '2B', '2C', '2D'])
  })

  it('creates a single entrega with no title, same as saveAssignmentCheckpoint', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: null, deadlineAt: null, autograderId: null, closed: false },
    ])

    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found).toMatchObject([{ title: null }])
  })

  it('updates an existing entrega in place instead of duplicating it', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [created] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!
    const deadlineAt = new Date('2026-09-12T02:59:00Z')

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: created.id, title: '2A', deadlineAt, autograderId: 'tp1', closed: false },
    ])

    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found).toHaveLength(1)
    expect(found).toMatchObject([{ id: created.id, deadlineAt, autograderId: 'tp1' }])
  })

  it('reorders by resubmitting the list shuffled', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2B', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [a, b] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: b.id, title: '2B', deadlineAt: null, autograderId: null, closed: false },
      { id: a.id, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found?.map((row) => row.title)).toEqual(['2B', '2A'])
  })

  it('removes an entrega that nobody used', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2B', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [a] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: a.id, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toEqual({ success: true })
    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found?.map((row) => row.title)).toEqual(['2A'])
  })

  it('refuses to remove an entrega once somebody handed in, and touches nothing', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2B', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [a, b] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!
    await handIn(assignmentId, a.id, profe)

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: b.id, title: '2B', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toMatchObject({ success: false })
    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found?.map((row) => row.title)).toEqual(['2A', '2B'])
  })

  it('refuses two entregas with the same title in one call', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toMatchObject({ success: false })
    expect(await listCheckpoints(profe, classroomSlug, assignmentSlug)).toEqual([])
  })

  it('refuses two entregas left without a title in one call', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: null, deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '  ', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toMatchObject({ success: false })
    expect(await listCheckpoints(profe, classroomSlug, assignmentSlug)).toEqual([])
  })

  it('refuses an id that belongs to a different assignment', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)
    const other = await classroomWithAssignment(profe)
    await saveCheckpoints(profe, other.classroomSlug, other.assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [foreign] = (await listCheckpoints(profe, other.classroomSlug, other.assignmentSlug))!

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: foreign.id, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toMatchObject({ success: false })
  })

  it('preserves closedAt across re-saves', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: true },
    ])
    const [first] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: first.id, title: '2A', deadlineAt: null, autograderId: null, closed: true },
    ])
    const [second] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    expect(second.closedAt).toEqual(first.closedAt)
  })

  it('reopening clears closedAt', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: true },
    ])
    const [created] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: created.id, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [found] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    expect(found.closedAt).toBeNull()
  })

  it('clears the date and leaves the entrega open', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      {
        id: null,
        title: '2A',
        deadlineAt: new Date('2026-09-12T02:59:00Z'),
        autograderId: null,
        closed: false,
      },
    ])
    const [created] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: created.id, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [found] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    expect(found).toMatchObject({ deadlineAt: null, closedAt: null })
  })

  it('swaps two entregas\' titles in one call without tripping the unique index', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
      { id: null, title: '2B', deadlineAt: null, autograderId: null, closed: false },
    ])
    const [a, b] = (await listCheckpoints(profe, classroomSlug, assignmentSlug))!

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: a.id, title: '2B', deadlineAt: null, autograderId: null, closed: false },
      { id: b.id, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toEqual({ success: true })
    const found = await listCheckpoints(profe, classroomSlug, assignmentSlug)
    expect(found).toMatchObject([
      { id: a.id, title: '2B' },
      { id: b.id, title: '2A' },
    ])
  })

  it('saving an empty list on an assignment with no entregas is not an error', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [])

    expect(result).toEqual({ success: true })
  })

  it('reports a soft-deleted assignment as gone', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)

    await db
      .update(assignments)
      .set({ deletedAt: new Date() })
      .where(eq(assignments.id, assignmentId))

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toMatchObject({ success: false })
  })

  it('refuses in an archived classroom, like every other writer', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe, {
      archived: true,
    })

    const result = await saveCheckpoints(profe, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toMatchObject({ success: false })
  })

  it('does not let a teacher of another classroom touch it', async () => {
    const profe = await teacher()
    const ajeno = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await saveCheckpoints(ajeno, classroomSlug, assignmentSlug, [
      { id: null, title: '2A', deadlineAt: null, autograderId: null, closed: false },
    ])

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(checkpoints)).toHaveLength(0)
  })
})
