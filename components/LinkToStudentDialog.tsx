'use client'

import { useActionState, useRef } from 'react'

/**
 * "Link to student": the teacher's repair for a GitHub account that accepted an
 * assignment without ever claiming an identifier on the roster.
 *
 * Port of `orgs/rosters/_unlinked_user.html.erb:17` and the
 * `_link_to_student_modal` it opens — a list of the roster identifiers nobody
 * holds, each one a form that posts to RostersController#link with this
 * account's user id.
 *
 * Two divergences from the original's partial:
 *
 *  - It lives on the assignment dashboard rather than on the roster's "Unlinked
 *    GitHub accounts" tab, because that tab is not ported: this port folds those
 *    accounts into the dashboard list itself, behind the "Sin vincular ·
 *    Cuentas de GitHub" filter. The live classroom.github.com does the same.
 *  - The list is rendered with the entries, not fetched when the dialog opens.
 *    The live site populates its `<ul>` by JS on open; here the page is already
 *    server-rendered and `force-dynamic`, so the list is as fresh as the row
 *    the button sits on and costs no second endpoint to guard.
 *
 * The frame is the native `<dialog>` of AddStudentsDialog, for the reasons
 * recorded there.
 */
export function LinkToStudentDialog({
  userId,
  login,
  classroomSlug,
  assignmentSlug,
  identifierName,
  entries,
  action,
}: {
  userId: number
  /** The account being linked, for the labels — null if GitHub lost the login */
  login: string | null
  classroomSlug: string
  assignmentSlug: string
  /** The roster's column name, "Padrón" by default */
  identifierName: string
  entries: { id: number; identifier: string }[]
  action: (
    state: { error: string | null; notice: string | null },
    formData: FormData,
  ) => Promise<{ error: string | null; notice: string | null }>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, formAction, pending] = useActionState(action, { error: null, notice: null })

  const account = login ? `@${login}` : 'esta cuenta'
  const titleId = `link-account-to-student-${userId}`

  return (
    <>
      {/* The live site's `Button--link Button--medium`, which is a button that
          reads as a link inside the row's meta line */}
      <button
        type="button"
        className="btn-link Link Link--muted text-small mr-3"
        onClick={() => dialog.current?.showModal()}
      >
        Vincular con un alumno
      </button>

      <dialog ref={dialog} className="modal" aria-labelledby={titleId}>
        <div className="Box Box--overlay text-left">
          <div className="Box-header d-flex flex-justify-between flex-items-center">
            <h2 className="Box-title" id={titleId}>
              Vincular {account} con un alumno
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

            {/* The `else` of `_link_to_github_account_modal`, which is the only
                one of the two modals the original wrote a blank slate for */}
            {entries.length === 0 ? (
              <p className="color-fg-muted mb-0">
                No queda ningún {identifierName.toLowerCase()} sin vincular en el roster.
              </p>
            ) : (
              <>
                <p className="mb-2">
                  <strong>Elegí el {identifierName.toLowerCase()} que le corresponde:</strong>
                </p>

                <ul className="ActionListWrap ActionListWrap--divided">
                  {entries.map((entry) => (
                    <li key={entry.id} className="ActionListItem">
                      <form action={formAction}>
                        <input type="hidden" name="classroom_slug" value={classroomSlug} />
                        <input type="hidden" name="assignment_slug" value={assignmentSlug} />
                        <input type="hidden" name="user_id" value={userId} />
                        <input type="hidden" name="entry_id" value={entry.id} />
                        <button
                          type="submit"
                          className="ActionListContent width-full"
                          disabled={pending}
                        >
                          <span className="ActionListItem-label">{entry.identifier}</span>
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="Box-footer d-flex flex-justify-end">
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>
              Cancelar
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}
