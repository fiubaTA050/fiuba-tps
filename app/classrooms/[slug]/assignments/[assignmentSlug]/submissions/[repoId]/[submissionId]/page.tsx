import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import Link from 'next/link'

import { Breadcrumb } from '@/components/Breadcrumb'
import { LateJustificationButton } from '@/components/LateJustificationDialog'
import { SubmissionFeedbackForm } from '@/components/SubmissionFeedbackForm'
import { findAssignment } from '@/lib/data/assignments'
import { findClassroomInstallation } from '@/lib/data/organizations'
import {
  findSubmissionDetail,
  type GradingRunRow,
  type LateJustification,
} from '@/lib/data/submissions'
import { formatArgentina } from '@/lib/dates'
import { isUsableSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

const STATUS: Record<GradingRunRow['status'], { label: string; tone: string }> = {
  leased: { label: 'En curso', tone: 'color-bg-attention' },
  succeeded: { label: 'Completada', tone: 'color-bg-success' },
  failed: { label: 'Falló', tone: 'color-bg-danger' },
}

/**
 * The two facts a docente cannot see anywhere else about one entrega: the
 * student's AI declaration and every automated-grading attempt against it —
 * and, last, the devolución the docente writes after reading them (see
 * `submissionFeedbacks` in db/schema.ts). Linked from the "Ver entregas
 * anteriores" list in AssignmentRepoList.tsx and from the row's ⋯.
 *
 * Frame is the breadcrumb alone, not ClassroomShell, same reasoning as
 * .../assignments/[assignmentSlug]/page.tsx: a step away from the classroom,
 * not one of its tabs.
 */
export default async function SubmissionDetailPage(
  props: PageProps<'/classrooms/[slug]/assignments/[assignmentSlug]/submissions/[repoId]/[submissionId]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug, repoId, submissionId } = await props.params
  const githubRepoId = Number(repoId)
  const id = Number(submissionId)
  if (!Number.isInteger(githubRepoId) || !Number.isInteger(id)) notFound()

  const [classroom, assignment, detail] = await Promise.all([
    findClassroomInstallation(session, slug),
    findAssignment(session, slug, assignmentSlug),
    findSubmissionDetail(session, slug, assignmentSlug, githubRepoId, id),
  ])

  if (!classroom || !assignment || !detail) notFound()

  const { submission, gradingRuns, justifications } = detail
  const assignmentPath = `/classrooms/${classroom.slug}/assignments/${assignment.slug}`
  const active = justifications.find((justification) => justification.revokedAt === null) ?? null
  const revoked = justifications.filter((justification) => justification.revokedAt !== null)

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
          {
            label: assignment.title,
            href: assignmentPath,
          },
          {
            label: 'Entrega',
            href: `${assignmentPath}/submissions/${repoId}/${submissionId}`,
          },
        ]}
      />

      <div className="container-md p-responsive">
        <div className="Box mt-4">
          <div className="Box-body">
            <h3 className="h5 mb-2">
              {detail.entrega.title ? `Entrega ${detail.entrega.title}` : 'Entrega'}
              {detail.submittedBy && (
                <span className="color-fg-muted text-normal"> de @{detail.submittedBy}</span>
              )}
            </h3>
            <p className={`color-fg-muted ${detail.newer ? '' : 'mb-0'}`}>
              <span className="text-mono">{submission.sha.slice(0, 7)}</span>{' '}
              <span className="color-fg-muted">({submission.ref})</span> el{' '}
              {formatArgentina(submission.submittedAt)}
              {submission.late && (
                <span className="IssueLabel color-bg-attention ml-2">
                  {submission.lateJustified ? 'Tarde · justificada' : 'Tarde'}
                </span>
              )}
            </p>

            {/* The devolución stays on this SHA; the student reads it marked
                as being about an older entrega — findStudentFeedback */}
            {detail.newer && (
              <div className="flash flash-warn mb-0">
                El alumno volvió a entregar después: la entrega vigente es{' '}
                <Link
                  href={`${assignmentPath}/submissions/${repoId}/${detail.newer.id}`}
                  className="text-mono"
                >
                  {detail.newer.sha.slice(0, 7)}
                </Link>
                , del {formatArgentina(detail.newer.submittedAt)}
              </div>
            )}
          </div>
        </div>

        {/* Only a late submission has anything to justify — see
            lateSubmissionJustifications in db/schema.ts */}
        {submission.late && (
          <div className="Box mt-3">
            <div className="Box-body">
              <div className="d-flex flex-justify-between flex-items-center mb-2">
                <h3 className="h5">Justificación de la demora</h3>
                <LateJustificationButton
                  target={{
                    classroomSlug: classroom.slug,
                    assignmentSlug: assignment.slug,
                    githubRepoId,
                    submissionId: submission.id,
                    reason: active?.reason ?? null,
                  }}
                />
              </div>

              {active ? (
                <Justification justification={active} />
              ) : (
                <p className="color-fg-muted mb-0">
                  Sin justificar: cuenta como entregada tarde.
                </p>
              )}

              {revoked.length > 0 && (
                <details className="mt-3">
                  <summary className="btn-link f6">
                    {revoked.length === 1
                      ? 'Ver 1 justificación quitada'
                      : `Ver ${revoked.length} justificaciones quitadas`}
                  </summary>
                  <ul className="list-style-none mt-2">
                    {revoked.map((justification) => (
                      <li key={justification.id} className="py-2 border-top color-fg-muted">
                        <Justification justification={justification} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}

        <div className="Box mt-3">
          <div className="Box-body">
            <h3 className="h5 mb-2">Declaración de uso de IA</h3>
            {submission.aiDeclaration ? (
              <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                {submission.aiDeclaration}
              </p>
            ) : (
              <p className="color-fg-muted mb-0">
                Esta entrega es anterior a que se pidiera esta declaración.
              </p>
            )}
          </div>
        </div>

        <div className="Box mt-3">
          <div className="Box-body">
            <h3 className="h5 mb-2">Corrección automática</h3>
            {gradingRuns.length === 0 ? (
              <p className="color-fg-muted mb-0">
                No hay correcciones automáticas para esta entrega todavía.
              </p>
            ) : (
              <ul className="list-style-none">
                {gradingRuns.map((run) => (
                  <GradingRun key={run.id} run={run} />
                ))}
              </ul>
            )}
          </div>
        </div>

        <SubmissionFeedbackForm
          target={{
            classroomSlug: classroom.slug,
            assignmentSlug: assignment.slug,
            githubRepoId,
            submissionId: submission.id,
          }}
          versions={detail.feedback}
          entrega={detail.entrega.title ?? 'esta entrega'}
          published={detail.entrega.resultsPublished}
          publishHref={`${assignmentPath}/edit#entregas`}
        />
      </div>
    </>
  )
}

/** Who wrote it and when, then the reason; who took it back, when it was */
function Justification({ justification }: { justification: LateJustification }) {
  return (
    <>
      <p className="mb-1" style={{ whiteSpace: 'pre-wrap' }}>
        {justification.reason}
      </p>
      <p className="color-fg-muted f6 mb-0">
        Justificada{justification.createdBy && ` por @${justification.createdBy}`} el{' '}
        {formatArgentina(justification.createdAt)}
        {justification.revokedAt && (
          <>
            {' '}
            · quitada{justification.revokedBy && ` por @${justification.revokedBy}`} el{' '}
            {formatArgentina(justification.revokedAt)}
          </>
        )}
      </p>
    </>
  )
}

type GradescopeTest = {
  name?: string
  score?: number
  max_score?: number
  status?: string
  output?: string
}

function GradingRun({ run }: { run: GradingRunRow }) {
  const status = STATUS[run.status]
  const tests = Array.isArray(run.tests) ? (run.tests as GradescopeTest[]) : []

  return (
    <li className="py-2 border-bottom">
      <p className="mb-1">
        <span className={`IssueLabel mr-2 ${status.tone}`}>{status.label}</span>
        {run.score !== null && <strong className="mr-2">{run.score}</strong>}
        <span className="color-fg-muted f6">
          {run.completedAt
            ? `Terminó el ${formatArgentina(run.completedAt)}`
            : `Iniciada el ${formatArgentina(run.leasedAt)}`}
        </span>
      </p>

      {tests.length > 0 && (
        <table className="width-full f6 mb-2">
          <tbody>
            {tests.map((test, index) => (
              <tr key={index} className="border-bottom">
                <td className="py-1">{test.name ?? '—'}</td>
                <td className="py-1 color-fg-muted">{test.status ?? '—'}</td>
                <td className="py-1 text-right">
                  {test.score ?? '—'}
                  {test.max_score !== undefined && ` / ${test.max_score}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {run.output && (
        <details>
          <summary className="btn-link f6">Ver salida</summary>
          <pre className="color-bg-subtle p-2 f6" style={{ whiteSpace: 'pre-wrap' }}>
            {run.output}
          </pre>
        </details>
      )}
    </li>
  )
}
