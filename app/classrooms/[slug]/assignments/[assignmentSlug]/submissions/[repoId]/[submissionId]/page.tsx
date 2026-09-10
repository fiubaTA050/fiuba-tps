import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { Breadcrumb } from '@/components/Breadcrumb'
import { findAssignment } from '@/lib/data/assignments'
import { findClassroomInstallation } from '@/lib/data/organizations'
import { findSubmissionDetail, type GradingRunRow } from '@/lib/data/submissions'
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
 * student's AI declaration and every automated-grading attempt against it.
 * Linked from the "Ver entregas anteriores" list in AssignmentRepoList.tsx,
 * which keeps showing sha/ref/fecha/Tarde exactly as before.
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

  const { submission, gradingRuns } = detail

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
          {
            label: assignment.title,
            href: `/classrooms/${classroom.slug}/assignments/${assignment.slug}`,
          },
          {
            label: 'Entrega',
            href: `/classrooms/${classroom.slug}/assignments/${assignment.slug}/submissions/${repoId}/${submissionId}`,
          },
        ]}
      />

      <div className="container-md p-responsive">
        <div className="Box mt-4">
          <div className="Box-body">
            <h3 className="h5 mb-2">Entrega</h3>
            <p className="color-fg-muted">
              <span className="text-mono">{submission.sha.slice(0, 7)}</span>{' '}
              <span className="color-fg-muted">({submission.ref})</span> el{' '}
              {formatArgentina(submission.submittedAt)}
              {submission.late && <span className="IssueLabel color-bg-attention ml-2">Tarde</span>}
            </p>
          </div>
        </div>

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

        <div className="Box mt-3 mb-4">
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
      </div>
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
