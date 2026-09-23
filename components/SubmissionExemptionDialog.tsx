'use client'

import { ClockIcon, GitPullRequestIcon } from '@primer/octicons-react'
import { useActionState, useRef } from 'react'

import { setSubmissionExemptionAction } from '@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions'
import { EMPTY_STATE, type RosterActionState } from '@/app/classrooms/[slug]/roster/state'

/**
 * "Habilitar reentrega" / "Revocar reentrega" on a dashboard row, over an
 * entrega the teacher already closed. See `submissionExemptions` in
 * db/schema.ts.
 *
 * Port of the live site's `extend-assignment-deadline-<id>` and
 * `revoke-assignment-deadline-<id>` dialogs (saved capture of the group
 * dashboard): a warning banner, what the student will be able to do, and that
 * it can be undone. What it exempts from differs — there the cutoff that
 * removes push access, here the entrega's close. The trigger is not in the
 * capture, the live site paints it by JS, so its placement is new.
 *
 * The frame is the native `<dialog>` of LinkToStudentDialog.
 */
export function SubmissionExemptionDialog({
  name,
  entrega,
  exempt,
  classroomSlug,
  assignmentSlug,
  checkpointId,
  githubRepoId,
}: {
  /** The row's title — the student's login or identifier */
  name: string
  /** "2A", or "la entrega" for the single unnamed one */
  entrega: string
  /** Whether the exemption is active now, which makes this the revoke dialog */
  exempt: boolean
  classroomSlug: string
  assignmentSlug: string
  checkpointId: number
  githubRepoId: number
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, formAction, pending] = useActionState(
    async (previous: RosterActionState, formData: FormData) => {
      const result = await setSubmissionExemptionAction(previous, formData)
      // The row re-renders from the revalidated page with the other dialog;
      // this one would otherwise stay open over it
      if (!result.error) dialog.current?.close()
      return result
    },
    EMPTY_STATE,
  )

  const titleId = `submission-exemption-${checkpointId}-${githubRepoId}`

  return (
    <>
      <button
        type="button"
        className="btn-link Link Link--muted text-small mr-3"
        onClick={() => dialog.current?.showModal()}
      >
        {exempt ? 'Revocar reentrega' : 'Habilitar reentrega'}
      </button>

      <dialog ref={dialog} className="modal" aria-labelledby={titleId}>
        <div className="Box Box--overlay text-left">
          <div className="Box-header d-flex flex-justify-between flex-items-center">
            <h2 className="Box-title" id={titleId}>
              {exempt ? `Revocar la reentrega de ${name}` : `Habilitar la reentrega de ${name}`}
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

            <div className="flash flash-warn">
              <strong>
                {exempt
                  ? `Vas a revocar la reentrega de ${name}.`
                  : `Vas a exceptuar a ${name} del cierre de ${entrega}.`}
              </strong>
            </div>

            <div className="mt-3 px-2 d-flex">
              <GitPullRequestIcon className={`mr-3 flex-shrink-0 ${exempt ? '' : 'color-fg-success'}`} />
              <p className="mb-0">
                {exempt
                  ? `No va a poder confirmar más entregas para ${entrega}. La que tenga confirmada es la que se corrige.`
                  : `Va a poder confirmar una entrega nueva para ${entrega} aunque esté cerrada.`}
              </p>
            </div>
            <div className="mt-2 px-2 d-flex">
              <ClockIcon className="mr-3 flex-shrink-0" />
              <p className="mb-0">
                {exempt
                  ? 'Podés volver a habilitarla cuando quieras.'
                  : 'Podés revocarla cuando quieras.'}
              </p>
            </div>
          </div>

          <div className="Box-footer">
            <form action={formAction}>
              <input type="hidden" name="classroom_slug" value={classroomSlug} />
              <input type="hidden" name="assignment_slug" value={assignmentSlug} />
              <input type="hidden" name="checkpoint_id" value={checkpointId} />
              <input type="hidden" name="github_repo_id" value={githubRepoId} />
              <input type="hidden" name="exempt" value={exempt ? '0' : '1'} />
              <button type="submit" className="btn btn-danger btn-block" disabled={pending}>
                {exempt
                  ? `Entiendo, revocar la reentrega de ${name}`
                  : `Entiendo, habilitar la reentrega de ${name}`}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  )
}
