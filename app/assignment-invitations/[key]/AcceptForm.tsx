'use client'

import { useActionState } from 'react'

import { acceptAction } from './actions'
import { EMPTY_STATE } from '@/lib/form'

/**
 * The `form_tag` of `assignment_invitations/show.html.erb`, whose only control
 * is `submit_tag 'Accept this assignment'`.
 *
 * A client component only so the failure of #accept — invitations turned off
 * between rendering and clicking — can come back next to the button, where the
 * original put its flash.
 */
export function AcceptForm({ invitationKey }: { invitationKey: string }) {
  const [state, action, pending] = useActionState(acceptAction, EMPTY_STATE)

  return (
    <form action={action}>
      <input type="hidden" name="key" value={invitationKey} />

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Aceptando…' : 'Aceptar este assignment'}
      </button>
    </form>
  )
}
