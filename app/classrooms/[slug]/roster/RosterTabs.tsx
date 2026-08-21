'use client'

import { useRef, useState, type ReactNode } from 'react'

import { Pagination } from '@/components/Pagination'

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

export function RosterTabs({
  studentsCount,
  students,
  accountsCount,
  accounts,
}: {
  studentsCount: number
  /** One node per row, so the panel can hand out a page of them */
  students: ReactNode[]
  accountsCount: number
  accounts: ReactNode[]
}) {
  const [selected, setSelected] = useState<'students' | 'accounts'>('students')

  return (
    <>
      <div className="tabnav">
        <ul role="tablist" aria-label="Roster" className="tabnav-tabs list-style-none">
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
        <Panel rows={students} label="Todos los alumnos" />
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
          <Panel rows={accounts} label="Cuentas de GitHub sin vincular" />
        )}
      </div>
    </>
  )
}

/** One tab panel: a page of rows and, under them, its paginator */
function Panel({ rows, label }: { rows: ReactNode[]; label: string }) {
  const [page, setPage] = useState(1)
  const top = useRef<HTMLDivElement>(null)

  const pageCount = Math.ceil(rows.length / PER_PAGE)

  return (
    <div className="px-2" ref={top}>
      {rows.slice((page - 1) * PER_PAGE, page * PER_PAGE)}

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
