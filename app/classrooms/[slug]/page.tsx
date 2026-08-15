import { OrganizationIcon, PersonIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { InvitationLink } from '@/components/InvitationLink'
import { listAssignments } from '@/lib/data/assignments'
import { listGroupAssignments } from '@/lib/data/group-assignments'
import { findClassroom } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'
import { baseUrl } from '@/lib/url'

export const dynamic = 'force-dynamic'

/** One row of the list, whichever kind of assignment it came from */
type Listed = {
  key: string
  title: string
  href: string
  invitationUrl: string
  invitationsEnabled: boolean
  publicRepo: boolean
  group: boolean
  /** The set of teams, for a group assignment */
  subtitle: string
}

/** Port of organizations#show and its assignments/_assignment.html.erb partial */
export default async function ClassroomPage(props: PageProps<'/classrooms/[slug]'>) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params

  const [classroom, assignments, groupAssignments] = await Promise.all([
    findClassroom(session, slug),
    listAssignments(session, slug),
    listGroupAssignments(session, slug),
  ])

  if (!classroom) notFound()

  // flash[:success]: only right after creating, not on every later visit
  const justCreated = (await props.searchParams).created === '1'

  const origin = await baseUrl()
  // organizations#new_assignment: one button, and the chooser asks which kind
  const newAssignmentPath = `/classrooms/${classroom.slug}/new-assignment`

  const listed: Listed[] = [
    ...assignments.map((assignment) => ({
      key: `individual-${assignment.id}`,
      title: assignment.title,
      href: `/classrooms/${classroom.slug}/assignments/${assignment.slug}`,
      invitationUrl: `${origin}/assignment-invitations/${assignment.invitationKey}`,
      invitationsEnabled: assignment.invitationsEnabled,
      publicRepo: assignment.publicRepo,
      group: false,
      subtitle: 'Assignment individual',
    })),
    ...groupAssignments.map((assignment) => ({
      key: `group-${assignment.id}`,
      title: assignment.title,
      href: `/classrooms/${classroom.slug}/group-assignments/${assignment.slug}`,
      invitationUrl: `${origin}/group-assignment-invitations/${assignment.invitationKey}`,
      invitationsEnabled: assignment.invitationsEnabled,
      publicRepo: assignment.publicRepo,
      group: true,
      subtitle: `Assignment grupal · ${assignment.grouping.title}`,
    })),
  ]

  return (
    <ClassroomShell session={session} classroom={classroom} tab="assignments">
      {justCreated && (
        <div className="flash flash-success mb-4">
          Classroom creado. El permiso de repositorio por defecto de la organización quedó en
          <strong> none</strong>, así los alumnos no ven los repos de sus compañeros.
        </div>
      )}

      <div className="d-md-flex flex-items-center flex-justify-between mb-3">
        <h2 className="f2 text-normal">Assignments</h2>
        {listed.length > 0 && (
          // The original disabled the button on an archived classroom instead
          // of hiding it, so the page still reads the same either way.
          <Link
            href={newAssignmentPath}
            className={`btn btn-primary ${classroom.archivedAt ? 'disabled' : ''}`}
            role="button"
            aria-disabled={Boolean(classroom.archivedAt)}
          >
            Nuevo assignment
          </Link>
        )}
      </div>

      {listed.length === 0 ? (
        <div className="blankslate blankslate-spacious">
          <h3 className="mb-2">Todavía no hay assignments</h3>
          {classroom.archivedAt ? (
            <p className="color-fg-muted mb-0">
              Este classroom está archivado, no se pueden crear assignments.
            </p>
          ) : (
            <Link href={newAssignmentPath} className="btn btn-primary btn-large mt-3" role="button">
              Crear el primer assignment
            </Link>
          )}
        </div>
      ) : (
        <div className="Box">
          {listed.map((assignment) => (
            <article
              key={assignment.key}
              className="Box-row d-md-flex flex-items-center flex-justify-between"
            >
              <div className="col-md-7 d-flex flex-items-center mb-3 mb-md-0">
                {/* The original's own distinction: `assignment-icon-group`
                    carries an `organization` octicon, the individual one a
                    `person` */}
                {assignment.group ? (
                  <OrganizationIcon size={22} className="mr-3 color-fg-muted flex-shrink-0" />
                ) : (
                  <PersonIcon size={22} className="mr-3 color-fg-muted flex-shrink-0" />
                )}
                <div>
                  <h3 className="f3 text-normal lh-condensed">
                    <Link href={assignment.href}>{assignment.title}</Link>
                  </h3>
                  <p className="color-fg-muted mb-0">
                    {assignment.subtitle} · {assignment.publicRepo ? 'público' : 'privado'}
                  </p>
                </div>
              </div>

              <div className="col-md-4">
                <InvitationLink
                  url={assignment.invitationUrl}
                  disabled={!assignment.invitationsEnabled || Boolean(classroom.archivedAt)}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </ClassroomShell>
  )
}
