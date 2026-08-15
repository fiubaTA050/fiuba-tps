import { DownloadIcon, PeopleIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { findClassroom } from '@/lib/data/organizations'
import { findRoster } from '@/lib/data/rosters'
import { isUsableSession } from '@/lib/session'

import { AddStudentsForm } from './AddStudentsForm'
import { DeleteRosterForm } from './DeleteRosterForm'
import { RosterEntryRow } from './RosterEntryRow'

export const dynamic = 'force-dynamic'

/**
 * Port of rosters#show.
 *
 * The original's two tabs are one list here: "Unlinked GitHub accounts" listed
 * the students who had accepted an assignment without claiming an identifier,
 * and nothing can accept an assignment yet.
 */
export default async function RosterPage(props: PageProps<'/classrooms/[slug]/roster'>) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params

  const [classroom, roster] = await Promise.all([
    findClassroom(session, slug),
    findRoster(session, slug),
  ])

  if (!classroom) notFound()
  // ensure_current_roster
  if (!roster) redirect(`/classrooms/${slug}/roster/new`)

  const justCreated = (await props.searchParams).created === '1'

  return (
    <ClassroomShell session={session} classroom={classroom} tab="students">
        {/* flash[:success] of #create. Without the count: the query parameter
            survives the later revalidations, and a number that keeps growing
            under "Roster creado" reads like a bug */}
        {justCreated && <div className="flash flash-success mb-4">Roster creado.</div>}

        <div className="d-md-flex flex-items-center flex-justify-between mb-3">
          <h2 className="f2 text-normal d-flex flex-items-center">
            <PeopleIcon size={22} className="mr-2 color-fg-muted" />
            Alumnos
          </h2>

          {/* download_roster: a plain link, so the browser saves the file
              instead of the action having to hand the bytes back */}
          <a
            href={`/classrooms/${classroom.slug}/roster/csv`}
            className="btn d-inline-flex flex-items-center"
            role="button"
          >
            <DownloadIcon className="mr-1" />
            Descargar CSV
          </a>
        </div>

        {/* Its own row rather than the header's: the disclosure opens into a
            form, and inside the header flexbox that squeezed it into a column */}
        <div className="col-md-8 mb-3">
          <AddStudentsForm classroomSlug={classroom.slug} identifierName={roster.identifierName} />
        </div>

        <div className="Box mb-4">
          <div className="Box-header d-flex flex-items-center flex-justify-between">
            <h3 className="Box-title">{roster.identifierName}</h3>
            <span className="color-fg-muted">
              {roster.entries.length} {roster.entries.length === 1 ? 'alumno' : 'alumnos'}
            </span>
          </div>

          <ul>
            {roster.entries.map((entry) => (
              <RosterEntryRow key={entry.id} entry={entry} classroomSlug={classroom.slug} />
            ))}
          </ul>
        </div>

        {/* boxed-group dangerzone in the original */}
        <div className="Box Box--danger col-md-8">
          <div className="Box-body">
            <h3 className="Box-title mb-2">Eliminar el roster</h3>
            <p>
              Se borran todos los alumnos de la lista. No se tocan los assignments ni las entregas:
              después de eliminarlo, las entregas se identifican por usuario de GitHub en vez de por{' '}
              {roster.identifierName.toLowerCase()}.
            </p>
            <DeleteRosterForm classroomSlug={classroom.slug} />
          </div>
        </div>
    </ClassroomShell>
  )
}
