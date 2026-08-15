import { DownloadIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { findClassroom } from '@/lib/data/organizations'
import { findRoster } from '@/lib/data/rosters'
import { isUsableSession } from '@/lib/session'

import { AddStudentsDialog } from './AddStudentsDialog'
import { DeleteRosterForm } from './DeleteRosterForm'
import { RosterEntryRow } from './RosterEntryRow'

export const dynamic = 'force-dynamic'

/**
 * Port of rosters#show, laid out like the live classroom.github.com: one Box
 * titled "Classroom Roster" with the two actions in its header, the students
 * under a tabnav, and the danger zone in its own bordered Box.
 *
 * Two things of the live page are missing. The pagination, because a cátedra
 * roster is a few hundred rows and paginating costs the teacher their
 * browser's find-in-page. And the "Unlinked GitHub accounts" tab: those
 * students exist now — they skipped `join_roster` — but they are unlinked
 * *per assignment*, so the assignment page is where the teacher sees them,
 * next to who accepted. See AcceptanceList.
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

      <section>
        <div className="Box">
          <div className="Box-header d-flex flex-justify-between flex-column flex-sm-row">
            <h2 className="Box-title d-flex flex-items-center mb-2 mb-sm-0">
              Roster del classroom
            </h2>

            <div className="d-flex flex-column flex-sm-row">
              <AddStudentsDialog
                classroomSlug={classroom.slug}
                identifierName={roster.identifierName}
              />
              {/* download_roster: a plain link, so the browser saves the file
                  instead of the action having to hand the bytes back */}
              <a
                href={`/classrooms/${classroom.slug}/roster/csv`}
                className="btn btn-sm btn-primary ml-sm-2 d-inline-flex flex-items-center flex-justify-center"
                role="button"
              >
                <DownloadIcon className="mr-1" />
                Descargar
              </a>
            </div>
          </div>

          <div className="Box-body">
            <div className="tabnav">
              <ul className="tabnav-tabs list-style-none">
                {/* One tab, and not a real tablist: the second one arrives with
                    the linking flow. It carries the count, which is where the
                    live page puts it */}
                <li className="d-inline-flex">
                  <span className="tabnav-tab selected">
                    Todos los alumnos
                    <span title={String(roster.entries.length)} className="Counter ml-2">
                      {roster.entries.length}
                    </span>
                  </span>
                </li>
              </ul>
            </div>

            <div className="px-2">
              {roster.entries.map((entry) => (
                <RosterEntryRow key={entry.id} entry={entry} classroomSlug={classroom.slug} />
              ))}
            </div>
          </div>
        </div>

        <div className="Box color-border-danger-emphasis mt-3">
          <div className="Box-header color-border-danger-emphasis color-fg-danger">
            <h2 className="Box-title">Zona de peligro</h2>
          </div>
          <div className="Box-body color-border-danger-emphasis">
            <p>Al eliminar el roster se borran todos los alumnos.</p>
            <p>No se borran los assignments, ni los repos, ni las entregas.</p>
            <p>
              Después de eliminarlo, los repos y las entregas se identifican por usuario de
              GitHub en vez de por {roster.identifierName.toLowerCase()}.
            </p>
            <DeleteRosterForm classroomSlug={classroom.slug} />
          </div>
        </div>
      </section>
    </ClassroomShell>
  )
}
