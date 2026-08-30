import { DownloadIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { findClassroom } from '@/lib/data/organizations'
import { findRoster, listUnlinkedAccounts, listUnlinkedEntries } from '@/lib/data/rosters'
import { isUsableSession } from '@/lib/session'

import { AddStudentsDialog } from './AddStudentsDialog'
import { DeleteRosterForm } from './DeleteRosterForm'
import { RosterEntryRow } from './RosterEntryRow'
import { RosterTabs } from './RosterTabs'
import { UnlinkedAccountRow } from './UnlinkedAccountRow'

export const dynamic = 'force-dynamic'

/**
 * Port of rosters#show, laid out like the live classroom.github.com: one Box
 * titled "Classroom Roster" with the two actions in its header, the two tabs —
 * the students and the GitHub accounts nobody claimed an identifier with —
 * under a tabnav, and the danger zone in its own bordered Box.
 *
 * Both tabs paginate, as they do on the live site and in the original — 20
 * rows to a page, each tab with its own page number. The whole roster is
 * server-rendered and `RosterTabs` hands out a page of it, so the paging costs
 * no request; what it does cost is the browser's find-in-page over the rows
 * that are not on the page.
 */
export default async function RosterPage(props: PageProps<'/classrooms/[slug]/roster'>) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params

  const [classroom, roster, accounts, unlinkedEntries] = await Promise.all([
    findClassroom(session, slug),
    findRoster(session, slug),
    listUnlinkedAccounts(session, slug),
    listUnlinkedEntries(session, slug),
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
      {justCreated && <div className="flash flash-success mb-4">Lista de alumnos creada.</div>}

      <section>
        <div className="Box">
          <div className="Box-header d-flex flex-justify-between flex-column flex-sm-row">
            <h2 className="Box-title d-flex flex-items-center mb-2 mb-sm-0">
              Lista de alumnos del classroom
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
            <RosterTabs
              studentsCount={roster.entries.length}
              students={roster.entries.map((entry) => (
                <RosterEntryRow
                  key={entry.id}
                  entry={entry}
                  classroomSlug={classroom.slug}
                  unlinkedAccounts={accounts}
                />
              ))}
              accountsCount={accounts.length}
              accounts={accounts.map((account) => (
                <UnlinkedAccountRow
                  key={account.id}
                  account={account}
                  classroomSlug={classroom.slug}
                  identifierName={roster.identifierName}
                  entries={unlinkedEntries}
                />
              ))}
            />
          </div>
        </div>

        <div className="Box color-border-danger-emphasis mt-3">
          <div className="Box-header color-border-danger-emphasis color-fg-danger">
            <h2 className="Box-title">Zona de peligro</h2>
          </div>
          <div className="Box-body color-border-danger-emphasis">
            <p>Al eliminar la lista se borran todos los alumnos.</p>
            <p>No se borran los trabajos prácticos, ni los repos, ni las entregas.</p>
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
