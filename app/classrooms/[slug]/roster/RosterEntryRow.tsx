'use client'

import { CheckIcon, MarkGithubIcon, PencilIcon, TrashIcon } from '@primer/octicons-react'
import { useActionState, useState } from 'react'

import type { RosterEntryItem } from '@/lib/data/rosters'

import { deleteEntryAction, renameEntryAction } from './actions'
import { EMPTY_STATE } from './state'

/**
 * Port of orgs/rosters/_roster_entry.html.erb plus the edit and delete modals
 * that hung off it (`_edit_roster_entry_modal`, `_delete_roster_entry_modal`).
 *
 * The rename happens inline instead of in a modal — same reason as
 * AddStudentsForm — and the delete confirmation is a `confirm()`, which is
 * what Rails' `data-confirm` did before the original moved to remodal.
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

  // The rename message belongs to the open editor: cancelling out of it takes
  // the message with it, instead of leaving it under a row it no longer describes
  const error = (editing ? renameState.error : null) ?? deleteState.error

  return (
    <li className="Box-row">
      <div className="d-flex flex-items-center flex-justify-between">
        {editing ? (
          <form action={renameAction} className="d-flex flex-items-center flex-auto mr-3">
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
            <button type="button" className="btn btn-sm" onClick={() => setEditingIdentifier(null)}>
              Cancelar
            </button>
          </form>
        ) : (
          <>
            <span className="text-mono">{entry.identifier}</span>

            <div className="d-flex flex-items-center">
              {entry.githubLogin ? (
                <a
                  href={`https://github.com/${entry.githubLogin}`}
                  className="d-flex flex-items-center mr-3"
                >
                  <MarkGithubIcon className="mr-1" />
                  {entry.githubLogin}
                </a>
              ) : (
                // The original showed a "Link" button here; there is nobody to
                // link to until the invitation flow exists, see lib/data/rosters.ts
                <span className="Label Label--gray mr-3">Sin vincular</span>
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
          </>
        )}
      </div>

      {error && <p className="note color-fg-danger mb-0 mt-1">{error}</p>}
    </li>
  )
}
