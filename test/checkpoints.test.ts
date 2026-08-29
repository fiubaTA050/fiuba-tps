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
 * The assignment's single entrega, from the teacher's side.
 *
 * No spec to port — the original hangs one `deadline` off the assignment and
 * has no notion of an entrega you can open and close. The rules under test are
 * the ones in docs/entregas.md: no checkpoint means nothing to hand in, and a
 * checkpoint with submissions cannot be removed.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const { findAssignmentCheckpoint, saveAssignmentCheckpoint } = await import(
  '@/lib/data/checkpoints'
)

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

describe('saveAssignmentCheckpoint', () => {
  it('opens entregas with a date', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)
    const deadlineAt = new Date('2026-09-12T02:59:00Z') // 11/09 23:59 ART

    const result = await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt,
    })

    expect(result).toEqual({ success: true })

    const found = await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)
    expect(found).toMatchObject({ deadlineAt, submissionCount: 0 })
  })

  it('opens entregas with no date at all', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })

    const found = await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)
    expect(found).toMatchObject({ deadlineAt: null })
  })

  it('moves the date without creating a second entrega', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: new Date('2026-09-12T02:59:00Z'),
    })
    const moved = new Date('2026-09-15T02:59:00Z')
    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: moved,
    })

    expect(await db.select().from(checkpoints)).toHaveLength(1)
    const found = await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)
    expect(found?.deadlineAt).toEqual(moved)
  })

  it('clears the date and leaves the entrega open', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: new Date('2026-09-12T02:59:00Z'),
    })
    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })

    const found = await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)
    expect(found).toMatchObject({ deadlineAt: null })
  })

  it('closes entregas that nobody used', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })
    const result = await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: false,
      deadlineAt: null,
    })

    expect(result).toEqual({ success: true })
    expect(await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)).toBeNull()
  })

  it('refuses to close entregas once somebody handed in', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)

    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })
    const checkpoint = await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)
    await handIn(assignmentId, checkpoint!.id, profe)

    const result = await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: false,
      deadlineAt: null,
    })

    expect(result).toMatchObject({ success: false })
    // The submission is the evidence of the grading: nothing was deleted
    expect(await db.select().from(submissions)).toHaveLength(1)
    expect(await db.select().from(checkpoints)).toHaveLength(1)
  })

  it('counts what has been handed in, for the screen that refuses', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)

    await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })
    const checkpoint = await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)
    await handIn(assignmentId, checkpoint!.id, profe)
    await handIn(assignmentId, checkpoint!.id, await teacher())

    const found = await findAssignmentCheckpoint(profe, classroomSlug, assignmentSlug)
    expect(found?.submissionCount).toBe(2)
  })

  it('closing entregas that were never opened is not an error', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: false,
      deadlineAt: null,
    })

    expect(result).toEqual({ success: true })
  })

  it('refuses in an archived classroom, like every other writer', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe, {
      archived: true,
    })

    const result = await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(checkpoints)).toHaveLength(0)
  })

  it('does not let a teacher of another classroom touch it', async () => {
    const profe = await teacher()
    const ajeno = await teacher()
    const { classroomSlug, assignmentSlug } = await classroomWithAssignment(profe)

    const result = await saveAssignmentCheckpoint(ajeno, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(checkpoints)).toHaveLength(0)
  })

  it('reports a soft-deleted assignment as gone', async () => {
    const profe = await teacher()
    const { classroomSlug, assignmentSlug, assignmentId } = await classroomWithAssignment(profe)

    await db
      .update(assignments)
      .set({ deletedAt: new Date() })
      .where(eq(assignments.id, assignmentId))

    const result = await saveAssignmentCheckpoint(profe, classroomSlug, assignmentSlug, {
      enabled: true,
      deadlineAt: null,
    })

    expect(result).toMatchObject({ success: false })
  })
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
