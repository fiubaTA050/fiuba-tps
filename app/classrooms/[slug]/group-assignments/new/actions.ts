'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { createGroupAssignment, type GroupAssignmentField } from '@/lib/data/group-assignments'
import { limitField, optionalText, positiveInteger } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

export type CreateGroupAssignmentState = {
  error: string | null
  field: GroupAssignmentField | null
}

/** Port of GroupAssignmentsController#create */
export async function createGroupAssignmentAction(
  _previous: CreateGroupAssignmentState,
  formData: FormData,
): Promise<CreateGroupAssignmentState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')

  const result = await createGroupAssignment(session, classroomSlug, {
    title: String(formData.get('title') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    publicRepo: formData.get('visibility') !== 'private',
    invitationsEnabled: formData.get('invitations_enabled') === 'on',
    studentsAreRepoAdmins: formData.get('students_are_repo_admins') === 'on',
    starterCodeRepo: String(formData.get('repo_name') ?? ''),
    autograderId: optionalText(formData.get('autograder_id')),
    // `group_assignment[grouping_id]` and `grouping[title]`, the two halves of
    // GroupAssignmentService
    groupingId: positiveInteger(formData.get('grouping_id')),
    groupingTitle: String(formData.get('grouping_title') ?? ''),
    // Blank means no limit, which is what the original's empty number_field does
    maxMembers: limitField(formData.get('max_members')),
    maxTeams: limitField(formData.get('max_teams')),
  })

  if (!result.success) return { error: result.error, field: result.field }

  revalidatePath(`/classrooms/${classroomSlug}`)
  redirect(`/classrooms/${classroomSlug}/group-assignments/${result.slug}?created=1`)
}
