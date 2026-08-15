'use client'

import { LockIcon, RepoIcon } from '@primer/octicons-react'
import { useEffect, useRef, useState } from 'react'

import type { GitHubRepository } from '@/lib/github/repositories'

/**
 * Port of the starter code field of assignments/_assignment_form_options.html.erb
 * together with app/assets/javascripts/autocomplete.js.
 *
 * The original's behaviour is kept: 500 ms debounce, a dropdown of suggestions,
 * arrow keys to move, enter to take the highlighted one, escape to dismiss, and
 * enter swallowed so it never submits the form from the field.
 *
 * One addition. The original had nothing to show until you typed; here an empty
 * field lists the classroom org's own templates, which is the answer most of
 * the time and costs nothing — the page already has them. Typing switches to
 * the search, which reaches all of GitHub.
 *
 * The original also posted a hidden `repo_id` next to the name so the server
 * could skip re-resolving it. That is not carried over: it is client input
 * either way, and `resolveStarterCode` has to look the repo up to validate it.
 */
export function StarterCodeField({
  templates,
  invalid,
}: {
  templates: GitHubRepository[]
  invalid: boolean
}) {
  const [value, setValue] = useState('')
  // Results carry the query they answer, which is what makes "still searching"
  // derivable instead of a second state the effect has to keep in sync.
  const [results, setResults] = useState<{
    query: string
    repositories: GitHubRepository[]
    error: string | null
  } | null>(null)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)

  const container = useRef<HTMLDivElement>(null)
  const query = value.trim()

  const answered = results?.query === query
  // Covers the debounce window too, so the dropdown says "Buscando…" from the
  // first keystroke rather than 500 ms later.
  const searching = query.length > 0 && !answered

  /**
   * The org's own templates that match, always first.
   *
   * The original ranked purely by GitHub's `sort: updated` over all of GitHub,
   * which buries the classroom's own template under strangers' repos: typing
   * "raft" here returns ten recently updated raft templates and none of them is
   * `fiubaTA050-labs/raft-starter`. Matching the list the page already holds
   * fixes the ranking for free — no request, since these are props.
   */
  const localMatches =
    query.length === 0
      ? templates
      : templates.filter((repo) => repo.fullName.toLowerCase().includes(query.toLowerCase()))

  const remote = answered ? results.repositories : []
  const localIds = new Set(localMatches.map((repo) => repo.id))

  const suggestions =
    query.length === 0
      ? templates
      : [...localMatches, ...remote.filter((repo) => !localIds.has(repo.id))]

  const error = query.length === 0 || !answered ? null : results.error

  // `delay` in the original: one shared timer, so only the last keystroke of a
  // burst reaches the API. The search endpoint allows 30 requests a minute,
  // far less than the rest of GitHub, so this is not just polish.
  useEffect(() => {
    if (query.length === 0) return

    let cancelled = false

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/autocomplete/github_repos?query=${encodeURIComponent(query)}`,
        )
        const data = await response.json()
        // A slower earlier request must not overwrite a newer answer
        if (!cancelled) {
          setResults({ query, repositories: data.repositories ?? [], error: data.error })
        }
      } catch {
        if (!cancelled) {
          setResults({
            query,
            repositories: [],
            error: 'No pudimos buscar en GitHub. Escribí owner/nombre.',
          })
        }
      }
    }, 500)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  // The original dismissed the list on any mousedown outside the field or the
  // suggestions, keeping right-clicks alone.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (event.button === 2) return
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  function choose(repository: GitHubRepository) {
    setValue(repository.fullName)
    setOpen(false)
    setHighlighted(-1)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // The original bound keydown purely to stop enter from submitting
    if (event.key === 'Enter') {
      event.preventDefault()
      if (open && highlighted >= 0 && suggestions[highlighted]) choose(suggestions[highlighted])
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
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = current + step
        if (next < 0) return -1
        return Math.min(next, suggestions.length - 1)
      })
    }
  }

  const listId = 'starter-code-suggestions'

  return (
    <div className="position-relative" ref={container}>
      <input
        id="assignment_starter_code"
        name="repo_name"
        type="text"
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setHighlighted(-1)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className={`form-control input-block text-mono ${invalid ? 'color-border-danger' : ''}`}
        placeholder="Buscá un template, o escribí owner/nombre"
      />

      {open && (suggestions.length > 0 || error || searching) && (
        <div
          id={listId}
          role="listbox"
          className="position-absolute width-full border rounded-2 color-bg-default box-shadow-medium mt-1"
          style={{ zIndex: 10, maxHeight: 280, overflowY: 'auto' }}
        >
          {error ? (
            <p className="note color-fg-attention p-2 mb-0">{error}</p>
          ) : suggestions.length === 0 ? (
            // t('views.autocomplete.no_matching_repo')
            <p className="note p-2 mb-0">
              {searching ? 'Buscando…' : 'No hay templates que coincidan'}
            </p>
          ) : (
            <>
              {query.length === 0 && (
                <p className="note p-2 mb-0 color-bg-subtle">Templates de la organización</p>
              )}
              <ul className="list-style-none">
                {suggestions.map((repository, index) => (
                  <li key={repository.id} role="option" aria-selected={index === highlighted}>
                    <button
                      type="button"
                      // Not onClick: blur would close the list before it fires
                      onMouseDown={(event) => {
                        event.preventDefault()
                        choose(repository)
                      }}
                      onMouseEnter={() => setHighlighted(index)}
                      className={`btn-link d-flex flex-items-center width-full text-left p-2 ${
                        index === highlighted ? 'color-bg-accent-subtle' : ''
                      }`}
                    >
                      {repository.private ? (
                        <LockIcon className="mr-2 flex-shrink-0 color-fg-muted" />
                      ) : (
                        <RepoIcon className="mr-2 flex-shrink-0 color-fg-muted" />
                      )}
                      <span className="text-mono">{repository.fullName}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
