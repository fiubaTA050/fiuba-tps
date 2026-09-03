'use client'

import { CheckCircleIcon, ClockIcon } from '@primer/octicons-react'
import { useActionState } from 'react'

import { confirmSubmissionAction } from '@/app/assignment-invitations/[key]/actions'
import type { SubmissionPanel as Panel, SubmissionRow } from '@/lib/data/submissions'
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
 * With several entregas (TP2 is 2A to 2D) this becomes one row per entrega,
 * only the open one carrying a form. Today an assignment has at most one.
 */
export function SubmissionPanel({
  invitationKey,
  repoUrl,
  defaultBranch,
  panel,
}: {
  invitationKey: string
  /** `https://github.com/org/repo`, for the link to the frozen tree */
  repoUrl: string
  defaultBranch: string
  panel: Panel
}) {
  const [state, formAction, pending] = useActionState<InvitationActionState, FormData>(
    confirmSubmissionAction,
    EMPTY_STATE,
  )

  // Nothing to hand in: the teacher has not opened entregas for this assignment
  if (!panel.hasCheckpoint) {
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

  return (
    <div className="Box mt-4">
      <div className="Box-body">
        <h3 className="h5 mb-1">Entrega</h3>

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

        {state.error && <div className="flash flash-error mb-3">{state.error}</div>}
        {state.notice && <div className="flash mb-3">{state.notice}</div>}

        {panel.enabled ? (
          <form action={formAction}>
            <input type="hidden" name="key" value={invitationKey} />

            <div className="form-group mt-0">
              <div className="form-group-header">
                <label htmlFor="ref">Rama, tag o commit a entregar</label>
              </div>
              <div className="form-group-body d-flex">
                <input
                  type="text"
                  id="ref"
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
                <label htmlFor="ai_declaration">Declaración de uso de IA</label>
              </div>
              <div className="form-group-body">
                <textarea
                  id="ai_declaration"
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
          // AssignmentInvitation#reason_for_disabled_invitations, which is the
          // only thing that actually closes entregas. Its wording is about
          // invitations, so the consequence for this screen is spelled out
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
                  <SubmissionLink repoUrl={repoUrl} row={row} /> el{' '}
                  {formatArgentina(row.submittedAt)}
                  {row.late && <LateLabel />}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
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
