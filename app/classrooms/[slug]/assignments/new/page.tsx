import { PersonIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomHeader } from '@/components/ClassroomHeader'
import { findClassroom } from '@/lib/data/organizations'
import { listTemplateRepositories } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'

import { NewAssignmentForm } from './NewAssignmentForm'

export const dynamic = 'force-dynamic'

/**
 * Port of assignments#new.
 *
 * The original reached this screen through organizations#new_assignment, which
 * asked first whether the assignment was individual or group. That chooser has
 * nothing to choose between until group assignments are ported, so the "Nuevo
 * assignment" button leads straight here.
 */
export default async function NewAssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/new'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params
  const classroom = await findClassroom(session, slug)
  if (!classroom) notFound()

  // The org's own templates, to offer without making the teacher type. An
  // unreachable org means no list — the free-text field still works, and the
  // server revalidates whatever arrives either way.
  const templates =
    classroom.organization && !classroom.archivedAt
      ? await listTemplateRepositories(
          classroom.organization.installationId,
          classroom.organization.login,
        )
      : []

  return (
    <>
      <ClassroomHeader classroom={classroom} />

      <div className="Subhead">
        <h2 className="Subhead-heading d-flex flex-items-center">
          <PersonIcon size={22} className="mr-2" />
          Nuevo assignment individual
        </h2>
      </div>

      {/* validate :organization_is_not_archived. The original let you open the
          form and only failed on submit; refusing here says it sooner. */}
      {classroom.archivedAt ? (
        <div className="blankslate blankslate-spacious">
          <h3 className="mb-2">Este classroom está archivado</h3>
          <p className="color-fg-muted mb-4">
            No se pueden crear assignments en un classroom archivado.
          </p>
          <Link href={`/classrooms/${classroom.slug}`} className="btn" role="button">
            Volver al classroom
          </Link>
        </div>
      ) : (
        <NewAssignmentForm classroomSlug={classroom.slug} templates={templates} />
      )}
    </>
  )
}
