'use client'

import { useActionState, useMemo, useState } from 'react'

import { SearchField } from '@/components/SearchField'
import { EMPTY_STATE, type InvitationActionState } from '@/lib/form'

/**
 * Port of `shared/_shared_join_roster.html.erb`: the list the student picks
 * their identifier from before accepting.
 *
 * Two deliberate divergences, both for a roster of a few hundred entries:
 *
 * - **The list filters as the student types.** The original only sorts the
 *   unlinked entries and scrolls them in a 45vh box, which is fine for a class
 *   of thirty and a hunt through a wall of padrones for a cátedra.
 * - **Picking an entry is not linking it.** In the original every entry is its
 *   own `form_tag` and one click on it is the #join_roster; a slip of the
 *   finger links the account to somebody else's identifier, which the student
 *   cannot undo — only the teacher can, from the roster. Here a click selects,
 *   and "Confirmar" submits the selection after naming it back.
 *
 * The selection lives in state and travels in one hidden `roster_entry_id`,
 * so it survives a filter that hides its row.
 *
 * The action is a prop because the screen is shared: the original renders this
 * same `_shared_join_roster` from both invitation controllers, and each posts
 * to its own #join_roster.
 */
export function JoinRosterForm({
  invitationKey,
  identifierName,
  entries,
  skipHref,
  joinRosterAction,
}: {
  invitationKey: string
  identifierName: string
  entries: { id: number; identifier: string }[]
  skipHref: string
  /** #join_roster of whichever invitation controller this screen belongs to */
  joinRosterAction: (
    previous: InvitationActionState,
    formData: FormData,
  ) => Promise<InvitationActionState>
}) {
  const [state, action, pending] = useActionState(joinRosterAction, EMPTY_STATE)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const searchable = useMemo(
    () => entries.map((entry) => ({ ...entry, searchText: normalize(entry.identifier) })),
    [entries],
  )

  const filtered = useMemo(() => {
    const needle = normalize(query)
    if (!needle) return searchable
    return searchable.filter((entry) => entry.searchText.includes(needle))
  }, [searchable, query])

  const selected = entries.find((entry) => entry.id === selectedId) ?? null
  const name = identifierName.toLowerCase()

  return (
    <form
      action={action}
      onKeyDown={(event) => {
        // Enter in the search field or on a radio would be an implicit
        // submission, which is the one-keystroke link this form exists to
        // avoid. In the search field it picks the entry instead, once the
        // filter has narrowed the list to one.
        if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return
        event.preventDefault()
        if (event.target.type === 'text' && filtered.length === 1) {
          setSelectedId(filtered[0].id)
        }
      }}
    >
      <input type="hidden" name="key" value={invitationKey} />
      {selected && <input type="hidden" name="roster_entry_id" value={selected.id} />}

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

      <div className="Box">
        <div className="Box-header">
          <h3 className="Box-title">{identifierName}</h3>
        </div>

        {entries.length === 0 ? (
          <div className="Box-row color-fg-muted">
            No queda ningún {name} sin vincular. Si el tuyo no está, escribile al docente.
          </div>
        ) : (
          <>
            <div className="Box-row">
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={`Buscá tu ${name}`}
                ariaLabel={`Buscar ${name}`}
              />
            </div>

            {filtered.length === 0 ? (
              <div className="Box-row color-fg-muted">
                Ningún {name} sin vincular coincide con «{query.trim()}». Si el tuyo no está,
                escribile al docente.
              </div>
            ) : (
              // `style="max-height:45vh"` and the scroll of the original
              <div
                className="overflow-auto"
                style={{ maxHeight: '45vh' }}
                role="radiogroup"
                aria-label={identifierName}
              >
                {filtered.map((entry) => (
                  <label
                    key={entry.id}
                    className={`Box-row Box-row--hover-gray d-flex flex-items-center p-3 text-mono ${
                      entry.id === selectedId ? 'Box-row--blue' : ''
                    }`}
                    style={{ cursor: 'pointer', fontWeight: 'normal' }}
                  >
                    <input
                      type="radio"
                      name="roster_choice"
                      className="mr-2"
                      checked={entry.id === selectedId}
                      onChange={() => setSelectedId(entry.id)}
                      disabled={pending}
                    />
                    {entry.identifier}
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {selected && (
        <div className="flash flash-warn mt-3">
          Vas a vincular tu cuenta de GitHub con el {name}{' '}
          <strong className="text-mono">{selected.identifier}</strong>. Revisá que sea el tuyo:
          una vez vinculado, solo el docente puede cambiarlo.
        </div>
      )}

      <div className="mt-3 d-flex flex-items-center">
        {entries.length > 0 && (
          <button type="submit" className="btn btn-primary mr-2" disabled={!selected || pending}>
            {pending ? 'Vinculando…' : 'Confirmar'}
          </button>
        )}
        <a href={skipHref} className="btn">
          Saltear por ahora
        </a>
      </div>
    </form>
  )
}

/**
 * Case, accents, spaces and punctuation out, so "105.123" finds 105123 and
 * "perez juan" finds "Pérez, Juan".
 */
function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}
