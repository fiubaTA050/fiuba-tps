'use client'

import { CheckCircleIcon, ClockIcon } from '@primer/octicons-react'
import { useActionState } from 'react'

import { confirmSubmissionAction } from '@/app/assignment-invitations/[key]/actions'
import type { CheckpointPanel, SubmissionRow } from '@/lib/data/submissions'
import { formatArgentina } from '@/lib/dates'
import { EMPTY_STATE, type InvitationActionState } from '@/lib/form'

/**
 * Where the student hands in, under the repository card of
 * `assignment_invitations/setup.html.erb`.
 *
 * There is nothing to port: the original has no submission of the student's
 * own. It lives on this screen, and not on a route of its own, because this is
 * the only screen a student has and the invitation link is what they keep — no
 * new route, no new auth surface. See docs/entregas.md.
 *
 * With several entregas (TP2 is 2A to 2D) this is one row per entrega, each
 * collapsed behind `<details>` — the same idiom this file already uses for
 * "Ver mis entregas anteriores" — so a cohort with four dates does not dump
 * four open forms on the page at once. The one entrega still open and not yet
 * confirmed starts expanded; the rest wait for a click. An assignment with a
 * single entrega (still the common case today) skips the disclosure
 * entirely and renders exactly like before — one form, no click needed.
 */
export function SubmissionPanel({
  invitationKey,
  repoUrl,
  defaultBranch,
  panels,
}: {
  invitationKey: string
  /** `https://github.com/org/repo`, for the link to the frozen tree */
  repoUrl: string
  defaultBranch: string
  panels: CheckpointPanel[]
}) {
  const [state, formAction, pending] = useActionState<InvitationActionState, FormData>(
    confirmSubmissionAction,
    EMPTY_STATE,
  )

  // Nothing to hand in: the teacher has not opened entregas for this assignment
  if (panels.length === 0) {
    return (
      <div className="Box mt-4">
        <div className="Box-body">
          <h3 className="h5 mb-1">Entrega</h3>
          <p className="color-fg-muted mb-0">
            El docente todavía no habilitó las entregas para este trabajo práctico.
          </p>
        </div>
      </div>
    )
  }

  // The one entrega that still needs action, if any — the rest start collapsed
  const openCheckpointId = panels.find((panel) => panel.enabled && panel.current === null)?.checkpointId

  return (
    <div className="Box mt-4">
      <div className="Box-body">
        <h3 className="h5 mb-1">{panels.length === 1 ? 'Entrega' : 'Entregas'}</h3>

        {state.error && <div className="flash flash-error mb-3">{state.error}</div>}
        {state.notice && <div className="flash mb-3">{state.notice}</div>}

        {panels.length === 1 ? (
          <PanelBody
            invitationKey={invitationKey}
            repoUrl={repoUrl}
            defaultBranch={defaultBranch}
            panel={panels[0]}
            formAction={formAction}
            pending={pending}
          />
        ) : (
          panels.map((panel, index) => (
            <details
              key={panel.checkpointId}
              className={index > 0 ? 'mt-3 pt-3 border-top' : 'mt-2'}
              open={panel.checkpointId === openCheckpointId}
            >
              <summary style={{ cursor: 'pointer' }}>
                <strong>{panel.title ?? 'Entrega'}</strong>{' '}
                <EntregaStatus panel={panel} />{' '}
                <span className="color-fg-muted f6">
                  {panel.deadlineAt ? formatArgentina(panel.deadlineAt) : 'Sin fecha límite'}
                </span>
              </summary>

              <div className="mt-2">
                <PanelBody
                  invitationKey={invitationKey}
                  repoUrl={repoUrl}
                  defaultBranch={defaultBranch}
                  panel={panel}
                  formAction={formAction}
                  pending={pending}
                />
              </div>
            </details>
          ))
        )}
      </div>
    </div>
  )
}

/** The summary line's state, for the collapsed row — mirrors the teacher dashboard's own labels */
function EntregaStatus({ panel }: { panel: CheckpointPanel }) {
  if (panel.current) {
    return (
      <span className="IssueLabel color-bg-success">
        Confirmado {panel.current.sha.slice(0, 7)}
        {panel.current.late && <LateLabel />}
      </span>
    )
  }

  if (!panel.enabled) {
    return <span className="IssueLabel color-bg-subtle">Cerrada</span>
  }

  return <span className="IssueLabel color-bg-attention">Sin confirmar</span>
}

