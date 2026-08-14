import { AlertIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { listClassrooms } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** Port of organizations#index + _organization.html.erb */
export default async function ClassroomsPage() {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classrooms = await listClassrooms(session)

  if (classrooms.length === 0) {
    return (
      <div className="blankslate blankslate-large blankslate-spacious">
        <h3 className="mb-2">Todavía no tenés classrooms</h3>
        <p className="color-fg-muted mb-4">
          Un classroom es una organización de GitHub donde viven los repos de la materia.
        </p>
        <Link href="/classrooms/new" className="btn btn-primary btn-large" role="button">
          Crear tu primer classroom
        </Link>
      </div>
    )
  }

  return (
    <>
      <div className="Subhead Subhead--spacious">
        <h2 className="Subhead-heading">Tus classrooms</h2>
        <div className="Subhead-actions">
          <Link href="/classrooms/new" className="btn btn-primary" role="button">
            Nuevo classroom
          </Link>
        </div>
      </div>

      <div className="Box">
        {classrooms.map((classroom) => (
          <article
            key={classroom.id}
            className="Box-row d-sm-flex flex-items-center flex-justify-between"
          >
            <div className="d-flex flex-items-center mb-3 mb-sm-0">
              <div className="mr-3">
                {classroom.organization ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={classroom.organization.avatarUrl}
                    className="avatar"
                    height={60}
                    width={60}
                    alt={`@${classroom.organization.login}`}
                  />
                ) : (
                  <span className="color-fg-attention">
                    <AlertIcon size={32} />
                  </span>
                )}
              </div>

              <div className="overflow-hidden d-flex flex-column">
                <h1 className="h2">
                  <Link href={`/classrooms/${classroom.slug}`} className="d-block">
                    {classroom.title}
                  </Link>
                </h1>
                {/* DA-2: the org login comes from GitHub, it is not stored */}
                <p className="f4 color-fg-muted mb-0">
                  {classroom.organization ? (
                    `@${classroom.organization.login}`
                  ) : (
                    <span className="color-fg-attention">Organización inaccesible</span>
                  )}
                </p>
              </div>
            </div>

            {classroom.archivedAt && <span className="Label Label--gray">Archivado</span>}
          </article>
        ))}
      </div>
    </>
  )
}
