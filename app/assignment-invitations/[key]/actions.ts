'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { acceptInvitation, joinRoster } from '@/lib/data/invitations'
import { confirmSubmission } from '@/lib/data/submissions'
import { positiveInteger, type InvitationActionState } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

/**
 * Port of AssignmentInvitationsController#accept and #join_roster.
 *
 * Neither redirects to `/` when the session is unusable, the way the teacher's
 * actions do: a student who lost their token belongs back on the invitation,
 * which is the page that knows how to ask them to sign in. `/` would send them
 * to a login that lands on /classrooms and lose the assignment entirely.
 */

/** Port of #accept, whose `route_based_on_status` then lands on #setup */
export async function acceptAction(
  _previous: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const key = String(formData.get('key') ?? '')

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/assignment-invitations/${key}`)

  const result = await acceptInvitation(session, key)

  // flash[:error] = result.error, then back to #show
  if (!result.success) return { error: result.error, notice: null }

  redirect(`/assignment-invitations/${key}/setup`)
}

/** Port of AssignmentInvitationsController#join_roster */
export async function joinRosterAction(
  _previous: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const key = String(formData.get('key') ?? '')

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/assignment-invitations/${key}`)

  const entryId = positiveInteger(formData.get('roster_entry_id'))

  // `roster_entries.find("not_an_id")` raising RecordNotFound, which the
  // original rescued into a flash and a re-render of join_roster
  if (entryId === null) {
    return { error: 'No encontramos ese identificador en la lista de alumnos.', notice: null }
  }

  const result = await joinRoster(session, key, entryId)

  if (!result.success) return { error: result.error, notice: null }

  // `redirect_to assignment_invitation_url(current_invitation)`. The flash it
  // set there names the entry; the page reads that off the link it just made,
  // so only the fact that a link happened has to travel.
  revalidatePath(`/assignment-invitations/${key}`)
  redirect(`/assignment-invitations/${key}?joined=1`)
}

/**
 * The student confirms a ref of their repository as their entrega.
 *
 * No equivalent in the original: there the submission was whatever HEAD its
 * `DeadlineJob` happened to see. Here the student chooses the tree, and the
 * deadline never refuses — a late confirmation is accepted and read as `Tarde`.
 * See docs/entregas.md.
 */
export async function confirmSubmissionAction(
  _previous: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const key = String(formData.get('key') ?? '')

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/assignment-invitations/${key}`)

  const result = await confirmSubmission(
    session,
    key,
    String(formData.get('ref') ?? ''),
    String(formData.get('ai_declaration') ?? ''),
  )

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/assignment-invitations/${key}/setup`)

  if (result.unchanged) {
    return { error: null, notice: 'Esa entrega ya estaba confirmada: no cambió nada.' }
  }

  const confirmed = `Entrega confirmada: ${result.sha.slice(0, 7)}.`

  // The warning rides along with the confirmation rather than replacing it —
  // the entrega *was* recorded, and saying only the caveat reads as a failure
  return { error: null, notice: result.warning ? `${confirmed} ${result.warning}` : confirmed }
}
