'use client'

import {
  CalendarIcon,
  ClockIcon,
  CommentIcon,
  GitPullRequestIcon,
  NoteIcon,
  KebabHorizontalIcon,
} from '@primer/octicons-react'
import Link from 'next/link'
import { type ReactNode, type RefObject, useActionState, useRef, useState } from 'react'

import { setSubmissionExemptionAction } from '@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions'
import { EMPTY_STATE, type RosterActionState } from '@/app/classrooms/[slug]/roster/state'
import type { AssignmentKind } from '@/lib/assignment-paths'
import { toArgentinaDateTimeInput } from '@/lib/dates'

import { LateJustificationDialog, type LateJustificationTarget } from './LateJustificationDialog'

type Extension = {
  /** "2A", or "la entrega" for the single unnamed one */
  entrega: string
  /** When the active extension runs out; null when there is none to change or revoke */
  extendedUntil: Date | null
  classroomSlug: string
  assignmentSlug: string
  kind: AssignmentKind
  checkpointId: number
  githubRepoId: number
}

/**
 * The ⋯ at the end of a dashboard row. Three independent items, each only
 * where it means something: "Extender entrega" / "Revocar extensión" over an
 * entrega the teacher already closed (`submissionExemptions` in db/schema.ts),
 * plus "Cambiar fecha de la extensión" over an active one,
 * "Justificar entrega tardía" / "Quitar justificación" over a current
 * submission that is late (`lateSubmissionJustifications`, LateJustificationDialog),
 * and "Escribir devolución" / "Ver devolución" over any current submission —
 * a link to its detail page, which is where the devolución is written.
 * Without it that page is two clicks and a fetch away, behind "Ver entregas
 * anteriores".
 *
 * The extension is a port of the live site's per-row "Actions:" menu with its calendar-iconed
 * "Extend deadline" / "Revoke extension" (GitHub Docs, "Extending an
 * assignment's deadline for an individual or group", whose screenshot shows
 * it right of "Repository"), and of the `extend-assignment-deadline-<id>` /
 * `revoke-assignment-deadline-<id>` dialogs in the saved capture of the group
 * dashboard — the menu itself is painted by JS and is not in that capture.
 * What it extends differs: there the cutoff that removes push access, here
 * the entrega's close, and until a date the teacher has to pick — the live
 * extension has none.
 *
 * The menu is the classroom card's kebab (ClassroomList.tsx); the dialog is
 * the native `<dialog>` of LinkToStudentDialog. Deliberate divergence from the
 * live dialog's footer, a single full-width `btn-danger` "I understand, …":
 * here it is the app's own right-aligned Cancelar + action, and red only for
 * revoking — extending takes nothing away from the student, and `btn-danger`
 * is what this app reserves for destructive actions.
 */
