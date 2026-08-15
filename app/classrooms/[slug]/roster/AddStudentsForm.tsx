'use client'

import { useActionState, useState } from 'react'

import { addStudentsAction } from './actions'
import { IdentifiersField } from './IdentifiersField'
import { EMPTY_STATE } from './state'

/**
 * Port of orgs/rosters/_new_student_modal.html.erb, the "Update students"
 * modal. The port uses a `<details>` disclosure instead: the original's modals
 * came from remodal, a jQuery plugin that is not here, and a disclosure is what
 * Primer offers for this.
 */
export function AddStudentsForm({
  classroomSlug,
  identifierName,
}: {
  classroomSlug: string
  identifierName: string
}) {
  const [identifiers, setIdentifiers] = useState('')
  const [state, formAction, pending] = useActionState(addStudentsAction, EMPTY_STATE)

  // Once they are on the roster, leaving the list in the textarea only invites
  // pasting it twice — and the second paste would be suffixed, not rejected.
  // Adjusted during render rather than in an effect, which is what React asks
  // for when state has to follow something that arrived from outside; a failed
  // submission carries no `submission`, so what was typed survives it.
  const [handled, setHandled] = useState<string | undefined>(undefined)
  if (state.submission && state.submission !== handled) {
    setHandled(state.submission)
    setIdentifiers('')
  }

  return (
    <details className="details-reset">
      <summary className="btn btn-primary" role="button">
        Agregar alumnos
      </summary>

      <form action={formAction} className="mt-3">
        <input type="hidden" name="classroom_slug" value={classroomSlug} />

        {state.error && <div className="flash flash-error mb-3">{state.error}</div>}
        {state.notice && <div className="flash flash-success mb-3">{state.notice}</div>}

        <IdentifiersField
          label="Pegá los alumnos que faltan"
          identifierName={identifierName}
          value={identifiers}
          onChange={setIdentifiers}
        />

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Agregando…' : 'Agregar al roster'}
          </button>
        </div>
      </form>
    </details>
  )
}
