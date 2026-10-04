'use client'

import { CommentIcon, EyeIcon, HistoryIcon } from '@primer/octicons-react'
import { type RefObject, useActionState, useRef } from 'react'

import { setLateJustificationAction } from '@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions'
import { EMPTY_STATE, type RosterActionState } from '@/app/classrooms/[slug]/roster/state'

const MAX_REASON_LENGTH = 2000

export type LateJustificationTarget = {
  classroomSlug: string
  assignmentSlug: string
  githubRepoId: number
  submissionId: number
  /** The active justification's reason; null when the submission is not justified */
  reason: string | null
}

/**
 * "Justificar entrega tardía" / "Quitar justificación" — see
 * `lateSubmissionJustifications` in db/schema.ts. No live equivalent to port:
 * its frame is SubmissionActionsMenu's extension dialog, with a textarea for
 * the reason, which is required.
 *
 * The opener holds `dialogRef` and calls `showModal()`. The dialog cannot be
 * rendered by the opener itself when that is a ⋯ menu item: a closed
 * `<details>` does not render its content, modal dialogs included.
 */
export function LateJustificationDialog({
  dialogRef,
  name,
  target,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>
  /** The row's title, when there is one — the detail page has none to hand */
  name: string | null
  target: LateJustificationTarget
}) {
  const justified = target.reason !== null
  const form = useRef<HTMLFormElement>(null)
  const [state, formAction, pending] = useActionState(
    async (previous: RosterActionState, formData: FormData) => {
      const result = await setLateJustificationAction(previous, formData)
      if (!result.error) {
        form.current?.reset()
        dialogRef.current?.close()
      }
      return result
    },
    EMPTY_STATE,
  )

  const titleId = `late-justification-${target.submissionId}`
  const reasonId = `late-justification-reason-${target.submissionId}`
  const whose = name ? `de ${name}` : ''

  return (
    <dialog ref={dialogRef} className="modal" aria-labelledby={titleId}>
      <form ref={form} action={formAction} className="Box Box--overlay text-left">
        <div className="Box-header d-flex flex-justify-between flex-items-center">
          <h2 className="Box-title" id={titleId}>
            {justified ? `Quitar la justificación ${whose}` : `Justificar la entrega tardía ${whose}`}
          </h2>
          <button
            type="button"
            className="btn-octicon"
            aria-label="Cerrar"
            onClick={() => dialogRef.current?.close()}
          >
            ✕
          </button>
        </div>

        <div className="Box-body">
          {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

          {justified ? (
            <>
              <div className="flash flash-warn">
                <strong>La entrega vuelve a figurar como tarde.</strong>
              </div>
              <p className="mt-3 mb-1 text-bold">Motivo de la justificación</p>
              <p className="color-fg-muted mb-3" style={{ whiteSpace: 'pre-wrap' }}>
                {target.reason}
              </p>
              <div className="px-2 d-flex">
                <HistoryIcon className="mr-3 flex-shrink-0" />
                <p className="mb-0">
                  El motivo queda registrado en el detalle de la entrega. Podés volver a
                  justificarla cuando quieras.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="px-2 d-flex">
                <CommentIcon className="mr-3 flex-shrink-0 color-fg-success" />
                <p className="mb-0">
                  Va a figurar como <strong>Tarde · justificada</strong> y contar como entregada a
                  tiempo. Si vuelve a entregar después, la entrega nueva figura tarde otra vez.
                </p>
              </div>
              <div className="mt-2 px-2 d-flex">
                <EyeIcon className="mr-3 flex-shrink-0" />
                <p className="mb-0">
                  El alumno ve que está justificada, pero no el motivo: ese solo lo ven los
                  docentes.
                </p>
              </div>

              <div className="form-group mt-3 mb-0">
                <div className="form-group-header">
                  <label htmlFor={reasonId}>Motivo</label>
                </div>
                <div className="form-group-body">
                  <textarea
                    id={reasonId}
                    name="reason"
                    className="form-control width-full"
                    style={{ minHeight: 100 }}
                    required
                    maxLength={MAX_REASON_LENGTH}
                    placeholder="Por qué se acepta como entregada a tiempo"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="Box-footer d-flex flex-justify-end">
          <input type="hidden" name="classroom_slug" value={target.classroomSlug} />
          <input type="hidden" name="assignment_slug" value={target.assignmentSlug} />
          <input type="hidden" name="github_repo_id" value={target.githubRepoId} />
          <input type="hidden" name="submission_id" value={target.submissionId} />
          <input type="hidden" name="justify" value={justified ? '0' : '1'} />
          <button type="button" className="btn mr-2" onClick={() => dialogRef.current?.close()}>
            Cancelar
          </button>
          {justified ? (
            <button type="submit" className="btn btn-danger" disabled={pending}>
              {pending ? 'Quitando…' : 'Quitar justificación'}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? 'Justificando…' : 'Justificar'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  )
}

/** A plain button that opens the dialog — the detail page's way in */
export function LateJustificationButton({ target }: { target: LateJustificationTarget }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const justified = target.reason !== null

  return (
    <>
      <button
        type="button"
        className={`btn btn-sm ${justified ? 'btn-danger' : ''}`}
        onClick={() => dialog.current?.showModal()}
      >
        {justified ? 'Quitar justificación' : 'Justificar entrega tardía'}
      </button>
      <LateJustificationDialog dialogRef={dialog} name={null} target={target} />
    </>
  )
}
