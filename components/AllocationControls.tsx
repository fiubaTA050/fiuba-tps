'use client'

import { CheckIcon, PersonAddIcon, TriangleDownIcon } from '@primer/octicons-react'
import { useState, useTransition } from 'react'

import { setAllocationAction } from '@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions'
import type { AssignmentKind } from '@/lib/assignment-paths'
import type { RepoRow } from '@/lib/assignment-rows'
import type { AllocatableAssistant } from '@/lib/data/teaching-assistants'

/**
 * The teacher's controls for who corrects each row of an assignment
 * dashboard — no live equivalent, the live site has no TA role (see
 * docs/teaching-assistants.md). Built from the same `<details>` + ActionList
 * markup as CheckboxMenu, so the menus read like the filter bar above them.
 *
 * There are no selection checkboxes: the bulk action works on whatever the
 * filters left, so "Sin asignar" plus a search is the selection.
 */

/**
 * Who corrects each row, for a teacher. Absent for a TA and on a classroom
 * with no TAs, where there is nothing to show or pick.
 */
export type Allocation = {
  assistants: AllocatableAssistant[]
  /** False on an archived classroom: the avatars show, the menus do not */
  editable: boolean
}

/** Each allocatable row's TAs, keyed by `allocationTarget` */
function allocationsOf(rows: RepoRow[]): Map<number, number[]> {
  const byTarget = new Map<number, number[]>()
  for (const row of rows) {
    if (row.allocationTarget !== undefined) {
      byTarget.set(row.allocationTarget, row.assistantIds ?? [])
    }
  }
  return byTarget
}

/**
 * The allocations of a dashboard's rows.
 *
 * Kept on the client rather than re-read from the server: an allocation
 * answers with success and the list applies it itself, because revalidating
 * would re-read every repository from GitHub. Re-seeded from `rows` whenever
 * the page does re-render, for any other reason.
 */
export function useAllocations({
  rows,
  classroomSlug,
  assignmentSlug,
  kind,
}: {
  rows: RepoRow[]
  classroomSlug: string
  assignmentSlug: string
  kind: AssignmentKind
}) {
  const [allocated, setAllocated] = useState(() => allocationsOf(rows))
  const [seededFrom, setSeededFrom] = useState(rows)
  if (seededFrom !== rows) {
    setSeededFrom(rows)
    setAllocated(allocationsOf(rows))
  }

  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  /** Allocates a TA to `targetIds`, or takes them off */
  function apply(teachingAssistantId: number, targetIds: number[], allocate: boolean) {
    setError(null)
    startTransition(async () => {
      let result: { error: string | null }
      try {
        result = await setAllocationAction({
          classroomSlug,
          assignmentSlug,
          kind,
          teachingAssistantId,
          targetIds,
          allocate,
        })
      } catch {
        // A dropped connection or a server failure. Uncaught, React would
        // hand it to the error boundary and take the whole dashboard with it
        setError('No pudimos guardar la asignación. Probá de nuevo.')
        return
      }

      if (result.error) {
        setError(result.error)
        return
      }

      setAllocated((previous) => {
        const next = new Map(previous)
        for (const target of targetIds) {
          const current = next.get(target) ?? []
          next.set(
            target,
            allocate
              ? [...new Set([...current, teachingAssistantId])]
              : current.filter((id) => id !== teachingAssistantId),
          )
        }
        return next
      })
    })
  }

  return { allocated, error, pending, apply }
}

function loginOf(assistant: AllocatableAssistant | undefined): string {
  return assistant?.githubLogin ? `@${assistant.githubLogin}` : 'Ayudante'
}

function AssistantAvatar({ assistant, size }: { assistant: AllocatableAssistant; size: 16 | 20 }) {
  const src =
    assistant.githubAvatarUrl ??
    (assistant.githubLogin ? `https://github.com/${assistant.githubLogin}.png?size=40` : null)

  if (!src) return null

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`avatar circle ${size === 16 ? 'avatar-small' : ''}`}
    />
  )
}

/**
 * The TAs of one row: their avatars on a button that opens the menu, or a
 * "person add" icon when there are none. A button and not bare avatars,
 * because a team's row already carries its members' avatars right beside it.
 * Read-only — the avatars alone — when the classroom is archived.
 */
