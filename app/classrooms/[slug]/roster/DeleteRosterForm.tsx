'use client'

import { useActionState } from 'react'

import { deleteRosterAction } from './actions'
import { EMPTY_STATE } from './state'

/**
 * Port of the "Delete this roster" boxed-group of rosters/show.html.erb and
 * its `_remove_roster_modal` — the modal is a `confirm()` here, see
 * RosterEntryRow.
 */
export function DeleteRosterForm({ classroomSlug }: { classroomSlug: string }) {
  const [state, formAction, pending] = useActionState(deleteRosterAction, EMPTY_STATE)

  return (
    <form action={formAction}>
      <input type="hidden" name="classroom_slug" value={classroomSlug} />

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

      <button
        type="submit"
        className="btn btn-sm btn-danger"
        disabled={pending}
        onClick={(event) => {
          if (!window.confirm('¿Eliminar la lista y todos sus alumnos?')) event.preventDefault()
        }}
      >
        {pending ? 'Eliminando…' : 'Eliminar la lista'}
      </button>
    </form>
  )
}
