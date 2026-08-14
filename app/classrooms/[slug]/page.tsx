import { AlertIcon, RepoIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { findClassroom } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Trimmed-down port of organizations#show.
 *
 * The creation flow ends here. The assignments listing waits until
 * AssignmentsController is ported — a blankslate for now.
 */
export default async function ClassroomPage(props: PageProps<'/classrooms/[slug]'>) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params
  const classroom = await findClassroom(session, slug)
  if (!classroom) notFound()

  // flash[:success]: only right after creating, not on every later visit
  const justCreated = (await props.searchParams).created === '1'

  return (
    <>
      <div className="Subhead Subhead--spacious">
        <div className="d-flex flex-items-center">
          {classroom.organization ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={classroom.organization.avatarUrl}
              className="avatar mr-3"
              height={48}
              width={48}
              alt={`@${classroom.organization.login}`}
            />
          ) : (
            <span className="color-fg-attention mr-3">
              <AlertIcon size={32} />
            </span>
          )}
          <div>
            <h1 className="Subhead-heading">{classroom.title}</h1>
            <p className="color-fg-muted mb-0">
              {classroom.organization ? (
                <a href={`https://github.com/${classroom.organization.login}`}>
                  @{classroom.organization.login}
                </a>
              ) : (
                'Organización inaccesible'
              )}
            </p>
          </div>
        </div>
      </div>

      {justCreated && (
        <div className="flash flash-success mb-4">
          Classroom creado. El permiso de repositorio por defecto de la organización quedó en
          <strong> none</strong>, así los alumnos no ven los repos de sus compañeros.
        </div>
      )}

      <div className="blankslate blankslate-spacious">
        <RepoIcon size={24} className="color-fg-muted mb-2" />
        <h3 className="mb-2">Todavía no hay assignments</h3>
        <p className="color-fg-muted mb-0">
          Crear assignments a partir de un repo template es el próximo paso del port.
        </p>
      </div>
    </>
  )
}
