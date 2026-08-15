import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { Breadcrumb } from '@/components/Breadcrumb'
import { listGroupings } from '@/lib/data/group-assignments'
import { findClassroom } from '@/lib/data/organizations'
import { listTemplateRepositories } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'

import { NewGroupAssignmentForm } from './NewGroupAssignmentForm'

export const dynamic = 'force-dynamic'

/**
 * Port of group_assignments#new. The same frame as the individual one: only the
 * breadcrumb, no title band and no tabs.
 */
export default async function NewGroupAssignmentPage(
  props: PageProps<'/classrooms/[slug]/group-assignments/new'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params

  const [classroom, groupings] = await Promise.all([
    findClassroom(session, slug),
    listGroupings(session, slug),
  ])

  if (!classroom) notFound()

  const templates =
    classroom.organization && !classroom.archivedAt
      ? await listTemplateRepositories(
          classroom.organization.installationId,
          classroom.organization.login,
        )
      : []

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
          {
            label: 'Nuevo assignment grupal',
            href: `/classrooms/${classroom.slug}/group-assignments/new`,
          },
        ]}
      />

      <div className="container-md p-responsive mt-6">
        <h1 className="f2 mb-5">Configurá el assignment grupal.</h1>

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
          <NewGroupAssignmentForm
            classroomSlug={classroom.slug}
            templates={templates}
            groupings={groupings}
            suggestedGroupingTitle={suggestedGroupingTitle()}
          />
        )}
      </div>
    </>
  )
}

/** `Time.zone.now.strftime("Teams formed on %B #{time.day.ordinalize}, %Y")` */
function suggestedGroupingTitle(): string {
  const formatted = new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date())

  return `Equipos formados el ${formatted}`
}
