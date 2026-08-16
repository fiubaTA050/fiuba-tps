'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import {
  deleteAssignment,
  updateAssignment,
  type AssignmentField,
} from '@/lib/data/assignments'
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
