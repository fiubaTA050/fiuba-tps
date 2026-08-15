import { PeopleIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { findClassroom } from '@/lib/data/organizations'
import { DEFAULT_IDENTIFIER_NAME, rosterSummary } from '@/lib/data/rosters'
import { isUsableSession } from '@/lib/session'

import { NewRosterForm } from './NewRosterForm'

export const dynamic = 'force-dynamic'

/** Port of rosters#new, with its `redirect_if_roster_exists` before_action */
export default async function NewRosterPage(
  props: PageProps<'/classrooms/[slug]/roster/new'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params

  const [classroom, roster] = await Promise.all([
    findClassroom(session, slug),
    rosterSummary(session, slug),
  ])

  if (!classroom) notFound()
  // redirect_if_roster_exists
  if (roster) redirect(`/classrooms/${slug}/roster`)

  return (
    <ClassroomShell session={session} classroom={classroom} tab="students">
        <div className="Subhead">
          <h2 className="Subhead-heading d-flex flex-items-center">
            <PeopleIcon size={22} className="mr-2" />
            Cargar el roster
          </h2>
        </div>

        <p className="col-md-9 color-fg-muted">
          El roster es la lista de alumnos de la materia. Sirve para saber quién aceptó cada
          assignment y quién falta, y para leer las entregas por padrón en vez de por usuario de
          GitHub. Podés cargarlo ahora o más tarde.
        </p>

        <NewRosterForm classroomSlug={classroom.slug} defaultIdentifierName={DEFAULT_IDENTIFIER_NAME} />
    </ClassroomShell>
  )
}