export function AssistantRowMenu({
  assistants,
  assigned,
  editable,
  pending,
  onToggle,
  rowName,
}: {
  assistants: AllocatableAssistant[]
  /** The TA ids allocated to this row */
  assigned: number[]
  editable: boolean
  pending: boolean
  onToggle: (teachingAssistantId: number, allocate: boolean) => void
  rowName: string
}) {
  const mine = assistants.filter((assistant) => assigned.includes(assistant.id))
  const names = mine.map(loginOf).join(', ')
  const label = mine.length === 0 ? `${rowName}: sin ayudante` : `${rowName}: corrige ${names}`

  const faces = (
    <span className="assistant-faces">
      {mine.map((assistant) => (
        <AssistantAvatar key={assistant.id} assistant={assistant} size={20} />
      ))}
    </span>
  )

  if (!editable) {
    return mine.length === 0 ? null : (
      <span className="mr-2" title={`Corrige ${names}`} aria-label={label}>
        {faces}
      </span>
    )
  }

  return (
    <details className="dropdown details-reset details-overlay d-inline-block mr-2">
      <summary
        className="btn btn-sm"
        role="button"
        aria-haspopup="menu"
        aria-label={`Ayudantes de ${label}`}
        title={mine.length === 0 ? 'Asignar ayudante' : `Corrige ${names}`}
      >
        {mine.length === 0 ? <PersonAddIcon /> : faces}
        <TriangleDownIcon className="ml-1" />
      </summary>

      <div className="ActionMenu-anchor ActionMenu-anchor--right">
        <div className="Overlay Overlay--size-auto">
          <div className="Overlay-body Overlay-body--paddingNone">
            <ul role="menu" className="ActionListWrap ActionListWrap--inset">
              <li className="ActionList-sectionDivider" role="presentation">
                <div className="ActionList-sectionDivider-title">Corrige:</div>
              </li>
              {assistants.map((assistant) => {
                const on = assigned.includes(assistant.id)
                return (
                  <li key={assistant.id} role="none" className="ActionListItem">
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      disabled={pending}
                      onClick={() => onToggle(assistant.id, !on)}
                      className="ActionListContent ActionListContent--visual16"
                    >
                      <span className="ActionListItem-visual ActionListItem-action--leading">
                        <CheckIcon className="ActionListItem-singleSelectCheckmark" />
                      </span>
                      <span className="ActionListItem-visual ActionListItem-visual--leading">
                        <AssistantAvatar assistant={assistant} size={16} />
                      </span>
                      <span className="ActionListItem-label">{loginOf(assistant)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      </div>
    </details>
  )
}

/**
 * "Asignar estas N a…": allocates or takes off one TA over every row the
 * filters left, on every page — how a teacher covers what is still
 * "Sin asignar" without ticking rows one by one.
 */
export function BulkAllocationMenu({
  assistants,
  count,
  pending,
  onApply,
}: {
  assistants: AllocatableAssistant[]
  count: number
  pending: boolean
  onApply: (teachingAssistantId: number, allocate: boolean) => void
}) {
  const section = (title: string, allocate: boolean) => (
    <>
      <li className="ActionList-sectionDivider" role="presentation">
        <div className="ActionList-sectionDivider-title">{title}</div>
      </li>
      {assistants.map((assistant) => (
        <li key={assistant.id} role="none" className="ActionListItem">
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            className="ActionListContent ActionListContent--visual16"
            onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open')
              onApply(assistant.id, allocate)
            }}
          >
            <span className="ActionListItem-visual ActionListItem-visual--leading">
              <AssistantAvatar assistant={assistant} size={16} />
            </span>
            <span className="ActionListItem-label">{loginOf(assistant)}</span>
          </button>
        </li>
      ))}
    </>
  )

  return (
    <details className="dropdown details-reset details-overlay d-inline-block mr-3 text-left">
      <summary className="btn btn-sm" role="button" aria-haspopup="menu" aria-disabled={pending}>
        {count === 1 ? 'Asignar esta fila a…' : `Asignar estas ${count} a…`}
        <TriangleDownIcon className="ml-1" />
      </summary>

      <div className="ActionMenu-anchor ActionMenu-anchor--right">
        <div className="Overlay Overlay--size-auto">
          <div className="Overlay-body Overlay-body--paddingNone">
            <ul role="menu" className="ActionListWrap ActionListWrap--inset">
              {section('Asignar a:', true)}
              {section('Quitar a:', false)}
            </ul>
          </div>
        </div>
      </div>
    </details>
  )
}
