'use client'

import { XIcon } from '@primer/octicons-react'
import { useActionState, useEffect, useRef, useState } from 'react'

import { EMPTY_STATE } from '@/app/classrooms/[slug]/roster/state'
import type { AssistantSuggestion } from '@/lib/data/teaching-assistants'

import { addTeachingAssistantAction } from './actions'

/** `SUGGESTION_MIN_QUERY` of lib/data/teaching-assistants.ts, which is server-only */
const MIN_QUERY = 2

/**
 * "Agregar ayudante": one field for a GitHub login, with suggestions as the
 * teacher types. No live equivalent — the live site's "Invite admins" sends
 * the teacher to github.com to make somebody an owner, which is exactly what
 * a TA here must not be.
 *
 * The suggestions behave like the starter code field (`StarterCodeField`,
 * itself the original's autocomplete.js): a debounced request, arrows to move,
 * enter to take the highlighted one, escape to dismiss. Two differences: enter
 * with nothing highlighted submits, since this form is the field; and the
 * delay is 300 ms rather than 500, as this search does not draw from the REST
 * search bucket of 30 a minute (see `searchGitHubUsers`).
 *
 * Picking a suggestion replaces the field with the chosen account — avatar,
 * login, name and an X to pick again — and the button names who it adds,
 * the way github.com's "Add people" leaves no doubt about who was picked: a
 * login merely copied into the field reads the same as one typed by hand.
 * The login is still what is posted and resolved on the server, so typing
 * one and submitting without picking keeps working, for when the search is
 * rate limited.
 */