export function SubmissionActionsMenu({
  name,
  extension,
  justification,
  feedback,
}: {
  /** The row's title — the student's login or identifier */
  name: string
  /** Absent on an open entrega: there is nothing to extend */
  extension: Extension | null
  /** Absent unless the current submission is late */
  justification: LateJustificationTarget | null
  /** Absent when nothing is confirmed: there is nothing to write about */
  feedback: { href: string; exists: boolean } | null
}) {
  const menu = useRef<HTMLDetailsElement>(null)
  const extensionDialog = useRef<HTMLDialogElement>(null)
  const changeDateDialog = useRef<HTMLDialogElement>(null)
  const justificationDialog = useRef<HTMLDialogElement>(null)

  function open(dialog: RefObject<HTMLDialogElement | null>) {
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

                {extension?.extendedUntil && (
                  <MenuItem icon={<CalendarIcon />} onClick={() => open(changeDateDialog)}>
                    Cambiar fecha de la extensión
                  </MenuItem>
                )}

                {extension && (
                  <MenuItem icon={<CalendarIcon />} onClick={() => open(extensionDialog)}>
                    {extension.extendedUntil ? 'Revocar extensión' : 'Extender entrega'}
                  </MenuItem>
                )}

                {justification && (
                  <MenuItem icon={<CommentIcon />} onClick={() => open(justificationDialog)}>
                    {justification.reason === null
                      ? 'Justificar entrega tardía'
                      : 'Quitar justificación'}
                  </MenuItem>
                )}

                {feedback && (
                  <li role="none" className="ActionListItem">
                    <Link
                      href={feedback.href}
                      role="menuitem"
                      className="ActionListContent ActionListContent--visual16"
                    >
                      <span className="ActionListItem-visual ActionListItem-action--leading">
                        <NoteIcon />
                      </span>
                      <span className="ActionListItem-label">
                        {feedback.exists ? 'Ver devolución' : 'Escribir devolución'}
                      </span>
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </details>

      {extension && (
        <ExtensionDialog
          dialogRef={extensionDialog}
          name={name}
          mode={extension.extendedUntil ? 'revoke' : 'extend'}
          {...extension}
        />
      )}

      {extension?.extendedUntil && (
        <ExtensionDialog dialogRef={changeDateDialog} name={name} mode="change" {...extension} />
      )}

      {justification && (
        <LateJustificationDialog dialogRef={justificationDialog} name={name} target={justification} />
      )}
    </>
  )
}

function MenuItem({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode
  onClick: () => void
  children: ReactNode
}) {
  return (
    <li role="none" className="ActionListItem">
      <button
        type="button"
        role="menuitem"
        className="ActionListContent ActionListContent--visual16"
        onClick={onClick}
      >
        <span className="ActionListItem-visual ActionListItem-action--leading">{icon}</span>
        <span className="ActionListItem-label">{children}</span>
      </button>
    </li>
  )
}

/**
 * One dialog, three flows. Extending and changing the date both post an end
 * date and differ only in their copy; revoking posts none.
 */
function ExtensionDialog({
  dialogRef: dialog,
  name,
  mode,
  entrega,
  extendedUntil,
  classroomSlug,
  assignmentSlug,
  kind,
  checkpointId,
  githubRepoId,
}: Extension & {
  dialogRef: RefObject<HTMLDialogElement | null>
  name: string
  mode: 'extend' | 'change' | 'revoke'
}) {
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

  // Closing without saving forgets the attempt: the date field goes back to
  // the stored one (`reset` restores `defaultValue`) and the last error stops
  // showing. Without this, a date typed and cancelled would be the one
  // "Guardar fecha" sends next time
  const form = useRef<HTMLFormElement>(null)
  const [dismissed, setDismissed] = useState<RosterActionState | null>(null)

  const titleId = `submission-extension-${mode}-${checkpointId}-${githubRepoId}`
  const dateId = `${titleId}-until`
  const revoking = mode === 'revoke'

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onClose={() => {
        form.current?.reset()
        setDismissed(state)
      }}
    >
      <form ref={form} action={formAction} className="Box Box--overlay text-left">
        <div className="Box-header d-flex flex-justify-between flex-items-center">
          <h2 className="Box-title" id={titleId}>
            {mode === 'revoke'
              ? `Revocar la extensión de ${name}`
              : mode === 'change'
                ? `Cambiar la extensión de ${name}`
                : `Extender la entrega de ${name}`}
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
          {state.error && state !== dismissed && (
            <div className="flash flash-error mb-3">{state.error}</div>
          )}

          <div className="flash flash-warn">
            <strong>
              {mode === 'revoke'
                ? `Vas a revocar la extensión de ${name}.`
                : mode === 'change'
                  ? `Vas a cambiar hasta cuándo dura la extensión de ${name}.`
                  : `Vas a extender ${entrega} para ${name}.`}
            </strong>
          </div>

          {!revoking && (
            <div className="form-group mt-3 mb-0">
              <div className="form-group-header">
                <label htmlFor={dateId}>Hasta</label>
              </div>
              <div className="form-group-body">
                {/* Required: an extension with no end is what got forgotten —
                    see submissionExemptions in db/schema.ts. Argentine time,
                    like the deadline on the edit screen (lib/dates.ts) */}
                <input
                  id={dateId}
                  type="datetime-local"
                  name="expires_at"
                  className="form-control"
                  required
                  defaultValue={
                    mode === 'change' && extendedUntil ? toArgentinaDateTimeInput(extendedUntil) : ''
                  }
                />
                <p className="note">Hora de Argentina.</p>
              </div>
            </div>
          )}

          <div className="mt-3 px-2 d-flex">
            <GitPullRequestIcon className={`mr-3 flex-shrink-0 ${revoking ? '' : 'color-fg-success'}`} />
            <p className="mb-0">
              {revoking
                ? `No va a poder confirmar más entregas para ${entrega}. La que tenga confirmada es la que se corrige.`
                : `Va a poder confirmar una entrega nueva para ${entrega} hasta esa fecha, aunque esté cerrada.`}
            </p>
          </div>
          <div className="mt-2 px-2 d-flex">
            <ClockIcon className="mr-3 flex-shrink-0" />
            <p className="mb-0">
              {revoking
                ? 'Podés volver a extenderla cuando quieras.'
                : 'Cuando termine, se corrige la que tenga confirmada. Podés revocarla antes.'}
            </p>
          </div>
        </div>

        <div className="Box-footer d-flex flex-justify-end">
          <input type="hidden" name="classroom_slug" value={classroomSlug} />
          <input type="hidden" name="assignment_slug" value={assignmentSlug} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="checkpoint_id" value={checkpointId} />
          <input type="hidden" name="github_repo_id" value={githubRepoId} />
          <input type="hidden" name="exempt" value={revoking ? '0' : '1'} />
          <input type="hidden" name="mode" value={mode} />
          <button type="button" className="btn mr-2" onClick={() => dialog.current?.close()}>
            Cancelar
          </button>
          {revoking ? (
            <button type="submit" className="btn btn-danger" disabled={pending}>
              {pending ? 'Revocando…' : 'Revocar extensión'}
            </button>
          ) : mode === 'change' ? (
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? 'Guardando…' : 'Guardar fecha'}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? 'Extendiendo…' : 'Extender entrega'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  )
}
