'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { acceptGroupInvitation, joinRosterForGroup } from '@/lib/data/group-invitations'
import { positiveInteger, type InvitationActionState } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

/**
 * Port of GroupAssignmentInvitationsController#accept_invitation,
 * #accept_assignment and #join_roster.
 *
 * The original has two accept actions: #accept_invitation, which carries the
 * team the student picked, and #accept_assignment, which carries nothing
 * because by then they are already on one. Both call `create_group_assignment_repo`
 * and land on the same place, and `redeem_for` already prefers the team the
 * student is on over anything posted, so one action covers both here — the
 * confirm screen simply posts no selection.
 */

export async function acceptTeamAction(
  _previous: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const key = String(formData.get('key') ?? '')

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/group-assignment-invitations/${key}`)

  const groupId = positiveInteger(formData.get('group_id'))
  const title = String(formData.get('group_title') ?? '')

  const result = await acceptGroupInvitation(
    session,
    key,
    groupId === null ? { title } : { groupId },
  )

  // flash[:error] = result.error, then back to #show
  if (!result.success) return { error: result.error, notice: null }

  redirect(`/group-assignment-invitations/${key}/setup`)
}

/** Port of InvitationsControllerMethods#join_roster, the group controller's copy */
export async function joinRosterAction(
  _previous: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const key = String(formData.get('key') ?? '')

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/group-assignment-invitations/${key}`)

  const entryId = positiveInteger(formData.get('roster_entry_id'))

  if (entryId === null) {
    return { error: 'No encontramos ese identificador en la lista de alumnos.', notice: null }
  }

  const result = await joinRosterForGroup(session, key, entryId)

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/group-assignment-invitations/${key}`)
  redirect(`/group-assignment-invitations/${key}?joined=1`)
}
