'use client'

import { useActionState, useRef } from 'react'

import type { UnlinkedAccount } from '@/lib/data/rosters'

import { linkAccountAction } from './actions'

/**
 * "Link to GitHub account": the other half of RostersController#link, the one
 * that starts from a roster identifier and picks the account.
 *
 * Port of `_link_to_github_account_modal.html.erb`, raised from the button
 * `_roster_entry.html.erb:40` puts on an unlinked entry, which the live site
 * still shows. Its counterpart from the account's side is
 * components/LinkToStudentDialog — same action, opposite direction, so the
 * teacher can repair the pairing from whichever of the two rows they are
 * looking at.
 *
 * As in that one, the list is rendered with the row instead of being fetched
 * when the dialog opens: the page is already server-rendered and
 * `force-dynamic`. The frame is the native `<dialog>` of AddStudentsDialog.
 */
export function LinkToGitHubAccountDialog({
  entryId,
  identifier,
  classroomSlug,
  accounts,
}: {
  entryId: number
  /** The student being linked, for the labels */
  identifier: string
  classroomSlug: string
  /** The classroom's GitHub accounts that hold no identifier */
  accounts: UnlinkedAccount[]
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, formAction, pending] = useActionState(linkAccountAction, {
    error: null,
    notice: null,
  })

  const titleId = `link-to-github-account-${entryId}`

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => dialog.current?.showModal()}>
        Vincular con una cuenta de GitHub
      </button>

      <dialog ref={dialog} className="modal" aria-labelledby={titleId}>
        <div className="Box Box--overlay text-left">
          <div className="Box-header d-flex flex-justify-between flex-items-center">
            <h2 className="Box-title" id={titleId}>
              Vincular a {identifier} con una cuenta de GitHub
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

            {/* The `else` of the original's modal, which is where it explains
                where these accounts come from */}
            {accounts.length === 0 ? (
              <p className="color-fg-muted mb-0">
                Las cuentas aparecen acá cuando un alumno acepta un trabajo práctico del classroom sin
                haber vinculado su cuenta de GitHub con un alumno de la lista.
              </p>
            ) : (
              <>
                <p className="mb-2">
                  <strong>Elegí la cuenta de GitHub que le corresponde:</strong>
                </p>

                <ul className="ActionListWrap ActionListWrap--divided">
                  {accounts.map((account) => (
                    <li key={account.id} className="ActionListItem">
                      <form action={formAction}>
                        <input type="hidden" name="classroom_slug" value={classroomSlug} />
                        <input type="hidden" name="entry_id" value={entryId} />
                        <input type="hidden" name="user_id" value={account.id} />
                        <button
                          type="submit"
                          className="ActionListContent width-full"
                          disabled={pending}
                        >
                          <span className="ActionListItem-label">
                            {/* NullGitHubUser: the row is still linkable, or
                                the identifier stays empty forever */}
                            {account.githubLogin ? `@${account.githubLogin}` : 'Cuenta desconocida'}
                          </span>
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