export function AddTeachingAssistantForm({ classroomSlug }: { classroomSlug: string }) {
  const [state, action, pending] = useActionState(addTeachingAssistantAction, EMPTY_STATE)

  // Controlled, the way AddStudentsDialog keeps its textarea: React 19 resets
  // the uncontrolled fields of a `<form action>` whenever the action finishes,
  // failures included, which would throw away the login the teacher is about
  // to correct. Only a success — the one result carrying `submission` —
  // empties it, adjusted during render as React asks for state that follows
  // something from outside.
  const [login, setLogin] = useState('')
  const [handled, setHandled] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const [selected, setSelected] = useState<AssistantSuggestion | null>(null)
  // Set by the X, so the search field comes back focused rather than lost
  const [refocus, setRefocus] = useState(false)
  if (state.submission && state.submission !== handled) {
    setHandled(state.submission)
    setLogin('')
    setSelected(null)
    setOpen(false)
  }

  // Results carry the query they answer, so "still searching" is derived
  // rather than kept in sync by the effect
  const [results, setResults] = useState<{
    query: string
    suggestions: AssistantSuggestion[]
    error: string | null
  } | null>(null)

  const container = useRef<HTMLDivElement>(null)
  const query = login.trim().replace(/^@/, '')
  const searchable = query.length >= MIN_QUERY
  const answered = results?.query === query
  const searching = searchable && !answered
  // The previous answer stays up until the next one lands, instead of the list
  // blanking to "Buscando…" on every keystroke
  const suggestions = searchable ? (results?.suggestions ?? []) : []
  const error = searchable && answered ? results.error : null

  useEffect(() => {
    if (query.length < MIN_QUERY) return

    let cancelled = false

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/autocomplete/github_users?classroom=${encodeURIComponent(classroomSlug)}&query=${encodeURIComponent(query)}`,
        )
        const data = await response.json()
        // A slower earlier request must not overwrite a newer answer
        if (!cancelled) {
          setResults({
            query,
            suggestions: data.suggestions ?? [],
            error: data.error ?? null,
          })
        }
      } catch {
        if (!cancelled) {
          setResults({
            query,
            suggestions: [],
            error: 'No pudimos buscar en GitHub. Escribí el usuario completo.',
          })
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, classroomSlug])

  // Dismissed on any mousedown outside the field or the list, right-clicks aside
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (event.button === 2) return
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  // The field the focus was in is gone once an account is picked: hand it to
  // the button, so enter confirms the way it does on github.com
  const submit = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (selected) submit.current?.focus()
  }, [selected])

  function choose(suggestion: AssistantSuggestion) {
    if (suggestion.refusal) return
    setSelected(suggestion)
    setLogin(suggestion.login)
    setOpen(false)
    setHighlighted(-1)
  }

  function unselect() {
    setSelected(null)
    setLogin('')
    setRefocus(true)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      const suggestion = open && highlighted >= 0 ? suggestions[highlighted] : undefined
      // Nothing highlighted: let the form submit what was typed
      if (suggestion) {
        event.preventDefault()
        choose(suggestion)
      }
      return
    }

    if (event.key === 'Escape') {
      setOpen(false)
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) setOpen(true)
      setHighlighted((current) => {
        const next = current + (event.key === 'ArrowDown' ? 1 : -1)
        if (next < 0) return -1
        return Math.min(next, suggestions.length - 1)
      })
    }
  }

  const listId = 'teaching-assistant-suggestions'
  const showList = open && searchable && (suggestions.length > 0 || error || searching || answered)

  return (
    <form action={action}>
      <input type="hidden" name="classroom_slug" value={classroomSlug} />

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}
      {state.notice && <div className="flash flash-success mb-3">{state.notice}</div>}

      <div className="form-group my-0">
        <div className="form-group-header">
          <label htmlFor="teaching-assistant-login">Usuario de GitHub</label>
        </div>
        {/* Stacked under 544px: side by side, the button pushes the page wider */}
        <div className="form-group-body d-flex flex-column flex-sm-row flex-sm-items-center">
          {selected ? (
            <SelectedAccount account={selected} onClear={unselect} />
          ) : (
            <div className="position-relative flex-auto mr-sm-2 mb-2 mb-sm-0" ref={container}>
              <input
                autoFocus={refocus}
                id="teaching-assistant-login"
                name="login"
                type="text"
                value={login}
                onChange={(event) => {
                  setLogin(event.target.value)
                  setHighlighted(-1)
                  setOpen(true)
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={onKeyDown}
                className="form-control input-block input-monospace"
                placeholder="Buscá por usuario o nombre"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                role="combobox"
                aria-expanded={Boolean(showList)}
                aria-controls={listId}
                aria-autocomplete="list"
                required
              />

              {showList && (
                <div
                  id={listId}
                  role="listbox"
                  className="position-absolute width-full border rounded-2 color-bg-default box-shadow-medium mt-1"
                  style={{ zIndex: 10, maxHeight: 320, overflowY: 'auto' }}
                >
                  {suggestions.length > 0 && (
                    <ul className="list-style-none">
                      {suggestions.map((suggestion, index) => (
                        <li
                          key={suggestion.id}
                          role="option"
                          aria-selected={index === highlighted}
                          aria-disabled={suggestion.refusal ? true : undefined}
                        >
                          <button
                            type="button"
                            // Not onClick: blur would close the list before it fires
                            onMouseDown={(event) => {
                              event.preventDefault()
                              choose(suggestion)
                            }}
                            onMouseEnter={() => setHighlighted(index)}
                            title={suggestion.refusal ?? undefined}
                            className={`btn-link d-flex flex-items-center width-full text-left p-2 color-fg-default no-underline ${
                              index === highlighted ? 'color-bg-accent-subtle' : ''
                            }`}
                            style={
                              suggestion.refusal
                                ? { opacity: 0.55, cursor: 'not-allowed' }
                                : undefined
                            }
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={
                                suggestion.avatarUrl ||
                                `https://github.com/${suggestion.login}.png?size=40`
                              }
                              className="avatar circle flex-shrink-0 mr-2"
                              height={20}
                              width={20}
                              alt=""
                            />
                            <span className="d-flex flex-column min-width-0">
                              <span className="css-truncate css-truncate-overflow">
                                <span className="text-bold text-mono">{suggestion.login}</span>
                                {suggestion.name && (
                                  <span className="color-fg-muted ml-2">{suggestion.name}</span>
                                )}
                              </span>
                              {suggestion.refusal && (
                                <span className="f6 color-fg-muted">{suggestion.refusal}</span>
                              )}
                            </span>
                            {suggestion.known && !suggestion.refusal && (
                              <span
                                className="Label Label--gray ml-auto flex-shrink-0"
                                title="Fue ayudante o alumno en otro de tus classrooms"
                              >
                                De tus classrooms
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {error ? (
                    <p className="note color-fg-attention p-2 mb-0">{error}</p>
                  ) : (
                    suggestions.length === 0 && (
                      <p className="note p-2 mb-0">
                        {searching ? 'Buscando…' : 'No hay cuentas que coincidan'}
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
          )}
          <button
            ref={submit}
            type="submit"
            className="btn btn-primary flex-shrink-0"
            disabled={pending}
          >
            {pending
              ? 'Agregando…'
              : selected
                ? `Agregar a ${selected.login} como ayudante`
                : 'Agregar ayudante'}
          </button>
        </div>
        <p className="note">
          La cuenta tiene que existir en GitHub. No hace falta que haya entrado antes a FIUBA
          Classroom ni que sea miembro de la organización.
        </p>
      </div>
    </form>
  )
}

/**
 * The picked account in place of the field: what github.com's "Add people"
 * shows once a suggestion is chosen. Posts the login in a hidden field, so
 * the form does not care which of the two is showing.
 */
function SelectedAccount({
  account,
  onClear,
}: {
  account: AssistantSuggestion
  onClear: () => void
}) {
  return (
    <div className="d-flex flex-items-center flex-auto border rounded-2 px-2 py-1 mr-sm-2 mb-2 mb-sm-0 min-width-0">
      <input type="hidden" name="login" value={account.login} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={account.avatarUrl || `https://github.com/${account.login}.png?size=40`}
        className="avatar circle flex-shrink-0 mr-2"
        height={24}
        width={24}
        alt=""
      />
      <span className="css-truncate css-truncate-overflow flex-auto">
        <span className="text-bold text-mono">{account.login}</span>
        {account.name && <span className="color-fg-muted ml-2">{account.name}</span>}
      </span>
      {account.known && (
        <span
          className="Label Label--gray ml-2 flex-shrink-0"
          title="Fue ayudante o alumno en otro de tus classrooms"
        >
          De tus classrooms
        </span>
      )}
      <button
        type="button"
        className="btn-octicon ml-1 flex-shrink-0"
        aria-label={`Quitar a ${account.login} y elegir otra cuenta`}
        title="Elegir otra cuenta"
        onClick={onClear}
      >
        <XIcon />
      </button>
    </div>
  )
}
