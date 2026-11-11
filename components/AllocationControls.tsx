'use client'

import { CheckIcon, PersonIcon, TriangleDownIcon } from '@primer/octicons-react'
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
 */

/**
 * Who corrects each row, for a teacher. Absent for a TA and on a classroom
 * with no TAs, where there is nothing to show or pick.
 */
export type Allocation = {
  assistants: AllocatableAssistant[]
  /** False on an archived classroom: the names show, the menus do not */
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
 * The allocations of a dashboard's rows and the selection of the bulk bar.
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

  /** The `allocationTarget`s of the rows ticked for the bulk bar */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function toggleSelected(target: number, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (on) next.add(target)
      else next.delete(target)
      return next
    })
  }

  /**
   * Allocates a TA to `targetIds`, or takes them off. `clearSelection` is the
   * bulk bar's: the ticks go once the change went through, and stay for a
   * retry when it did not.
   */
  function apply(
    teachingAssistantId: number,
    targetIds: number[],
    allocate: boolean,
    clearSelection = false,
  ) {
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
      if (clearSelection) setSelected(new Set())
    })
  }

  return { allocated, selected, setSelected, toggleSelected, error, pending, apply }
}

function loginOf(assistants: AllocatableAssistant[], id: number): string {
  const login = assistants.find((assistant) => assistant.id === id)?.githubLogin
  return login ? `@${login}` : 'Ayudante'
}

/**
 * The TAs of one row, as the summary of a menu that toggles each of them.
 * Read-only — just the names — when the classroom is archived.
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
  const names = assigned.map((id) => loginOf(assistants, id)).join(', ')
  const text = assigned.length === 0 ? 'Sin ayudante' : names

  if (!editable) {
    return (
      <p className="color-fg-muted mr-3 text-small mb-0">
        <PersonIcon className="v-align-bottom mr-1" />
        {text}
      </p>
    )
  }

  return (
    <details className="dropdown details-reset details-overlay d-inline-block mr-3">
      <summary
        className="Link--muted text-small"
        role="button"
        aria-haspopup="menu"
        aria-label={`Ayudantes de ${rowName}: ${text}`}
      >
        <PersonIcon className="v-align-bottom mr-1" />
        {text}
        <TriangleDownIcon className="ml-1" />
      </summary>

      <div className="ActionMenu-anchor">
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
                      <span className="ActionListItem-label">
                        {loginOf(assistants, assistant.id)}
                      </span>
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
 * Shown while rows are selected: allocates or takes off one TA over all of
 * them at once, which is how a cohort gets split between TAs.
 */
export function AllocationBar({
  assistants,
  selectedCount,
  pending,
  onApply,
  onClear,
}: {
  assistants: AllocatableAssistant[]
  selectedCount: number
  pending: boolean
  onApply: (teachingAssistantId: number, allocate: boolean) => void
  onClear: () => void
}) {
  return (
    <div className="d-flex flex-items-center flex-wrap color-bg-accent rounded-2 px-3 py-2 mt-3">
      <span className="text-bold mr-3">
        {selectedCount === 1 ? '1 fila seleccionada' : `${selectedCount} filas seleccionadas`}
      </span>
      <AssistantPicker
        label="Asignar a"
        assistants={assistants}
        pending={pending}
        onPick={(id) => onApply(id, true)}
      />
      <AssistantPicker
        label="Quitar a"
        assistants={assistants}
        pending={pending}
        onPick={(id) => onApply(id, false)}
      />
      <button type="button" className="btn-link Link--muted ml-auto" onClick={onClear}>
        Deseleccionar
      </button>
    </div>
  )
}

function AssistantPicker({
  label,
  assistants,
  pending,
  onPick,
}: {
  label: string
  assistants: AllocatableAssistant[]
  pending: boolean
  onPick: (teachingAssistantId: number) => void
}) {
  return (
    <details className="dropdown details-reset details-overlay d-inline-block mr-2">
      <summary className="btn btn-sm" role="button" aria-haspopup="menu" aria-disabled={pending}>
        {label}
        <TriangleDownIcon className="ml-1" />
      </summary>

      <div className="ActionMenu-anchor">
        <div className="Overlay Overlay--size-auto">
          <div className="Overlay-body Overlay-body--paddingNone">
            <ul role="menu" className="ActionListWrap ActionListWrap--inset">
              {assistants.map((assistant) => (
                <li key={assistant.id} role="none" className="ActionListItem">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={pending}
                    className="ActionListContent"
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open')
                      onPick(assistant.id)
                    }}
                  >
                    <span className="ActionListItem-label">
                      {loginOf(assistants, assistant.id)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </details>
  )
}
