import { PeopleIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { findGroupingForTeacher } from '@/lib/data/groups'
import { findClassroom } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'

import { MemberRow } from './MemberRow'

export const dynamic = 'force-dynamic'

/**
 * Port of groupings#show, the screen the original never finished.
 *
 * There it lives behind the `team_management` Flipper feature, its "Manage"
 * button is an `href="#"`, and the drag and drop that the copy advertises never
 * reaches the server. Here it is the only way to fix a student who picked the
 * wrong team, so it works — see `moveMember` in lib/data/groups.ts for what a
 * move costs on GitHub.
 */
export default async function GroupingPage(
  props: PageProps<'/classrooms/[slug]/groupings/[groupingSlug]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, groupingSlug } = await props.params

  const [classroom, grouping] = await Promise.all([
    findClassroom(session, slug),
    findGroupingForTeacher(session, slug, groupingSlug),
  ])

  if (!classroom || !grouping) notFound()

  const students = grouping.teams.reduce((total, team) => total + team.members.length, 0)

  return (
    <ClassroomShell session={session} classroom={classroom} tab="assignments">
      <div className="d-flex flex-items-center mb-2">
        <PeopleIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal flex-auto">{grouping.title}</h2>
      </div>

      <p className="color-fg-muted">
        {grouping.teams.length} {grouping.teams.length === 1 ? 'equipo' : 'equipos'} · {students}{' '}
        {students === 1 ? 'alumno' : 'alumnos'} · los arman los alumnos desde el link del
        assignment
      </p>

      {grouping.teams.length === 0 ? (
        <div className="blankslate blankslate-spacious mt-4">
          <h3 className="mb-2">Este conjunto no tiene equipos</h3>
          <p className="color-fg-muted mb-0">
            Compartí el link del assignment grupal y los equipos van a aparecer acá.
          </p>
        </div>
      ) : (
        grouping.teams.map((team) => (
          <div className="Box mt-4" key={team.id}>
            <div className="Box-header d-flex flex-items-center flex-justify-between">
              <h3 className="Box-title">{team.title}</h3>
              <span className="f6 color-fg-muted text-mono">{team.slug}</span>
            </div>

            {team.members.length === 0 ? (
              <div className="Box-row color-fg-muted">
                Sin integrantes. Los repos que ya tenga siguen existiendo.
              </div>
            ) : (
              team.members.map((member) => (
                <MemberRow
                  key={member.userId}
                  classroomSlug={classroom.slug}
                  groupingSlug={grouping.slug}
                  member={member}
                  currentTeamId={team.id}
                  teams={grouping.teams}
                />
              ))
            )}
          </div>
        ))
      )}
    </ClassroomShell>
  )
}
