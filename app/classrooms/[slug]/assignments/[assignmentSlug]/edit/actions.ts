'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import {
  deleteAssignment,
  updateAssignment,
  type AssignmentField,
} from '@/lib/data/assignments'
import { saveAssignmentCheckpoint } from '@/lib/data/checkpoints'
import { parseArgentinaDateTime } from '@/lib/dates'
import { optionalText } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

export type EditAssignmentState = { error: string | null; field: AssignmentField | null }

/** Port of AssignmentsController#update */
export async function updateAssignmentAction(
  _previous: EditAssignmentState,
  formData: FormData,
): Promise<EditAssignmentState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const assignmentSlug = String(formData.get('assignment_slug') ?? '')

  // The entrega and its date, which live in `checkpoints` and not in the
  // assignment row — one assignment can have several entregas with a date each.
  // Parsed before anything is written so a malformed date costs no round trip.
  const submissionsEnabled = formData.get('submissions_enabled') === 'on'
  const rawDeadline = String(formData.get('deadline_at') ?? '').trim()
  const deadlineAt = rawDeadline === '' ? null : parseArgentinaDateTime(rawDeadline)

  if (rawDeadline !== '' && deadlineAt === null) {
    return { error: 'Esa fecha de entrega no se entiende.', field: 'base' }
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
    autograderId: optionalText(formData.get('autograder_id')),
  })

  // render :edit — the form comes back with the message
  if (!result.success) return { error: result.error, field: result.field }

  // Last on purpose: the failures that are actually common here are the title
  // and the prefix, and this way one of those leaves everything untouched. The
  // slug is the one the update just settled on, which may have been renamed.
  const checkpoint = await saveAssignmentCheckpoint(session, classroomSlug, result.slug, {
    enabled: submissionsEnabled,
    deadlineAt,
  })

  if (!checkpoint.success) return { error: checkpoint.error, field: 'base' }

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
