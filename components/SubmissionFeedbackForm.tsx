'use client'

import { EyeIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { useActionState, useState } from 'react'

import { saveSubmissionFeedbackAction } from '@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions'
import { EMPTY_STATE, type RosterActionState } from '@/app/classrooms/[slug]/roster/state'
import type { FeedbackVersion } from '@/lib/data/submissions'
import { formatArgentina } from '@/lib/dates'

import { LinkifiedText } from './LinkifiedText'

// Mirrors MAX_FEEDBACK_LENGTH in lib/data/submissions.ts, which is server-only
const MAX_FEEDBACK_LENGTH = 10_000

/**
 * "Devolución al alumno", the last block of the submission's detail page —
 * see `submissionFeedbacks` in db/schema.ts. Inline rather than a dialog like
 * the justification's: writing is what this block is for.
 *
 * With no devolución the textarea is already open; with one, its text and an
 * "Editar". Every save is a new version, so the ones before stay listed.
 */
export function SubmissionFeedbackForm({
  target,
  versions,
  entrega,
  published,
  publishHref,
}: {
  target: {
    classroomSlug: string
    assignmentSlug: string
    githubRepoId: number
    submissionId: number
  }
  /** Newest first: the first is the current one, a null body a removal */
  versions: FeedbackVersion[]
  /** "2A", or "esta entrega" for the single unnamed one */
  entrega: string
  /** "Publicar" is set on the entrega: saving is what the student reads */
  published: boolean
  /** The edit screen, where "Publicar" lives */
  publishHref: string
}) {
  const latest = versions[0] ?? null
  const current = latest?.body != null ? latest : null
  const previous = versions.slice(1)

  const [editing, setEditing] = useState(false)
  // Controlled, so a refused save keeps what the teacher wrote: React resets
  // an uncontrolled form once its action returns
  const [draft, setDraft] = useState(current?.body ?? '')
  const [error, setError] = useState<string | null>(null)
  // The version the last save was based on. When the page comes back with a
  // newer one, another teacher got there first
  const [submittedBasedOn, setSubmittedBasedOn] = useState<string | null>(null)
  const [, formAction, pending] = useActionState(
    async (previousState: RosterActionState, formData: FormData) => {
      setSubmittedBasedOn(String(formData.get('based_on') ?? ''))
      const result = await saveSubmissionFeedbackAction(previousState, formData)
      setError(result.error)
      // Open on a refusal, even when the form was only showing because there
      // was no devolución yet: the other teacher's save makes `current`
      // non-null, which would otherwise hide the draft
      setEditing(result.error !== null)
      return result
    },
    EMPTY_STATE,
  )

  const overtaken = error !== null && latest !== null && String(latest.id) !== submittedBasedOn

  const showForm = editing || current === null
  const textareaId = `feedback-${target.submissionId}`

  return (
    // `#devolucion` is what the dashboard row's ⋯ links to
    <div id="devolucion" className="Box mt-3 mb-4">
      <div className="Box-body">
        <div className="d-flex flex-justify-between flex-items-center mb-2">
          <h3 className="h5">Devolución al alumno</h3>
          {!showForm && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(current.body!)
                setError(null)
                setEditing(true)
              }}
            >
              Editar
            </button>
          )}
        </div>

        {error && <div className="flash flash-error mb-3">{error}</div>}

        {/* After a refused save the page re-rendered with the other
            teacher's version: show it next to the draft, not instead of it */}
        {showForm && overtaken && (
          <div className="color-bg-subtle p-2 mb-3 rounded-2">
            <p className={`f6 color-fg-muted ${latest.body === null ? 'mb-0' : 'mb-1'}`}>
              {latest.body === null ? 'La quitó' : 'Lo que guardó'}{' '}
              {latest.createdBy ? `@${latest.createdBy}` : 'otro docente'} el{' '}
              {formatArgentina(latest.createdAt)}
              {latest.body !== null && ':'}
            </p>
            {latest.body !== null && <LinkifiedText text={latest.body} className="mb-0" />}
          </div>
        )}

        {showForm ? (
          <form action={formAction}>
            <input type="hidden" name="classroom_slug" value={target.classroomSlug} />
            <input type="hidden" name="assignment_slug" value={target.assignmentSlug} />
            <input type="hidden" name="github_repo_id" value={target.githubRepoId} />
            <input type="hidden" name="submission_id" value={target.submissionId} />
            <input type="hidden" name="based_on" value={latest?.id ?? ''} />

            <textarea
              id={textareaId}
              name="body"
              aria-label="Devolución al alumno"
              className="form-control width-full"
              style={{ minHeight: 140 }}
              maxLength={MAX_FEEDBACK_LENGTH}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="note">
              Opcional. Texto plano: los links se pueden clickear.
              {current && ' Guardarla vacía la quita.'}
            </p>

            {published ? (
              <div className="flash flash-warn mt-2">
                Los resultados de {entrega} ya están publicados: el alumno la ve apenas la guardes.
              </div>
            ) : (
              <Visibility published={false} entrega={entrega} publishHref={publishHref} />
            )}

            <div className="d-flex flex-justify-end mt-3">
              {editing && current && (
                <button
                  type="button"
                  className="btn mr-2"
                  onClick={() => {
                    setError(null)
                    setEditing(false)
                  }}
                >
                  Cancelar
                </button>
              )}
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending ? 'Guardando…' : 'Guardar devolución'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <LinkifiedText text={current.body!} className="mb-2" />
            <p className="color-fg-muted f6 mb-2">
              {current.createdBy ? `@${current.createdBy}` : 'Un docente'} el{' '}
              {formatArgentina(current.createdAt)}
            </p>
            <Visibility published={published} entrega={entrega} publishHref={publishHref} />
          </>
        )}

        {previous.length > 0 && (
          <details className="mt-3">
            <summary className="btn-link f6">
              {previous.length === 1
                ? 'Ver 1 versión anterior'
                : `Ver ${previous.length} versiones anteriores`}
            </summary>
            <ul className="list-style-none mt-2">
              {previous.map((version) => (
                <li key={version.id} className="py-2 border-top color-fg-muted">
                  {version.body !== null && (
                    <LinkifiedText text={version.body} className="mb-1" />
                  )}
                  <p className="f6 mb-0">
                    {version.body === null ? 'Quitada' : 'Guardada'}
                    {version.createdBy && ` por @${version.createdBy}`} el{' '}
                    {formatArgentina(version.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}

function Visibility({
  published,
  entrega,
  publishHref,
}: {
  published: boolean
  entrega: string
  publishHref: string
}) {
  return (
    <p className="d-flex color-fg-muted f6 mb-0">
      <EyeIcon className="mr-2 flex-shrink-0" />
      {published ? (
        <span>Publicada: el alumno la ve en su pantalla de entrega.</span>
      ) : (
        <span>
          El alumno todavía no la ve: se muestra cuando publiques los resultados de {entrega} en{' '}
          <Link href={publishHref}>la edición del trabajo práctico</Link>.
        </span>
      )}
    </p>
  )
}
