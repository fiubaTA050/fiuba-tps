'use client'

import { useActionState, useRef, useState } from 'react'

import { addStudentsAction } from './actions'
import { IdentifiersField } from './IdentifiersField'
import { EMPTY_STATE } from './state'

/**
 * The "Update students" button of the live roster page, and the modal behind
 * it. Its content is the original's `orgs/rosters/_new_student_modal.html.erb`
 * minus the LMS half.
 *
 * The live site opens it with Primer's Overlay and a `dialog-helper` element;
 * here it is a native `<dialog>` opened with `showModal()`, which brings the
 * backdrop, the focus trap and Escape for free. The frame is `Box Box--overlay`
 * — see app/globals.css.
 */
export function AddStudentsDialog({
  classroomSlug,
  identifierName,
}: {
  classroomSlug: string
  identifierName: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [identifiers, setIdentifiers] = useState('')
  const [state, formAction, pending] = useActionState(addStudentsAction, EMPTY_STATE)

  // Once they are on the roster, leaving the list in the textarea only invites
  // pasting it twice — and the second paste would be suffixed, not rejected.
  // Adjusted during render rather than in an effect, which is what React asks
  // for when state has to follow something that arrived from outside; a failed
  // submission carries no `submission`, so what was typed survives it. The
  // dialog stays open on purpose: the live site closes it and answers with a
  // page-level flash, and there is no flash store here to hand the message to.
  const [handled, setHandled] = useState<string | undefined>(undefined)
  if (state.submission && state.submission !== handled) {
    setHandled(state.submission)
    setIdentifiers('')
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => dialog.current?.showModal()}
      >
        Agregar alumnos
      </button>

      <dialog ref={dialog} className="modal" aria-labelledby="add-students-title">
        <div className="Box Box--overlay text-left">
          <div className="Box-header d-flex flex-justify-between flex-items-center">
            <h2 className="Box-title" id="add-students-title">
              Agregar alumnos al roster
            </h2>
            <button
              type="button"
              className="btn-octicon"
              aria-label="Cerrar"
              onClick={() => dialog.current?.close()}
            >
              ✕
            </button>
          </div>

          <form action={formAction}>
            <input type="hidden" name="classroom_slug" value={classroomSlug} />

            <div className="Box-body">
              {state.error && <div className="flash flash-error mb-3">{state.error}</div>}
              {state.notice && <div className="flash flash-success mb-3">{state.notice}</div>}

              <IdentifiersField
                label="Pegá los alumnos que faltan"
                identifierName={identifierName}
                value={identifiers}
                onChange={setIdentifiers}
                framed={false}
              />
            </div>

            <div className="Box-footer d-flex flex-justify-end">
              <button
                type="button"
                className="btn mr-2"
                onClick={() => dialog.current?.close()}
              >
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending ? 'Agregando…' : 'Agregar al roster'}
              </button>
            </div>
          </form>
        </div>
      </dialog>
    </>
  )
}
