import 'server-only'

import { and, count, eq, isNull } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { assignments, checkpoints, submissionExemptions, submissions } from '@/db/schema'
import { parseArgentinaDateTime } from '@/lib/dates'
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

// Mirrors checkpoints.title/autograderId in db/schema.ts. The client already
// enforces title's maxLength, but this field crosses the request boundary —
// a hand-crafted POST skips that — so the length still has to be checked
// here, or a too-long value reaches Postgres as an uncaught column-width error.
export const CHECKPOINT_TITLE_MAX_LENGTH = 60
export const CHECKPOINT_AUTOGRADER_ID_MAX_LENGTH = 255

// No real assignment needs more than a handful of entregas (TP2's 2A-2D is
// the known extreme). A hand-crafted POST with thousands of rows would still
// pass per-row validation and turn into that many sequential inserts inside
// one transaction, inside one request — capped well above any real use.
export const CHECKPOINT_MAX_ROWS = 50

/**
 * What `CheckpointsField` serializes into the hidden `checkpoints` field: one
 * row per entrega, in the order the teacher arranged them. Parsed defensively
 * since it is still form input crossing the request boundary, even though it
 * came from this app's own client component. Shared by the edit and the
 * create screens' server actions.
 */
export function parseCheckpointsField(value: FormDataEntryValue | null): CheckpointInput[] | null {
  if (typeof value !== 'string') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length > CHECKPOINT_MAX_ROWS) return null

  const rows: CheckpointInput[] = []
  const seenIds = new Set<number>()
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null
    const { id, title, deadlineAt, autograderId, closed } = item as Record<string, unknown>
    if (id !== null && typeof id !== 'number') return null
    // Two rows sharing an existing id would UPDATE the same checkpoint twice
    // in saveCheckpoints, the second silently discarding the first's edits —
    // never legitimate from this app's own client, so treated the same as
    // any other malformed payload rather than let through.
    if (id !== null) {
      if (seenIds.has(id)) return null
      seenIds.add(id)
    }
    if (typeof title !== 'string' || title.length > CHECKPOINT_TITLE_MAX_LENGTH) return null
    if (typeof deadlineAt !== 'string') return null
    if (
      typeof autograderId !== 'string' ||
      autograderId.length > CHECKPOINT_AUTOGRADER_ID_MAX_LENGTH
    ) {
      return null
    }
    if (typeof closed !== 'boolean') return null

    const rawDeadline = deadlineAt.trim()
    const parsedDeadline = rawDeadline === '' ? null : parseArgentinaDateTime(rawDeadline)
    if (rawDeadline !== '' && parsedDeadline === null) return null

    rows.push({
      id,
      title,
      deadlineAt: parsedDeadline,
      autograderId: autograderId.trim() === '' ? null : autograderId.trim(),
      closed,
    })
  }

  return rows
}

/**
 * The companion hidden field: the checkpoint ids `CheckpointsField` actually
 * had loaded, frozen at mount — see `saveCheckpoints`'s `knownIds` jsdoc.
 * `null` (missing or malformed) is treated as "no snapshot to check against",
 * the same as omitting the argument.
 */
export function parseKnownCheckpointIds(value: FormDataEntryValue | null): number[] | null {
  if (typeof value !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'number')) return null
  return parsed as number[]
}

/** Blank means the same as null — a title cleared back to "no name" — same
 * normalisation optionalText() does for other free-text fields. */
export function normalizeCheckpointRows(rows: CheckpointInput[]): CheckpointInput[] {
  return rows.map((row) => ({ ...row, title: row.title?.trim() || null }))
}

/**
 * Pure check shared by `saveCheckpoints` and `createAssignment`: two entregas
 * of the same assignment cannot share a title, including the unnamed one
 * (two rows both `null`). Callers pass already-`normalizeCheckpointRows`d
 * rows.
 */
export function validateCheckpointTitles(rows: CheckpointInput[]): string | null {
  const titleCounts = new Map<string, number>()
  for (const row of rows) {
    const key = row.title ?? ''
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }
  for (const [title, n] of titleCounts) {
    if (n <= 1) continue
    return title
      ? `Dos entregas no pueden llamarse "${title}".`
      : 'Sólo una entrega puede quedar sin título.'
  }
  return null
}

/**
 * Defense in depth, shared by `saveCheckpoints` and `createAssignment`:
 * `parseCheckpointsField` already rejects an over-length title/autograderId
 * at the request boundary, but both of those are exported functions a caller
 * could reach directly — a test, a future path — without going through that
 * parser, so the same check runs again here rather than letting an
 * over-length value reach Postgres as an uncaught column-width error.
 */
export function validateCheckpointLengths(rows: CheckpointInput[]): string | null {
  for (const row of rows) {
    if (row.title !== null && row.title.length > CHECKPOINT_TITLE_MAX_LENGTH) {
      return 'El título de una entrega es demasiado largo.'
    }
    if (
      row.autograderId !== null &&
      row.autograderId.length > CHECKPOINT_AUTOGRADER_ID_MAX_LENGTH
    ) {
      return 'El identificador de corrección automática de una entrega es demasiado largo.'
    }
  }
  return null
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
    // `id` breaks a tie on `position` — two rows can share one, e.g. right
    // after the race saveCheckpoints' jsdoc describes, and without a
    // deterministic tiebreaker Postgres is free to order them differently
    // across this query and the two below.
    .orderBy(checkpoints.position, checkpoints.id)
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
 *
 * `knownIds`, when passed, is the set of checkpoint ids the caller's form was
 * actually built from — the edit screen's own snapshot from the moment it
 * loaded, untouched by whatever the teacher added, removed or reordered
 * locally afterwards. Two teachers editing the same assignment at once, or
 * one teacher with two tabs open, would otherwise resolve silently: `rows`
 * with no `id` for an entrega a second teacher just created reads as "not
 * mine to know about" and lands in `removed`, deleting it with no warning.
 * Comparing this snapshot against what's in the database right now turns
 * that into a refused save instead. Optional, and checked against the same
 * `existing` read the diff already does — no extra query, no hard lock — so
 * every caller that does not pass it (every test, and any future write path
 * that does not carry the notion of "what the form last saw") keeps working
 * exactly as before.
 */
export async function saveCheckpoints(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  rows: CheckpointInput[],
  knownIds?: number[],
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

  const normalized = normalizeCheckpointRows(rows)

  const lengthError = validateCheckpointLengths(normalized)
  if (lengthError) return { success: false, error: lengthError }

  const titleError = validateCheckpointTitles(normalized)
  if (titleError) return { success: false, error: titleError }

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

  if (knownIds !== undefined) {
    const existingIds = new Set(existing.map((row) => row.id))
    const knownIdSet = new Set(knownIds)
    const drifted =
      existing.some((row) => !knownIdSet.has(row.id)) || knownIds.some((id) => !existingIds.has(id))
    if (drifted) {
      return {
        success: false,
        error: 'Alguien más modificó las entregas mientras editabas esta pantalla. Recargá la página y volvé a intentar.',
      }
    }
  }

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

        // Reopening lets everyone back in, so the per-repo reentregas have
        // nothing left to exempt from. Left active they would silently come
        // back on the next close, hidden while the entrega is open — revoke
        // them here instead. See submissionExemptions in db/schema.ts.
        if (current.closedAt !== null && !row.closed) {
          await tx
            .update(submissionExemptions)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(submissionExemptions.checkpointId, row.id),
                isNull(submissionExemptions.revokedAt),
              ),
            )
        }
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
