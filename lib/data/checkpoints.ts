import 'server-only'

import { and, count, eq, isNull } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { assignments, checkpoints, submissions } from '@/db/schema'
import { findTeachingClassroom } from '@/lib/data/organizations'
import { isForeignKeyViolation, isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'

/**
 * Checkpoints — the entregas of an assignment — for the teacher.
 *
 * DA-4: every function takes the session and filters by user through
 * `findTeachingClassroom`, which joins `organizations_users`. There is no RLS.
 *
 * No equivalent in the original, which hangs a single `deadline` off the
 * assignment and runs a Sidekiq job when it passes. Here a date belongs to an
 * entrega, because one assignment can have several — TP2 is 2A to 2D over the
 * same repository — and nothing runs on a timer. See docs/entregas.md.
 */

export type CheckpointResult = { success: true } | { success: false; error: string }

export type Checkpoint = {
  id: number
  /** "2A". Null is the single unnamed entrega of an assignment with no parts */
  title: string | null
  deadlineAt: Date | null
  autograderId: string | null
  closedAt: Date | null
  submissionCount: number
}

export type CheckpointInput = {
  /** Null for a new entrega; an existing id to update that one in place */
  id: number | null
  title: string | null
  deadlineAt: Date | null
  autograderId: string | null
  closed: boolean
}

/** All of an assignment's entregas, in the order the teacher arranged them */
export async function listCheckpoints(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<Checkpoint[] | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [assignment] = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
      ),
    )
  if (!assignment) return null

  return db
    .select({
      id: checkpoints.id,
      title: checkpoints.title,
      deadlineAt: checkpoints.deadlineAt,
      autograderId: checkpoints.autograderId,
      closedAt: checkpoints.closedAt,
      submissionCount: count(submissions.id),
    })
    .from(checkpoints)
    .leftJoin(submissions, eq(submissions.checkpointId, checkpoints.id))
    .where(eq(checkpoints.assignmentId, assignment.id))
    .groupBy(checkpoints.id)
    .orderBy(checkpoints.position)
}

/**
 * Replaces an assignment's whole list of entregas with `rows` in one
 * transaction: creates the ones with no `id`, updates the ones that have one,
 * and removes whichever existing entrega is missing from the list. Position
 * is just the array order — reordering is resubmitting the same list
 * shuffled, not a separate operation.
 *
 * Removing an entrega that already has submissions is refused, same stance as
 * `saveAssignmentCheckpoint`: the submission is the evidence of the grading,
 * and nothing here cascades that away. (`submissions.checkpointId` also has
 * no `onDelete: cascade` in the schema, so a caller that ignored this
 * function would hit a foreign key error instead of silent data loss.)
 *
 * Renaming two entregas at once — 2A/2B swapped to 2B/2A — would trip the
 * unique index mid-transaction if each row's final title were written in a
 * single pass: the first `UPDATE` would momentarily match the title the
 * second row still holds. So updates run in two passes: every existing row
 * being kept first moves to a placeholder title nothing else can collide
 * with, and only once every old title is gone from the table does the second
 * pass write everyone's real target values. The upfront duplicate check above
 * already guarantees those targets are distinct, so the second pass is safe
 * in any order.
 */
export async function saveCheckpoints(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  rows: CheckpointInput[],
): Promise<CheckpointResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No encontramos ese classroom.' }

  if (classroom.archivedAt) {
    return {
      success: false,
      error: 'No se pueden modificar trabajos prácticos en un classroom archivado.',
    }
  }

  const [assignment] = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
      ),
    )
  if (!assignment) return { success: false, error: 'No encontramos ese trabajo práctico.' }

  // Blank means the same as null — a title cleared back to "no name" — same
  // normalisation optionalText() does for other free-text fields
  const normalized = rows.map((row) => ({ ...row, title: row.title?.trim() || null }))

  const titleCounts = new Map<string, number>()
  for (const row of normalized) {
    const key = row.title ?? ''
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }
  for (const [title, n] of titleCounts) {
    if (n <= 1) continue
    return {
      success: false,
      error: title
        ? `Dos entregas no pueden llamarse "${title}".`
        : 'Sólo una entrega puede quedar sin título.',
    }
  }

  const existing = await db
    .select({
      id: checkpoints.id,
      title: checkpoints.title,
      closedAt: checkpoints.closedAt,
      submissionCount: count(submissions.id),
    })
    .from(checkpoints)
    .leftJoin(submissions, eq(submissions.checkpointId, checkpoints.id))
    .where(eq(checkpoints.assignmentId, assignment.id))
    .groupBy(checkpoints.id)

  const existingById = new Map(existing.map((row) => [row.id, row]))

  for (const row of normalized) {
    if (row.id !== null && !existingById.has(row.id)) {
      return { success: false, error: 'Una de las entregas no pertenece a este trabajo práctico.' }
    }
  }

  const keptIds = new Set(normalized.flatMap((row) => (row.id !== null ? [row.id] : [])))
  const removed = existing.filter((row) => !keptIds.has(row.id))

  const blocked = removed.find((row) => row.submissionCount > 0)
  if (blocked) {
    return {
      success: false,
      error:
        `No se puede borrar "${blocked.title ?? 'la entrega'}": ya tiene ` +
        `${blocked.submissionCount} confirmada${blocked.submissionCount === 1 ? '' : 's'}.`,
    }
  }

  try {
    await db.transaction(async (tx) => {
      for (const row of removed) {
        await tx.delete(checkpoints).where(eq(checkpoints.id, row.id))
      }

      // Pass 1: park every kept existing row on a title nothing else can
      // collide with — see the two-pass note above. A leading space works
      // because `normalized` above always trims a real title, so one can
      // never equal this.
      for (const row of normalized) {
        if (row.id === null) continue
        await tx
          .update(checkpoints)
          .set({ title: ' '.concat(String(row.id)) })
          .where(eq(checkpoints.id, row.id))
      }

      // Pass 2: write everyone's real values. Safe in any order now — no row
      // still holds an old, possibly-colliding title.
      for (const [position, row] of normalized.entries()) {
        if (row.id === null) {
          await tx.insert(checkpoints).values({
            assignmentId: assignment.id,
            title: row.title,
            deadlineAt: row.deadlineAt,
            autograderId: row.autograderId,
            closedAt: row.closed ? new Date() : null,
            position,
          })
          continue
        }

        const current = existingById.get(row.id)!
        await tx
          .update(checkpoints)
          .set({
            title: row.title,
            deadlineAt: row.deadlineAt,
            autograderId: row.autograderId,
            // Preserve the original close time across re-saves; only flip it
            closedAt: row.closed ? (current.closedAt ?? new Date()) : null,
            position,
            updatedAt: new Date(),
          })
          .where(eq(checkpoints.id, row.id))
      }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { success: false, error: 'Dos entregas no pueden compartir el mismo título.' }
    }
    // The submissionCount check above raced: a student can confirm between
    // that read and this transaction's DELETE. The foreign key (no cascade,
    // on purpose — see the class doc) is the backstop, same "check first,
    // then race" shape as isUniqueViolation.
    if (isForeignKeyViolation(error)) {
      return {
        success: false,
        error:
          'No se pudo guardar: alguien confirmó una entrega justo antes de borrarla. Volvé a intentar.',
      }
    }
    throw error
  }

  return { success: true }
}
