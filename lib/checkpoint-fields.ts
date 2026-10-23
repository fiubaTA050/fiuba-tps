import type { CheckpointFieldValue } from '@/app/classrooms/[slug]/assignments/[assignmentSlug]/edit/CheckpointsField'
import type { Checkpoint } from '@/lib/data/checkpoints'
import { toArgentinaDateTimeInput } from '@/lib/dates'

/**
 * An assignment's entregas as `CheckpointsField` edits them, for both edit
 * screens. Formatted on the server, in Argentine time, so the field never
 * depends on the clock of the laptop that opens it.
 */
export function toCheckpointFieldValues(checkpoints: Checkpoint[] | null): CheckpointFieldValue[] {
  return (checkpoints ?? []).map((checkpoint) => ({
    id: checkpoint.id,
    title: checkpoint.title ?? '',
    deadlineAt: checkpoint.deadlineAt ? toArgentinaDateTimeInput(checkpoint.deadlineAt) : '',
    autograderId: checkpoint.autograderId ?? '',
    closed: Boolean(checkpoint.closedAt),
    resultsPublished: Boolean(checkpoint.resultsPublishedAt),
    submissionCount: checkpoint.submissionCount,
  }))
}
