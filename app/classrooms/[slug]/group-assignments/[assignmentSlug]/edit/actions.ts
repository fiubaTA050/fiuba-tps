'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import {
  deleteGroupAssignment,
  updateGroupAssignment,
  type GroupAssignmentField,
} from '@/lib/data/group-assignments'
import { limitField, optionalText } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

export type EditGroupAssignmentState = {
  error: string | null
  field: GroupAssignmentField | null
}

/** Port of GroupAssignmentsController#update */
export async function updateGroupAssignmentAction(
  _previous: EditGroupAssignmentState,
  formData: FormData,
): Promise<EditGroupAssignmentState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const assignmentSlug = String(formData.get('assignment_slug') ?? '')

  const result = await updateGroupAssignment(session, classroomSlug, assignmentSlug, {
    title: String(formData.get('title') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    publicRepo: formData.get('visibility') !== 'private',
    invitationsEnabled: formData.get('assignment_status') === 'active',
    studentsAreRepoAdmins: formData.get('students_are_repo_admins') === 'on',
    starterCodeRepo: String(formData.get('repo_name') ?? ''),
    autograderId: optionalText(formData.get('autograder_id')),
    // An empty number field means "no limit", which is the column's null
    maxMembers: limitField(formData.get('max_members')),
    maxTeams: limitField(formData.get('max_teams')),
  })

  if (!result.success) return { error: result.error, field: result.field }

  revalidatePath(`/classrooms/${classroomSlug}`)
  revalidatePath(`/classrooms/${classroomSlug}/group-assignments/${assignmentSlug}`)
  redirect(`/classrooms/${classroomSlug}/group-assignments/${result.slug}?updated=1`)
}

/** Port of GroupAssignmentsController#destroy. Soft delete only */
export async function deleteGroupAssignmentAction(
  _previous: EditGroupAssignmentState,
  formData: FormData,
): Promise<EditGroupAssignmentState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const assignmentSlug = String(formData.get('assignment_slug') ?? '')

  const result = await deleteGroupAssignment(session, classroomSlug, assignmentSlug)
  if (!result.success) return { error: result.error, field: 'base' }

  revalidatePath(`/classrooms/${classroomSlug}`)
  redirect(`/classrooms/${classroomSlug}?deleted=1`)
}
