'use client'

import { CalendarIcon, ClockIcon, GitPullRequestIcon, KebabHorizontalIcon } from '@primer/octicons-react'
import { useActionState, useRef } from 'react'

import { setSubmissionExemptionAction } from '@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions'
import { EMPTY_STATE, type RosterActionState } from '@/app/classrooms/[slug]/roster/state'

/**
 * The ⋯ at the end of a dashboard row, over an entrega the teacher already
 * closed: "Extender entrega" / "Revocar extensión". See `submissionExemptions`
 * in db/schema.ts.
 *
 * Port of the live site's per-row "Actions:" menu with its calendar-iconed
 * "Extend deadline" / "Revoke extension" (GitHub Docs, "Extending an
 * assignment's deadline for an individual or group", whose screenshot shows
 * it right of "Repository"), and of the `extend-assignment-deadline-<id>` /
 * `revoke-assignment-deadline-<id>` dialogs in the saved capture of the group
 * dashboard — the menu itself is painted by JS and is not in that capture.
 * What it extends differs: there the cutoff that removes push access, here
 * the entrega's close.
 *
 * The menu is the classroom card's kebab (ClassroomList.tsx); the dialog is
 * the native `<dialog>` of LinkToStudentDialog. Deliberate divergence from the
 * live dialog's footer, a single full-width `btn-danger` "I understand, …":
 * here it is the app's own right-aligned Cancelar + action, and red only for
 * revoking — extending takes nothing away from the student, and `btn-danger`
 * is what this app reserves for destructive actions.
 */
export function SubmissionExtensionMenu({
  name,
  entrega,
  extended,
  classroomSlug,
  assignmentSlug,
  checkpointId,
  githubRepoId,
}: {
  /** The row's title — the student's login or identifier */
  name: string
  /** "2A", or "la entrega" for the single unnamed one */
  entrega: string
  /** Whether the extension is active now, which makes this the revoke flow */
  extended: boolean
  classroomSlug: string
  assignmentSlug: string
  checkpointId: number
  githubRepoId: number
}) {
  const menu = useRef<HTMLDetailsElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, formAction, pending] = useActionState(
    async (previous: RosterActionState, formData: FormData) => {
      const result = await setSubmissionExemptionAction(previous, formData)
      // The row re-renders from the revalidated page in the other state; this
      // dialog would otherwise stay open over it
      if (!result.error) dialog.current?.close()
      return result
    },
    EMPTY_STATE,
  )

  const titleId = `submission-extension-${checkpointId}-${githubRepoId}`

  function openDialog() {
    menu.current?.removeAttribute('open')
    dialog.current?.showModal()
  }

  return (
    <>
      <details
        ref={menu}
        className="dropdown details-reset details-overlay d-inline-block position-relative"
      >
        <summary className="btn-octicon m-0" aria-haspopup="menu" aria-label={`Acciones de ${name}`}>
          <KebabHorizontalIcon />
        </summary>

        <div className="ActionMenu-anchor ActionMenu-anchor--right">
          <div className="Overlay Overlay--size-auto">
            <div className="Overlay-body Overlay-body--paddingNone">
              <ul role="menu" className="ActionListWrap ActionListWrap--inset">
                <li className="ActionList-sectionDivider" role="presentation">
                  <div className="ActionList-sectionDivider-title">Acciones:</div>
                </li>

                <li role="none" className="ActionListItem">
                  <button
                    type="button"
                    role="menuitem"
                    className="ActionListContent ActionListContent--visual16"
                    onClick={openDialog}
                  >
                    <span className="ActionListItem-visual ActionListItem-action--leading">
                      <CalendarIcon />
                    </span>
                    <span className="ActionListItem-label">
                      {extended ? 'Revocar extensión' : 'Extender entrega'}
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </details>

      <dialog ref={dialog} className="modal" aria-labelledby={titleId}>
        <div className="Box Box--overlay text-left">
          <div className="Box-header d-flex flex-justify-between flex-items-center">
            <h2 className="Box-title" id={titleId}>
              {extended ? `Revocar la extensión de ${name}` : `Extender la entrega de ${name}`}
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
                {extended
                  ? `Vas a revocar la extensión de ${name}.`
                  : `Vas a extender ${entrega} para ${name}.`}
              </strong>
            </div>

            <div className="mt-3 px-2 d-flex">
              <GitPullRequestIcon className={`mr-3 flex-shrink-0 ${extended ? '' : 'color-fg-success'}`} />
              <p className="mb-0">
                {extended
                  ? `No va a poder confirmar más entregas para ${entrega}. La que tenga confirmada es la que se corrige.`
                  : `Va a poder confirmar una entrega nueva para ${entrega} aunque esté cerrada.`}
              </p>
            </div>
            <div className="mt-2 px-2 d-flex">
              <ClockIcon className="mr-3 flex-shrink-0" />
              <p className="mb-0">
                {extended
                  ? 'Podés volver a extenderla cuando quieras.'
                  : 'Podés revocar la extensión cuando quieras.'}
              </p>
            </div>
          </div>

          <form action={formAction} className="Box-footer d-flex flex-justify-end">
            <input type="hidden" name="classroom_slug" value={classroomSlug} />
            <input type="hidden" name="assignment_slug" value={assignmentSlug} />
            <input type="hidden" name="checkpoint_id" value={checkpointId} />
            <input type="hidden" name="github_repo_id" value={githubRepoId} />
            <input type="hidden" name="exempt" value={extended ? '0' : '1'} />
            <button type="button" className="btn mr-2" onClick={() => dialog.current?.close()}>
              Cancelar
            </button>
            {extended ? (
              <button type="submit" className="btn btn-danger" disabled={pending}>
                {pending ? 'Revocando…' : 'Revocar extensión'}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending ? 'Extendiendo…' : 'Extender entrega'}
              </button>
            )}
          </form>
        </div>
      </dialog>
    </>
  )
}
