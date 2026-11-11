'use client'

import { useActionState, useRef } from 'react'

import { EMPTY_STATE, type RosterActionState } from '@/app/classrooms/[slug]/roster/state'

import { removeTeachingAssistantAction } from './actions'

/**
 * "Sacar" and its confirmation, the live site's "Are you sure you want to
 * remove this administrator?" dialog. What it warns about is different: here
 * removing takes away what the TA was allocated, and nothing on GitHub.
 */
export function RemoveTeachingAssistantButton({
  classroomSlug,
  teachingAssistantId,
  login,
}: {
  classroomSlug: string
  teachingAssistantId: number
  login: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, action, pending] = useActionState(
    async (previous: RosterActionState, formData: FormData) => {
      const result = await removeTeachingAssistantAction(previous, formData)
      // On success the row is gone with the revalidation, dialog and all
      if (!result.error) dialog.current?.close()
      return result
    },
    EMPTY_STATE,
  )

  const titleId = `remove-teaching-assistant-${teachingAssistantId}`

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        aria-label={`Sacar a @${login}`}
        onClick={() => dialog.current?.showModal()}
      >
        Sacar
      </button>

      <dialog ref={dialog} className="modal" aria-labelledby={titleId}>
        <form action={action} className="Box Box--overlay text-left">
          <input type="hidden" name="classroom_slug" value={classroomSlug} />
          <input type="hidden" name="teaching_assistant_id" value={teachingAssistantId} />

          <div className="Box-header d-flex flex-justify-between flex-items-center">
            <h2 className="Box-title" id={titleId}>
              ¿Sacar a @{login} de los ayudantes?
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

          <div className="Box-body">
            {state.error && <div className="flash flash-error mb-3">{state.error}</div>}
            <p>Deja de ver este classroom, y se borran los alumnos y equipos que tenía asignados.</p>
            <p className="mb-0">
              Las devoluciones que escribió se quedan. No se toca nada en GitHub.
            </p>
          </div>

          <div className="Box-footer d-flex flex-justify-end">
            <button type="button" className="btn mr-2" onClick={() => dialog.current?.close()}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-danger" disabled={pending}>
              {pending ? 'Sacando…' : 'Sacar ayudante'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
