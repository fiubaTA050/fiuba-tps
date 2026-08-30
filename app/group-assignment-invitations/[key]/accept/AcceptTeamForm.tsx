'use client'

import { useActionState } from 'react'

import { EMPTY_STATE } from '@/lib/form'

import { acceptTeamAction } from '../actions'

/**
 * The `form_tag` of `group_assignment_invitations/accept.html.erb`, whose only
 * control is `submit_tag 'Accept this assignment'`.
 *
 * It posts no team: `redeem_for` prefers the one the student is already on over
 * anything in the form, which is why the original's #accept_assignment takes no
 * parameters either.
 */
export function AcceptTeamForm({ invitationKey }: { invitationKey: string }) {
  const [state, action, pending] = useActionState(acceptTeamAction, EMPTY_STATE)

  return (
    <form action={action}>
      <input type="hidden" name="key" value={invitationKey} />

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Aceptando…' : 'Aceptar este trabajo práctico'}
      </button>
    </form>
  )
}
