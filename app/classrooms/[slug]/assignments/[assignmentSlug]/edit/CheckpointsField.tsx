'use client'

import { ChevronDownIcon, ChevronUpIcon, PlusIcon, TrashIcon } from '@primer/octicons-react'
import { useState } from 'react'

export type CheckpointFieldValue = {
  /** Null for a row the teacher just added, not saved yet */
  id: number | null
  /** '' is the single unnamed entrega — see lib/data/checkpoints.ts */
  title: string
  /** `datetime-local` value in Argentine time, '' for no date yet */
  deadlineAt: string
  autograderId: string
  closed: boolean
  /** What blocks removing this row — see saveCheckpoints */
  submissionCount: number
}

type Row = CheckpointFieldValue & { key: string }

let nextKey = 0

/**
 * The repeatable list of an assignment's entregas: 2A-2D for TP2, or a single
 * row for a TP with one date — a TP with one date is not a special case, it
 * is a list of one. See docs/entregas.md.
 *
 * Submitted as one hidden JSON field (`checkpoints`) inside the surrounding
 * `<form>`, which `updateAssignmentAction` hands to `saveCheckpoints`.
 * Position is just array order: reordering with the arrows is resubmitting
 * the same list shuffled, nothing else changes.
 *
 * No existing form in this codebase builds a client-side list like this one —
 * everything else posts a fixed set of fields — so there is no convention
 * this had to match.
 */
export function CheckpointsField({ initial }: { initial: CheckpointFieldValue[] }) {
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((row) => ({ ...row, key: String(nextKey++) })),
  )

  function update(key: string, patch: Partial<CheckpointFieldValue>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function addRow() {
    setRows((current) => [
      ...current,
      {
        key: String(nextKey++),
        id: null,
        title: '',
        deadlineAt: '',
        autograderId: '',
        closed: false,
        submissionCount: 0,
      },
    ])
  }

  function removeRow(key: string) {
    setRows((current) => current.filter((row) => row.key !== key))
  }

  function move(key: string, delta: number) {
    setRows((current) => {
      const index = current.findIndex((row) => row.key === key)
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const payload: CheckpointFieldValue[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    deadlineAt: row.deadlineAt,
    autograderId: row.autograderId,
    closed: row.closed,
    submissionCount: row.submissionCount,
  }))

  return (
    <div>
      <input type="hidden" name="checkpoints" value={JSON.stringify(payload)} />

      {rows.length === 0 ? (
        <p className="note">
          Sin entregas: los alumnos todavía no tienen nada que confirmar.
        </p>
      ) : (
        <div className="Box mb-3 p-3" style={{ overflowX: 'auto' }}>
          <div className="checkpoints-grid">
            <div className="checkpoints-grid-header" aria-hidden="true" />
            <div className="checkpoints-grid-header">Título</div>
            <div className="checkpoints-grid-header">Fecha límite</div>
            <div className="checkpoints-grid-header">Corrección automática</div>
            <div className="checkpoints-grid-header text-center">Cerrar</div>
            <div className="checkpoints-grid-header" aria-hidden="true" />

            {rows.map((row, index) => {
              const label = row.title || 'esta entrega'
              return (
                <div className="checkpoint-row" key={row.key}>
                  {index > 0 && <div className="checkpoint-row-separator" />}

                  <div className="checkpoints-grid-cell d-flex flex-column">
                    <button
                      type="button"
                      className="btn-octicon"
                      disabled={index === 0}
                      onClick={() => move(row.key, -1)}
                      aria-label={`Subir "${label}"`}
                    >
                      <ChevronUpIcon />
                    </button>
                    <button
                      type="button"
                      className="btn-octicon"
                      disabled={index === rows.length - 1}
                      onClick={() => move(row.key, 1)}
                      aria-label={`Bajar "${label}"`}
                    >
                      <ChevronDownIcon />
                    </button>
                  </div>

                  <div className="checkpoints-grid-cell">
                    <input
                      type="text"
                      className="form-control input-block"
                      placeholder="Sin título"
                      aria-label={`Título de ${label}`}
                      value={row.title}
                      maxLength={60}
                      onChange={(event) => update(row.key, { title: event.target.value })}
                    />
                  </div>

                  <div className="checkpoints-grid-cell">
                    <input
                      type="datetime-local"
                      className="form-control input-block"
                      aria-label={`Fecha límite de ${label}`}
                      value={row.deadlineAt}
                      onChange={(event) => update(row.key, { deadlineAt: event.target.value })}
                    />
                  </div>

                  <div className="checkpoints-grid-cell">
                    <input
                      type="text"
                      className="form-control input-block"
                      autoComplete="off"
                      aria-label={`Corrección automática de ${label}`}
                      value={row.autograderId}
                      onChange={(event) => update(row.key, { autograderId: event.target.value })}
                    />
                  </div>

                  <div className="checkpoints-grid-cell d-flex flex-justify-center">
                    <input
                      type="checkbox"
                      aria-label={`Cerrar ${label}`}
                      checked={row.closed}
                      onChange={(event) => update(row.key, { closed: event.target.checked })}
                    />
                  </div>

                  <div className="checkpoints-grid-cell">
                    <button
                      type="button"
                      // `.btn-octicon-danger` only turns red on hover; this row's
                      // warning — like RosterEntryRow's — is red at rest
                      className="btn-octicon btn-octicon-danger color-fg-danger"
                      disabled={row.submissionCount > 0}
                      title={
                        row.submissionCount > 0
                          ? `No se puede borrar: ya tiene ${row.submissionCount} ` +
                            `confirmada${row.submissionCount === 1 ? '' : 's'}.`
                          : 'Borrar esta entrega'
                      }
                      onClick={() => removeRow(row.key)}
                      aria-label={`Borrar "${label}"`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <button type="button" className="btn btn-primary" onClick={addRow}>
        <PlusIcon className="mr-1" />
        Agregar entrega
      </button>
    </div>
  )
}
