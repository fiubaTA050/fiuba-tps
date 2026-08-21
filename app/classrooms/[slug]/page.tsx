import {
  DotFillIcon,
  PencilIcon,
  PeopleIcon,
  PersonIcon,
  PlusIcon,
  TrashIcon,
} from '@primer/octicons-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { InvitationLink } from '@/components/InvitationLink'
import { listAssignments } from '@/lib/data/assignments'
import { listGroupAssignments } from '@/lib/data/group-assignments'
import { findClassroom } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'
import { baseUrl, invitationUrl } from '@/lib/url'

export const dynamic = 'force-dynamic'

/** One row of the list, whichever kind of assignment it came from */
type Listed = {
  key: string
  title: string
  href: string
  editHref: string
  invitationUrl: string
  invitationsEnabled: boolean
  group: boolean
  /** The set of teams, for a group assignment */
  groupingTitle: string | null
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
  const searchParams = await props.searchParams
  const justCreated = searchParams.created === '1'
  const justDeleted = searchParams.deleted === '1'

  const origin = await baseUrl()
  // organizations#new_assignment: one button, and the chooser asks which kind
  const newAssignmentPath = `/classrooms/${classroom.slug}/new-assignment`

  const listed: Listed[] = [
    ...assignments.map((assignment) => ({
      key: `individual-${assignment.id}`,
      title: assignment.title,
      href: `/classrooms/${classroom.slug}/assignments/${assignment.slug}`,
      editHref: `/classrooms/${classroom.slug}/assignments/${assignment.slug}/edit`,
      invitationUrl: invitationUrl(origin, 'assignment', assignment),
      invitationsEnabled: assignment.invitationsEnabled,
      group: false,
      groupingTitle: null,
    })),
    ...groupAssignments.map((assignment) => ({
      key: `group-${assignment.id}`,
      title: assignment.title,
      href: `/classrooms/${classroom.slug}/group-assignments/${assignment.slug}`,
      editHref: `/classrooms/${classroom.slug}/group-assignments/${assignment.slug}/edit`,
      invitationUrl: invitationUrl(origin, 'group-assignment', assignment),
      invitationsEnabled: assignment.invitationsEnabled,
      group: true,
      groupingTitle: assignment.grouping.title,
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

      {/* flash[:success] = "\"...\" is being deleted", except nothing is queued
          and nothing leaves GitHub — see deleteAssignment */}
      {justDeleted && (
        <div className="flash flash-success mb-4">
          Assignment borrado. Los repositorios de los alumnos siguen en la organización de GitHub.
        </div>
      )}

      {/* `d-flex flex-justify-between` with the h2 and a primary button
          carrying a `plus` leading visual, as the live site has it */}
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
            <PlusIcon className="mr-2" />
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
        // Not a `Box`: the live list is a run of full-width rows separated by
        // `border-top`, with no card around them.
        <div>
          {listed.map((assignment) => (
            <article key={assignment.key} className="border-top color-bg-default py-3 py-md-4">
              {/* The live row wraps this in `gutter-md`, which is a pair: the
                  row pulls itself 16px out on both sides and every `col-*`
                  child pads the same 16px back in. Without the grid columns —
                  the columns here are just two flex items — only the negative
                  half applies and the row overhangs its own `border-top`. */}
              <div className="d-md-flex flex-items-center flex-justify-between">
                <div className="d-flex flex-items-center">
                  <div>
                    <h3 className="f3 text-normal lh-condensed">
                      <Link href={assignment.href}>{assignment.title}</Link>
                    </h3>

                    {/* The live meta line: a `dot-fill` and the status, then the
                        kind of assignment. The archived views had neither —
                        their status was the `toggle_invitations` checkbox. */}
                    <div className="d-flex flex-items-center flex-wrap pt-2">
                      <div className="d-flex flex-items-center pr-4">
                        <DotFillIcon
                          className={`mr-1 ${
                            assignment.invitationsEnabled ? 'color-fg-success' : 'color-fg-muted'
                          }`}
                        />
                        <span>{assignment.invitationsEnabled ? 'Activo' : 'Inactivo'}</span>
                      </div>

                      <p className="color-fg-muted d-flex flex-items-center mb-0">
                        {assignment.group ? (
                          <PeopleIcon className="mr-1" />
                        ) : (
                          <PersonIcon className="mr-1" />
                        )}
                        {assignment.group
                          ? `Assignment grupal de ${assignment.groupingTitle}`
                          : 'Assignment individual'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="d-flex flex-items-center flex-justify-end flex-shrink-0 mt-3 mt-md-0">
                  <InvitationLink
                    variant="button"
                    url={assignment.invitationUrl}
                    disabled={!assignment.invitationsEnabled || Boolean(classroom.archivedAt)}
                  />

                  {/* The live site's two icon-only buttons. Its trash opens a
                      delete modal; here deleting lives in the edit screen's
                      danger zone — see docs/edicion-y-borrado-de-assignments.md
                      — so it links straight to it, and it is red at rest, not
                      only on hover: it is the one action on the row that
                      destroys something. `color-fg-danger` is a utility and
                      wins on `!important`, so it goes only when the link is
                      live — otherwise it would repaint the disabled state. */}
                  <Link
                    href={assignment.editHref}
                    className={`btn-octicon ml-2 ${classroom.archivedAt ? 'disabled' : ''}`}
                    aria-disabled={Boolean(classroom.archivedAt)}
                    aria-label={`Editar ${assignment.title}`}
                  >
                    <PencilIcon />
                  </Link>
                  <Link
                    href={`${assignment.editHref}#borrar`}
                    className={`btn-octicon btn-octicon-danger ${
                      classroom.archivedAt ? 'disabled' : 'color-fg-danger'
                    }`}
                    aria-disabled={Boolean(classroom.archivedAt)}
                    aria-label={`Borrar ${assignment.title}`}
                  >
                    <TrashIcon />
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </ClassroomShell>
  )
}
