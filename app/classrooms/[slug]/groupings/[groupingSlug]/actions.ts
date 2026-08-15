'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { moveMember } from '@/lib/data/groups'
import { positiveInteger, type InvitationActionState } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

/**
 * Port of GroupsController#add_membership and #remove_membership.
 *
 * One action for both, because from the teacher's side it is one gesture with
 * a destination that may be "ningún equipo". The original split it in two
 * endpoints and then never called either — see `moveMember`.
 */
export async function moveMemberAction(
  _previous: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const groupingSlug = String(formData.get('grouping_slug') ?? '')
  const userId = positiveInteger(formData.get('user_id'))

  if (userId === null) {
    return { error: 'No encontramos a ese alumno.', notice: null }
  }

  // The select posts "" for "sacarlo del equipo"
  const targetGroupId = positiveInteger(formData.get('target_group_id'))

  const result = await moveMember(session, classroomSlug, groupingSlug, userId, targetGroupId)

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}/groupings/${groupingSlug}`)

  return {
    error: null,
    notice: targetGroupId
      ? 'Listo. Le va a llegar una invitación de GitHub al repo del equipo nuevo, o la va a tomar sola la próxima vez que abra el link del TP.'
      : 'Listo, quedó sin equipo y perdió el acceso a los repos del anterior.',
  }
}
