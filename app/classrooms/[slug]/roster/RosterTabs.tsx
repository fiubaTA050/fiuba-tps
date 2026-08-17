'use client'

import { useState, type ReactNode } from 'react'

/**
 * The roster page's two tabs, ported from the live site's `tab-container`:
 * "All students" and "Unlinked GitHub accounts", each with its Counter.
 *
 * Both panels come in already server-rendered and only one is `hidden`, which
 * is what the live site does too — switching costs no request, and the
 * browser's find-in-page still reaches the roster, which is the whole reason
 * this page is not paginated.
 */
export function RosterTabs({
  studentsCount,
  students,
  accountsCount,
  accounts,
}: {
  studentsCount: number
  students: ReactNode
  accountsCount: number
  accounts: ReactNode
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
        <div className="px-2">{students}</div>
      </div>

      <div
        id="panel-roster-accounts"
        role="tabpanel"
        aria-labelledby="roster-tab-accounts"
        hidden={selected !== 'accounts'}
      >
        <div className="px-2">{accounts}</div>
      </div>
    </>
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
