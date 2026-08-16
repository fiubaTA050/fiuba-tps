import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { Breadcrumb } from '@/components/Breadcrumb'
import { findGroupAssignment, listGroupings } from '@/lib/data/group-assignments'
import { findClassroom } from '@/lib/data/organizations'
import { findRepositoryById, listTemplateRepositories } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'

import { EditGroupAssignmentForm } from './EditGroupAssignmentForm'

export const dynamic = 'force-dynamic'

/** Port of group_assignments#edit */
export default async function EditGroupAssignmentPage(
  props: PageProps<'/classrooms/[slug]/group-assignments/[assignmentSlug]/edit'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  const [classroom, assignment, groupings] = await Promise.all([
    findClassroom(session, slug),
    findGroupAssignment(session, slug, assignmentSlug),
    // Reused for its `teamCount`, which is what max_teams is measured against
    listGroupings(session, slug),
  ])

  if (!classroom || !assignment) notFound()

  const teamCount = groupings.find((one) => one.id === assignment.grouping.id)?.teamCount ?? 0

  const installationId = classroom.organization?.installationId ?? null

  const [templates, starterCode] = await Promise.all([
    installationId !== null && !classroom.archivedAt
      ? listTemplateRepositories(installationId, classroom.organization!.login)
      : [],
    installationId !== null && assignment.starterCodeRepoId !== null
      ? findRepositoryById(installationId, assignment.starterCodeRepoId)
      : null,
  ])

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
          {
            label: assignment.title,
            href: `/classrooms/${classroom.slug}/group-assignments/${assignment.slug}`,
          },
          {
            label: 'Editar',
            href: `/classrooms/${classroom.slug}/group-assignments/${assignment.slug}/edit`,
          },
        ]}
      />

      <div className="container-md p-responsive mt-6">
        <h1 className="f2 mb-5">Editar el assignment grupal</h1>

        {classroom.archivedAt ? (
          <div className="blankslate blankslate-spacious">
            <h3 className="mb-2">Este classroom está archivado</h3>
            <p className="color-fg-muted mb-4">
              No se pueden modificar assignments en un classroom archivado.
            </p>
            <Link href={`/classrooms/${classroom.slug}`} className="btn" role="button">
              Volver al classroom
            </Link>
          </div>
        ) : (
          <EditGroupAssignmentForm
            classroomSlug={classroom.slug}
            assignment={assignment}
            templates={templates}
            starterCodeFullName={starterCode?.fullName ?? ''}
            teamCount={teamCount}
          />
        )}
      </div>
    </>
  )
}