/** Deadline note, the confirmed flash, the form or the disabled message, and the history */
function PanelBody({
  invitationKey,
  repoUrl,
  defaultBranch,
  panel,
  formAction,
  pending,
}: {
  invitationKey: string
  repoUrl: string
  defaultBranch: string
  panel: CheckpointPanel
  formAction: (formData: FormData) => void
  pending: boolean
}) {
  const refId = `ref-${panel.checkpointId}`
  const declarationId = `ai_declaration-${panel.checkpointId}`

  return (
    <>
      <p className="color-fg-muted">
        {panel.deadlineAt ? (
          <>
            <ClockIcon className="mr-1" />
            Fecha de entrega: <strong>{formatArgentina(panel.deadlineAt)}</strong>
            {/* The deadline closes nothing: what follows is a warning, not a wall */}
            {panel.overdue && ' — ya pasó, lo que entregues queda marcado como tarde.'}
          </>
        ) : (
          'Este trabajo práctico no tiene fecha de entrega.'
        )}
      </p>

      {panel.current && (
        <div className="flash flash-success mb-3">
          <CheckCircleIcon className="mr-1" />
          Entregaste <SubmissionLink repoUrl={repoUrl} row={panel.current} /> el{' '}
          {formatArgentina(panel.current.submittedAt)}
          {panel.current.late && <LateLabel />}
        </div>
      )}

      {panel.enabled ? (
        <form action={formAction}>
          <input type="hidden" name="key" value={invitationKey} />
          <input type="hidden" name="checkpoint_id" value={panel.checkpointId} />

          <div className="form-group mt-0">
            <div className="form-group-header">
              <label htmlFor={refId}>Rama, tag o commit a entregar</label>
            </div>
            <div className="form-group-body d-flex">
              <input
                type="text"
                id={refId}
                name="ref"
                className="form-control flex-auto mr-2"
                defaultValue={panel.current?.ref ?? defaultBranch}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending ? 'Confirmando…' : panel.current ? 'Cambiar entrega' : 'Confirmar entrega'}
              </button>
            </div>
            <p className="note">
              Lo que confirmes queda congelado aunque después sigas trabajando. Podés volver a
              entregar las veces que quieras mientras el trabajo práctico esté activo.
            </p>
          </div>

          <div className="form-group">
            <div className="form-group-header">
              <label htmlFor={declarationId}>Declaración de uso de IA</label>
            </div>
            <div className="form-group-body">
              <textarea
                id={declarationId}
                name="ai_declaration"
                className="form-control width-full"
                rows={3}
                required
                defaultValue={panel.current?.aiDeclaration ?? ''}
              />
            </div>
            <p className="note">
              Declaración jurada: contá qué herramientas de IA usaste y para qué partes del
              trabajo práctico, o escribí que no usaste ninguna.
            </p>
          </div>
        </form>
      ) : (
        // Two independent reasons land here: AssignmentInvitation#reason_for_disabled_invitations
        // (Inactive/archived) or this entrega itself being closed — both come
        // through `panel.disabledReason`, already worded for this screen
        <div className="flash flash-warn mb-0">
          No se pueden confirmar entregas. {panel.disabledReason}
        </div>
      )}

      {panel.history.length > 1 && (
        <details className="mt-3">
          <summary className="btn-link">Ver mis {panel.history.length} entregas</summary>
          <ul className="list-style-none mt-2">
            {panel.history.map((row) => (
              <li key={row.id} className="py-1 border-bottom color-fg-muted f6">
                <SubmissionLink repoUrl={repoUrl} row={row} /> el {formatArgentina(row.submittedAt)}
                {row.late && <LateLabel />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

/**
 * The live site's "Late".
 *
 * `IssueLabel` and a background role rather than `Label--attention`: Primer v22
 * dropped that modifier and app/globals.css only copies plain `.Label` from
 * primer 10, whose `color: #fff` with no background painted this white on the
 * green flash. Same idiom as the dashboard rows.
 */
function LateLabel() {
  return <span className="IssueLabel color-bg-attention ml-2">Tarde</span>
}

/**
 * `tree_url_for_sha(submission_sha)` of the original's
 * SharedAssignmentRepoView, which is the one piece of this that does port.
 *
 * The link keeps working after a force-push: a displaced commit stays reachable
 * by SHA, measured 2,5 months later. See docs/entregas.md.
 */
function SubmissionLink({ repoUrl, row }: { repoUrl: string; row: SubmissionRow }) {
  return (
    <>
      <a href={`${repoUrl}/tree/${row.sha}`} target="_blank" rel="noreferrer" className="text-mono">
        {row.sha.slice(0, 7)}
      </a>{' '}
      <span className="color-fg-muted">({row.ref})</span>
    </>
  )
}
