'use client'

import { useMemo, useRef, useState, type ReactNode } from 'react'

import { CheckboxMenu } from '@/components/CheckboxMenu'
import { Pagination } from '@/components/Pagination'
import { SearchField } from '@/components/SearchField'

/**
 * The roster page's two tabs, ported from the live site's `tab-container`:
 * "All students" and "Unlinked GitHub accounts", each with its Counter.
 *
 * Both panels come in already server-rendered and only one is `hidden`, which
 * is what the live site does too — switching costs no request.
 *
 * Each panel has its own paginator and its own page number, the way
 * `orgs/rosters/show.html.erb` gives them the separate `roster_entries_page`
 * and `unlinked_users_page` parameters. Both are drawn in the browser rather
 * than in the URL, for the reason AGENTS.md records for the assignment
 * dashboard; the rows themselves are already here, server-rendered.
 */

/**
 * Rows per page, measured on a saved copy of the live roster: 20 items and
 * three pages. That is Kaminari's `default_per_page` — this page, unlike the
 * assignment dashboard, never had it overridden.
 */
const PER_PAGE = 20

/** One row, already server-rendered, plus what the search box and filters match it on */
export type RosterRow = {
  key: string | number
  searchText: string
  /** Whether this student holds a linked GitHub account */
  linked: boolean
  node: ReactNode
}

/** The roster's own "Vinculado / Sin vincular" filter, students tab only */
type LinkFilter = 'linked' | 'unlinked'

export function RosterTabs({
  studentsCount,
  students,
  accountsCount,
  accounts,
}: {
  studentsCount: number
  students: RosterRow[]
  accountsCount: number
  accounts: RosterRow[]
}) {
  const [selected, setSelected] = useState<'students' | 'accounts'>('students')

  return (
    <>
      <div className="tabnav">
        <ul role="tablist" aria-label="Lista de alumnos" className="tabnav-tabs list-style-none">
          <Tab
            id="students"
            label="Todos los alumnos"
            count={studentsCount}
            selected={selected}
            onSelect={setSelected}
          />
          <Tab
            id="accounts"
            label="Cuentas de GitHub sin vincular"
            count={accountsCount}
            selected={selected}
            onSelect={setSelected}
          />
        </ul>
      </div>

      <div
        id="panel-roster-students"
        role="tabpanel"
        aria-labelledby="roster-tab-students"
        hidden={selected !== 'students'}
      >
        <Panel
          rows={students}
          label="Todos los alumnos"
          searchPlaceholder="Buscar por identificador o usuario de GitHub"
          searchAriaLabel="Buscar en la lista de alumnos"
          emptyMessage="Ningún alumno coincide con la búsqueda."
          showLinkFilter
        />
      </div>

      <div
        id="panel-roster-accounts"
        role="tabpanel"
        aria-labelledby="roster-tab-accounts"
        hidden={selected !== 'accounts'}
      >
        {accounts.length === 0 ? (
          // `shared/_unlinked_blank_slate`
          <div className="px-2">
            <p className="color-fg-muted py-2 mb-0">
              Todas las cuentas que participan del classroom están vinculadas.
            </p>
          </div>
        ) : (
          <Panel
            rows={accounts}
            label="Cuentas de GitHub sin vincular"
            searchPlaceholder="Buscar por usuario de GitHub"
            searchAriaLabel="Buscar en las cuentas sin vincular"
            emptyMessage="Ninguna cuenta coincide con la búsqueda."
          />
        )}
      </div>
    </>
  )
}

/**
 * One tab panel: its own search box, a page of the rows it matches, and under
 * them its paginator. Search state is local to each panel, so switching tabs
 * does not touch the other one's query.
 */
function Panel({
  rows,
  label,
  searchPlaceholder,
  searchAriaLabel,
  emptyMessage,
  showLinkFilter = false,
}: {
  rows: RosterRow[]
  label: string
  searchPlaceholder: string
  searchAriaLabel: string
  emptyMessage: string
  /** Only "Todos los alumnos" has both linked and unlinked rows to tell apart */
  showLinkFilter?: boolean
}) {
  const [query, setQuery] = useState('')
  const [linkFilter, setLinkFilter] = useState<Set<LinkFilter>>(new Set())
  const [page, setPage] = useState(1)
  const top = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return rows.filter((row) => {
      if (needle && !row.searchText.includes(needle)) return false

      if (linkFilter.size > 0) {
        const state: LinkFilter = row.linked ? 'linked' : 'unlinked'
        if (!linkFilter.has(state)) return false
      }

      return true
    })
  }, [rows, query, linkFilter])

  // Back to the first page whenever the search or the filter narrows or
  // widens the list — `filtered` is a memo, so its identity is that change.
  // Same trick as AssignmentRepoList.tsx.
  const [lastFiltered, setLastFiltered] = useState(filtered)
  if (lastFiltered !== filtered) {
    setLastFiltered(filtered)
    setPage(1)
  }

  const pageCount = Math.ceil(filtered.length / PER_PAGE)

  return (
    <div className="px-2" ref={top}>
      <div className="mb-3 d-flex flex-column-reverse flex-sm-row flex-wrap">
        {showLinkFilter && (
          <CheckboxMenu
            label="Filtrar por vínculo"
            heading="Filtrar por vínculo:"
            options={[
              { value: 'linked', label: 'Vinculados' },
              { value: 'unlinked', label: 'Sin vincular' },
            ]}
            selected={linkFilter}
            onToggle={(value) => setLinkFilter(toggle(linkFilter, value))}
          />
        )}

        <div className="flex-1 mb-2 mb-sm-0">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={searchPlaceholder}
            ariaLabel={searchAriaLabel}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="color-fg-muted text-center my-3 mb-0">{emptyMessage}</p>
      ) : (
        filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((row) => row.node)
      )}

      {/* `<div class="d-flex col-12">` around the paginator, as in the view */}
      <div className="d-flex col-12">
        <Pagination
          page={page}
          pageCount={pageCount}
          label={label}
          onChange={(next) => {
            setPage(next)
            top.current?.scrollIntoView({ block: 'start' })
          }}
        />
      </div>
    </div>
  )
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (!next.delete(value)) next.add(value)
  return next
}

function Tab({
  id,
  label,
  count,
  selected,
  onSelect,
}: {
  id: 'students' | 'accounts'
  label: string
  count: number
  selected: string
  onSelect: (id: 'students' | 'accounts') => void
}) {
  const isSelected = selected === id

  return (
    <li role="presentation" className="d-inline-flex">
      <button
        id={`roster-tab-${id}`}
        type="button"
        role="tab"
        aria-controls={`panel-roster-${id}`}
        aria-selected={isSelected}
        tabIndex={isSelected ? 0 : -1}
        className={`tabnav-tab ${isSelected ? 'selected' : ''}`}
        onClick={() => onSelect(id)}
      >
        <span>{label}</span>
        <span title={String(count)} className="Counter ml-2">
          {count}
        </span>
      </button>
    </li>
  )
}
