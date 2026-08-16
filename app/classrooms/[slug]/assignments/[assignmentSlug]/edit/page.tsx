import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { Breadcrumb } from '@/components/Breadcrumb'
import { findAssignment } from '@/lib/data/assignments'
import { findClassroom } from '@/lib/data/organizations'
import { findRepositoryById, listTemplateRepositories } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'

import { EditAssignmentForm } from './EditAssignmentForm'

export const dynamic = 'force-dynamic'

/**
 * Port of assignments#edit. The frame is the new screen's — breadcrumb and
 * nothing else, no ClassroomShell — because editing is a step away from the
 * classroom, exactly like creating.
 */
export default async function EditAssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/[assignmentSlug]/edit'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  const [classroom, assignment] = await Promise.all([
    findClassroom(session, slug),
    findAssignment(session, slug, assignmentSlug),
  ])

  if (!classroom || !assignment) notFound()

  const installationId = classroom.organization?.installationId ?? null

  // DA-2: only the id is stored. A starter code that vanished from GitHub comes
  // back null, and the field opens empty rather than with a name we cannot
  // vouch for — saving then clears it, which is the honest outcome.
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
            href: `/classrooms/${classroom.slug}/assignments/${assignment.slug}`,
          },
          {
            label: 'Editar',
            href: `/classrooms/${classroom.slug}/assignments/${assignment.slug}/edit`,
          },
        ]}
      />

      <div className="container-md p-responsive mt-6">
        <h1 className="f2 mb-5">Editar el assignment</h1>

        {/* validate :organization_is_not_archived covers "create or modify",
            and saying it here beats failing on submit */}
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
          <EditAssignmentForm
            classroomSlug={classroom.slug}
            assignment={assignment}
            templates={templates}
            starterCodeFullName={starterCode?.fullName ?? ''}
          />
        )}
      </div>
    </>
  )
}
