import 'server-only'

import { and, count, eq, isNull } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { assignments, checkpoints, submissions } from '@/db/schema'
import { findTeachingClassroom } from '@/lib/data/organizations'
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
 *
 * This module only knows about the **single unnamed checkpoint**, which is the
 * whole of what the edit screen can express today. The named ones (2A, 2B, …)
 * are schema already and UI later.
 */

export type CheckpointResult = { success: true } | { success: false; error: string }

export type AssignmentCheckpoint = {
  id: number
  deadlineAt: Date | null
  /** Whether anybody has handed in yet, which is what blocks closing entregas */
  submissionCount: number
}

/** The assignment's single entrega, for the edit screen. Null when it has none */
export async function findAssignmentCheckpoint(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<AssignmentCheckpoint | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [row] = await db
    .select({
      id: checkpoints.id,
      deadlineAt: checkpoints.deadlineAt,
      submissionCount: count(submissions.id),
    })
    .from(checkpoints)
    .innerJoin(assignments, eq(assignments.id, checkpoints.assignmentId))
    .leftJoin(submissions, eq(submissions.checkpointId, checkpoints.id))
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
        isNull(checkpoints.title),
      ),
    )
    .groupBy(checkpoints.id)

  return row ?? null
}

/**
 * Creates, dates or removes the assignment's single entrega.
 *
 * The two controls of the edit screen map one to one onto the model:
 * `enabled` is whether the checkpoint exists at all — *no checkpoints means
 * nothing to hand in* — and `deadlineAt` is its date, which may be null for an
 * entrega whose date is not decided yet.
 *
 * Turning entregas off once somebody has handed in is refused rather than
 * cascaded. The submission is the evidence of the grading, and one click
 * taking a hundred of them is the failure DA-9 already rules out for
 * repositories.
 */
export async function saveAssignmentCheckpoint(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  input: { enabled: boolean; deadlineAt: Date | null },
): Promise<CheckpointResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No encontramos ese classroom.' }

  // The same guard every other writer carries: validate
  // :organization_is_not_archived reads "create or modify"
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

  const [existing] = await db
    .select({ id: checkpoints.id })
    .from(checkpoints)
    .where(and(eq(checkpoints.assignmentId, assignment.id), isNull(checkpoints.title)))

  if (!input.enabled) {
    if (!existing) return { success: true }

    const [{ value: handedIn }] = await db
      .select({ value: count() })
      .from(submissions)
      .where(eq(submissions.checkpointId, existing.id))

    if (handedIn > 0) {
      return {
        success: false,
        error:
          `No se pueden cerrar las entregas: ya hay ${handedIn} confirmada` +
          `${handedIn === 1 ? '' : 's'}. Para que nadie entregue más, poné el ` +
          'trabajo práctico en Inactivo.',
      }
    }

    await db.delete(checkpoints).where(eq(checkpoints.id, existing.id))
    return { success: true }
  }

  if (existing) {
    await db
      .update(checkpoints)
      .set({ deadlineAt: input.deadlineAt, updatedAt: new Date() })
      .where(eq(checkpoints.id, existing.id))

    return { success: true }
  }

  await db.insert(checkpoints).values({
    assignmentId: assignment.id,
    title: null,
    deadlineAt: input.deadlineAt,
    position: 0,
  })

  return { success: true }
}
