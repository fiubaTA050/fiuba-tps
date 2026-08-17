'use client'

import { CheckIcon, MarkGithubIcon, PencilIcon, TrashIcon } from '@primer/octicons-react'
import { useActionState, useState } from 'react'

import type { RosterEntryItem } from '@/lib/data/rosters'

import { deleteEntryAction, renameEntryAction, unlinkAccountAction } from './actions'
import { EMPTY_STATE } from './state'

/**
 * One student of the roster, in the live page's layout:
 *
 *   <div class="d-flex col-12 flex-justify-between flex-wrap">
 *     <div class="d-flex">           avatar + identifier + @login
 *     <div class="d-flex flex-justify-end">   unlink · pencil · trash
 *
 * `Unlink GitHub account` is here, on a linked entry, exactly as in
 * `_roster_entry.html.erb:35`. Its counterpart on an unlinked one — the
 * original's `Link to GitHub account`, which opens
 * `_link_to_github_account_modal` — is not: the same vinculación is done from
 * the assignment dashboard, from the account's side, which is where the teacher
 * meets the problem. See components/LinkToStudentDialog.
 *
 * The rename happens inline instead of in a modal, and the delete confirmation
 * is a `confirm()` — which is what Rails' `data-confirm` did before the
 * original moved to remodal. Unlinking is not confirmed, as there: it is one
 * click to undo from the dashboard.
 */
export function RosterEntryRow({
  entry,
  classroomSlug,
}: {
  entry: RosterEntryItem
  classroomSlug: string
}) {
  /**
   * Which identifier the inline editor is open for, rather than a boolean: a
   * rename that goes through comes back as a new `entry.identifier`, and that
   * closes the editor by itself. One that fails leaves the identifier as it
   * was, so the editor stays open with the message next to it.
   */
  const [editingIdentifier, setEditingIdentifier] = useState<string | null>(null)
  const editing = editingIdentifier === entry.identifier

  const [renameState, renameAction, renaming] = useActionState(renameEntryAction, EMPTY_STATE)
  const [deleteState, deleteAction, deleting] = useActionState(deleteEntryAction, EMPTY_STATE)
  const [unlinkState, unlinkAction, unlinking] = useActionState(unlinkAccountAction, EMPTY_STATE)

  // The rename message belongs to the open editor: cancelling out of it takes
  // the message with it, instead of leaving it under a row it no longer describes
  const error = (editing ? renameState.error : null) ?? deleteState.error ?? unlinkState.error

  if (editing) {
    return (
      <div className="py-2">
        <form action={renameAction} className="d-flex flex-items-center">
          <input type="hidden" name="classroom_slug" value={classroomSlug} />
          <input type="hidden" name="entry_id" value={entry.id} />
          <input
            type="text"
            name="identifier"
            defaultValue={entry.identifier}
            maxLength={255}
            required
            autoFocus
            aria-label="Identificador"
            className="form-control input-sm input-monospace mr-2"
          />
          <button type="submit" className="btn btn-sm btn-primary mr-2" disabled={renaming}>
            <CheckIcon /> <span className="ml-1">Guardar</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setEditingIdentifier(null)}
          >
            Cancelar
          </button>
        </form>

        {error && <p className="note color-fg-danger mb-0 mt-1">{error}</p>}
      </div>
    )
  }

  return (
    <div className="py-2">
      <div className="d-flex col-12 flex-justify-between flex-wrap flex-items-center">
        <div className="d-flex flex-items-center">
          {entry.githubLogin ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://github.com/${entry.githubLogin}.png?size=92`}
              className="avatar avatar-user mr-3"
              height={46}
              width={46}
              alt=""
            />
          ) : (
            // The slot the avatar will take once the entry is linked, so the
            // identifiers of a fresh roster do not sit against the edge
            <span className="d-flex flex-items-center flex-justify-center color-fg-muted mr-3">
              <MarkGithubIcon size={24} />
            </span>
          )}

          <div className="flex-column">
            <h3 className="h4">{entry.identifier}</h3>
            <p className="color-fg-muted mb-0">
              {entry.githubLogin ? (
                <a href={`https://github.com/${entry.githubLogin}`}>@{entry.githubLogin}</a>
              ) : (
                'Sin vincular'
              )}
            </p>
          </div>
        </div>

        <div className="d-flex flex-items-center">
          {/* `submit_tag 'Unlink GitHub account'`, only on a linked entry */}
          {entry.githubLogin && (
            <form action={unlinkAction}>
              <input type="hidden" name="classroom_slug" value={classroomSlug} />
              <input type="hidden" name="entry_id" value={entry.id} />
              <button type="submit" className="btn btn-sm mr-2" disabled={unlinking}>
                Desvincular
              </button>
            </form>
          )}

          <button
            type="button"
            className="btn-octicon"
            aria-label={`Editar ${entry.identifier}`}
            onClick={() => setEditingIdentifier(entry.identifier)}
          >
            <PencilIcon />
          </button>

          <form action={deleteAction}>
            <input type="hidden" name="classroom_slug" value={classroomSlug} />
            <input type="hidden" name="entry_id" value={entry.id} />
            <button
              type="submit"
              className="btn-octicon btn-octicon-danger"
              aria-label={`Borrar ${entry.identifier}`}
              disabled={deleting}
              onClick={(event) => {
                if (!window.confirm(`¿Borrar a ${entry.identifier} del roster?`)) {
                  event.preventDefault()
                }
              }}
            >
              <TrashIcon />
            </button>
          </form>
        </div>
      </div>

      {error && <p className="note color-fg-danger mb-0 mt-1">{error}</p>}
    </div>
  )
}
