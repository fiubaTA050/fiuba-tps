'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { createAssignment, type AssignmentField } from '@/lib/data/assignments'
import { isUsableSession } from '@/lib/session'

export type CreateAssignmentState = { error: string | null; field: AssignmentField | null }

/** Port of AssignmentsController#create */
export async function createAssignmentAction(
  _previous: CreateAssignmentState,
  formData: FormData,
): Promise<CreateAssignmentState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')

  const result = await createAssignment(session, classroomSlug, {
    title: String(formData.get('title') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    // `def visibility=(visibility)` in the original: public_repo = visibility != "private"
    publicRepo: formData.get('visibility') !== 'private',
    // Unchecked checkboxes are absent from FormData, which is exactly Rails'
    // `check_box` behaviour minus its hidden "0" companion.
    invitationsEnabled: formData.get('invitations_enabled') === 'on',
    studentsAreRepoAdmins: formData.get('students_are_repo_admins') === 'on',
  })

  // render :new — the form comes back with the message
  if (!result.success) return { error: result.error, field: result.field }

  revalidatePath(`/classrooms/${classroomSlug}`)
  // redirect_to organization_assignment_path(@organization, @assignment)
  redirect(`/classrooms/${classroomSlug}/assignments/${result.slug}?created=1`)
}
