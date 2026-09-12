'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { createAssignment, type AssignmentField } from '@/lib/data/assignments'
import { parseCheckpointsField } from '@/lib/data/checkpoints'
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

  // The entregas, which live in `checkpoints` and not in the assignment row —
  // see docs/entregas.md. Parsed before anything is written so a malformed
  // payload costs no round trip. No `checkpoints_known_ids` here: unlike
  // Editar, there is nothing existing yet to guard against drifting from.
  const checkpointInputs = parseCheckpointsField(formData.get('checkpoints'))
  if (checkpointInputs === null) {
    return { error: 'No entendimos la lista de entregas.', field: 'base' }
  }

  const result = await createAssignment(session, classroomSlug, {
    title: String(formData.get('title') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    // `def visibility=(visibility)` in the original: public_repo = visibility != "private"
    publicRepo: formData.get('visibility') !== 'private',
    // Unchecked checkboxes are absent from FormData, which is exactly Rails'
    // `check_box` behaviour minus its hidden "0" companion.
    invitationsEnabled: formData.get('invitations_enabled') === 'on',
    studentsAreRepoAdmins: formData.get('students_are_repo_admins') === 'on',
    // `repo_name` in the original's new_assignment_params
    starterCodeRepo: String(formData.get('repo_name') ?? ''),
    checkpoints: checkpointInputs,
  })

  // render :new — the form comes back with the message
  if (!result.success) return { error: result.error, field: result.field }

  revalidatePath(`/classrooms/${classroomSlug}`)
  // redirect_to organization_assignment_path(@organization, @assignment)
  redirect(`/classrooms/${classroomSlug}/assignments/${result.slug}?created=1`)
}
