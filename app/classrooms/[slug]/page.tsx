import { PersonIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomHeader } from '@/components/ClassroomHeader'
import { InvitationLink } from '@/components/InvitationLink'
import { listAssignments } from '@/lib/data/assignments'
import { findClassroom } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'
import { baseUrl } from '@/lib/url'

export const dynamic = 'force-dynamic'

/** Port of organizations#show and its assignments/_assignment.html.erb partial */
export default async function ClassroomPage(props: PageProps<'/classrooms/[slug]'>) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params

  const [classroom, assignments] = await Promise.all([
    findClassroom(session, slug),
    listAssignments(session, slug),
  ])

  if (!classroom) notFound()

  // flash[:success]: only right after creating, not on every later visit
  const justCreated = (await props.searchParams).created === '1'

  const origin = await baseUrl()
  const newAssignmentPath = `/classrooms/${classroom.slug}/assignments/new`

  return (
    <>
      <ClassroomHeader classroom={classroom} linked={false} />

      {justCreated && (
        <div className="flash flash-success mb-4">
          Classroom creado. El permiso de repositorio por defecto de la organización quedó en
          <strong> none</strong>, así los alumnos no ven los repos de sus compañeros.
        </div>
      )}

      <div className="d-md-flex flex-items-center flex-justify-between mb-3">
        <h2 className="f2 text-normal">Assignments</h2>
        {assignments.length > 0 && (
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

      {assignments.length === 0 ? (
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
          {assignments.map((assignment) => (
            <article
              key={assignment.id}
              className="Box-row d-md-flex flex-items-center flex-justify-between"
            >
              <div className="col-md-7 d-flex flex-items-center mb-3 mb-md-0">
                <PersonIcon size={22} className="mr-3 color-fg-muted flex-shrink-0" />
                <div>
                  <h3 className="f3 text-normal lh-condensed">
                    <Link
                      href={`/classrooms/${classroom.slug}/assignments/${assignment.slug}`}
                    >
                      {assignment.title}
                    </Link>
                  </h3>
                  <p className="color-fg-muted mb-0">
                    Assignment individual · {assignment.publicRepo ? 'público' : 'privado'}
                  </p>
                </div>
              </div>

              <div className="col-md-4">
                <InvitationLink
                  url={`${origin}/assignment-invitations/${assignment.invitationKey}`}
                  disabled={!assignment.invitationsEnabled || Boolean(classroom.archivedAt)}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  )
}
