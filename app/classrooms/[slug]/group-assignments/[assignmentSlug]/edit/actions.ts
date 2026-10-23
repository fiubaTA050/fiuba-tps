'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import {
  deleteGroupAssignment,
  updateGroupAssignment,
  type GroupAssignmentField,
} from '@/lib/data/group-assignments'
import {
  parseCheckpointsField,
  parseKnownCheckpointIds,
  saveCheckpoints,
} from '@/lib/data/checkpoints'
import { limitField } from '@/lib/form'
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

  // Parsed before anything is written, as on the individual edit
  const checkpointInputs = parseCheckpointsField(formData.get('checkpoints'))
  if (checkpointInputs === null) {
    return { error: 'No entendimos la lista de entregas.', field: 'base' }
  }
  const knownCheckpointIds = parseKnownCheckpointIds(formData.get('checkpoints_known_ids'))

  const result = await updateGroupAssignment(session, classroomSlug, assignmentSlug, {
    title: String(formData.get('title') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    publicRepo: formData.get('visibility') !== 'private',
    invitationsEnabled: formData.get('assignment_status') === 'active',
    studentsAreRepoAdmins: formData.get('students_are_repo_admins') === 'on',
    starterCodeRepo: String(formData.get('repo_name') ?? ''),
    // An empty number field means "no limit", which is the column's null
    maxMembers: limitField(formData.get('max_members')),
    maxTeams: limitField(formData.get('max_teams')),
  })

  if (!result.success) return { error: result.error, field: result.field }

  // Last, for the same reason as on the individual edit: the common failures
  // are the title and the prefix, and those leave everything untouched
  const checkpoints = await saveCheckpoints(
    session,
    classroomSlug,
    result.slug,
    checkpointInputs,
    knownCheckpointIds ?? undefined,
    'group',
  )

  if (!checkpoints.success) return { error: checkpoints.error, field: 'base' }

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
