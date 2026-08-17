'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { linkAccountToEntry } from '@/lib/data/rosters'
import { positiveInteger } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

import { EMPTY_STATE, type RosterActionState } from '../../roster/state'

/**
 * Port of RostersController#link, reached from the assignment dashboard.
 *
 * The action belongs to the roster — it writes `roster_entries.user_id`, and
 * lib/data/rosters.ts is where the boundary lives — but it sits here because
 * this is the screen that raises it, and because the revalidation needs the
 * assignment slug the roster route knows nothing about.
 */
export async function linkAccountAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const assignmentSlug = String(formData.get('assignment_slug') ?? '')
  const entryId = positiveInteger(formData.get('entry_id'))
  const userId = positiveInteger(formData.get('user_id'))

  // The original raises ActiveRecordError on both and rescues into one message
  if (entryId === null || userId === null) {
    return { error: 'No pudimos vincular esa cuenta. Probá de nuevo.', notice: null }
  }

  const result = await linkAccountToEntry(session, classroomSlug, entryId, userId)

  if (!result.success) return { error: result.error, notice: null }

  // The dashboard is force-dynamic, so this is what makes the two rows collapse
  // into one without the teacher reloading: the account row disappears and the
  // identifier row picks up the avatar.
  revalidatePath(`/classrooms/${classroomSlug}/assignments/${assignmentSlug}`)
  revalidatePath(`/classrooms/${classroomSlug}/roster`)

  return EMPTY_STATE
}
