'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import {
  deleteAssignment,
  updateAssignment,
  type AssignmentField,
} from '@/lib/data/assignments'
import { saveCheckpoints, type CheckpointInput } from '@/lib/data/checkpoints'
import { parseArgentinaDateTime } from '@/lib/dates'
import { isUsableSession } from '@/lib/session'

export type EditAssignmentState = { error: string | null; field: AssignmentField | null }

// Mirrors checkpoints.title/autograderId in db/schema.ts. The client already
// enforces title's maxLength, but this field crosses the request boundary —
// a hand-crafted POST skips that — so the length still has to be checked
// here, or a too-long value reaches Postgres as an uncaught column-width error.
const TITLE_MAX_LENGTH = 60
const AUTOGRADER_ID_MAX_LENGTH = 255

/**
 * What `CheckpointsField` serializes into the hidden `checkpoints` field: one
 * row per entrega, in the order the teacher arranged them. Parsed defensively
 * since it is still form input crossing the request boundary, even though it
 * came from this app's own client component.
 */
function parseCheckpointsField(value: FormDataEntryValue | null): CheckpointInput[] | null {
  if (typeof value !== 'string') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const rows: CheckpointInput[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null
    const { id, title, deadlineAt, autograderId, closed } = item as Record<string, unknown>
    if (id !== null && typeof id !== 'number') return null
    if (typeof title !== 'string' || title.length > TITLE_MAX_LENGTH) return null
    if (typeof deadlineAt !== 'string') return null
    if (typeof autograderId !== 'string' || autograderId.length > AUTOGRADER_ID_MAX_LENGTH) {
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

/** Port of AssignmentsController#update */
export async function updateAssignmentAction(
  _previous: EditAssignmentState,
  formData: FormData,
): Promise<EditAssignmentState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const assignmentSlug = String(formData.get('assignment_slug') ?? '')

  // The entregas, which live in `checkpoints` and not in the assignment row —
  // one assignment can have several, each with its own date. Parsed before
  // anything is written so a malformed payload costs no round trip.
  const checkpointInputs = parseCheckpointsField(formData.get('checkpoints'))
  if (checkpointInputs === null) {
    return { error: 'No entendimos la lista de entregas.', field: 'base' }
  }

  const result = await updateAssignment(session, classroomSlug, assignmentSlug, {
    title: String(formData.get('title') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    publicRepo: formData.get('visibility') !== 'private',
    // The live site's "Assignment status" dropdown, which replaced the
    // archived `toggle_invitations` checkbox. A select always posts a value,
    // so unlike the checkbox of the new form there is nothing absent to read.
    invitationsEnabled: formData.get('assignment_status') === 'active',
    studentsAreRepoAdmins: formData.get('students_are_repo_admins') === 'on',
    starterCodeRepo: String(formData.get('repo_name') ?? ''),
  })

  // render :edit — the form comes back with the message
  if (!result.success) return { error: result.error, field: result.field }

  // Last on purpose: the failures that are actually common here are the title
  // and the prefix, and this way one of those leaves everything untouched. The
  // slug is the one the update just settled on, which may have been renamed.
  const checkpoints = await saveCheckpoints(session, classroomSlug, result.slug, checkpointInputs)

  if (!checkpoints.success) return { error: checkpoints.error, field: 'base' }

  revalidatePath(`/classrooms/${classroomSlug}`)
  // The slug is what the URL carries, so a renamed prefix moves the page
  revalidatePath(`/classrooms/${classroomSlug}/assignments/${assignmentSlug}`)
  // redirect_to organization_assignment_path(@organization, @assignment)
  redirect(`/classrooms/${classroomSlug}/assignments/${result.slug}?updated=1`)
}

/**
 * Port of AssignmentsController#destroy. Soft delete only: the students'
 * repositories stay in the organization — see `deleteAssignment`.
 */
export async function deleteAssignmentAction(
  _previous: EditAssignmentState,
  formData: FormData,
): Promise<EditAssignmentState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const assignmentSlug = String(formData.get('assignment_slug') ?? '')

  const result = await deleteAssignment(session, classroomSlug, assignmentSlug)
  if (!result.success) return { error: result.error, field: 'base' }

  revalidatePath(`/classrooms/${classroomSlug}`)
  // redirect_to @organization
  redirect(`/classrooms/${classroomSlug}?deleted=1`)
}
