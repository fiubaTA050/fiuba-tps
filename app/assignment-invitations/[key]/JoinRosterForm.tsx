'use client'

import { useActionState } from 'react'

import { joinRosterAction } from './actions'
import { EMPTY_STATE } from './state'

/**
 * Port of `shared/_shared_join_roster.html.erb`: the list the student picks
 * their identifier from before accepting.
 *
 * The original wrapped every entry in its own `form_tag` with a hidden
 * `roster_entry_id`. Here one form holds them all and each button carries the
 * id as its own `name`/`value` — the browser submits only the button that was
 * pressed, so it is the same request, without a few hundred forms in the page
 * for a cátedra-sized roster.
 */
export function JoinRosterForm({
  invitationKey,
  identifierName,
  entries,
  skipHref,
}: {
  invitationKey: string
  identifierName: string
  entries: { id: number; identifier: string }[]
  skipHref: string
}) {
  const [state, action, pending] = useActionState(joinRosterAction, EMPTY_STATE)

  return (
    <form action={action}>
      <input type="hidden" name="key" value={invitationKey} />

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

      <div className="Box">
        <div className="Box-header">
          <h3 className="Box-title">{identifierName}</h3>
        </div>

        {entries.length === 0 ? (
          <div className="Box-row color-fg-muted">
            No queda ningún {identifierName.toLowerCase()} sin vincular. Si el tuyo no está,
            escribile al docente.
          </div>
        ) : (
          // `style="max-height:45vh"` and the scroll of the original
          <div className="overflow-auto" style={{ maxHeight: '45vh' }}>
            {entries.map((entry) => (
              <div className="Box-row p-0" key={entry.id}>
                <button
                  type="submit"
                  name="roster_entry_id"
                  value={entry.id}
                  disabled={pending}
                  className="btn-link width-full text-left p-3 text-mono"
                >
                  {entry.identifier}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <a href={skipHref} className="btn">
          Saltear por ahora
        </a>
      </div>
    </form>
  )
}
