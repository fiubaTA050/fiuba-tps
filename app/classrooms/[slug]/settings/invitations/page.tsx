import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { findClassroom } from '@/lib/data/organizations'
import { type StaffMember, listClassroomStaff } from '@/lib/data/teaching-assistants'
import { isUsableSession } from '@/lib/session'

import { AddTeachingAssistantForm } from './AddTeachingAssistantForm'
import { RemoveTeachingAssistantButton } from './RemoveTeachingAssistantButton'

export const dynamic = 'force-dynamic'

/**
 * The "TAs and Admins" tab of the live site, `organizations#invitation` in the
 * original, at its path. Its layout is the live one — a mono label in a
 * `col-md-3` next to a `Box col-md-9`, one pair per section.
 *
 * Deliberate divergence, see docs/teaching-assistants.md: the live site has
 * one list, of org owners, with Remove; here the teachers are still the org
 * owners, read-only because they are managed on github.com (and the original's
 * Remove never stuck — the index linked them back on their next visit), and
 * the teaching assistants are a second list this page manages.
 */
export default async function StaffPage(
  props: PageProps<'/classrooms/[slug]/settings/invitations'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params

  const [classroom, staff] = await Promise.all([
    findClassroom(session, slug),
    listClassroomStaff(session, slug),
  ])

  if (!classroom || !staff) notFound()

  const orgLogin = classroom.organization?.login

  return (
    <ClassroomShell session={session} classroom={classroom} tab="staff">
      <div className="d-md-flex gutter-md">
        <h2 className="col-md-3 f5 text-mono text-normal color-fg-muted px-md-5 py-3">
          Profesores
        </h2>
        <div className="Box col-md-9 color-bg-accent">
          <ul aria-label="Profesores" className="list-style-none pl-0 m-0">
            {staff.teachers.map((teacher) => (
              <li key={teacher.userId} className="Box-row">
                <Member member={teacher} />
              </li>
            ))}
          </ul>
          <div className="Box-row color-fg-muted">
            <p className="note my-0">
              Los profesores son los owners de la organización
              {orgLogin ? (
                <>
                  {' '}
                  <strong>{orgLogin}</strong> en GitHub. Para sumar uno, hacelo owner desde{' '}
                  <a href={`https://github.com/orgs/${orgLogin}/people`}>
                    github.com/orgs/{orgLogin}/people
                  </a>
                </>
              ) : (
                ' en GitHub. Para sumar uno, hacelo owner desde la organización'
              )}
              : entra solo la próxima vez que abra el classroom.
            </p>
          </div>
        </div>
      </div>

      <div className="d-md-flex gutter-md mt-5">
        <h2 className="col-md-3 f5 text-mono text-normal color-fg-muted px-md-5 py-3">
          Ayudantes
        </h2>
        <div className="Box col-md-9">
          {staff.assistants.length === 0 ? (
            <div className="Box-row color-fg-muted">Este classroom no tiene ayudantes.</div>
          ) : (
            <ul aria-label="Ayudantes" className="list-style-none pl-0 m-0">
              {staff.assistants.map((assistant) => (
                <li key={assistant.id} className="Box-row">
                  <article className="d-flex flex-justify-between flex-items-center">
                    <div className="d-flex flex-items-center">
                      <Member member={assistant} />
                      {assistant.alsoTeacher && (
                        <span
                          className="Label ml-2"
                          title="Es owner de la organización: entra como profesor"
                        >
                          También es profesor
                        </span>
                      )}
                    </div>
                    <RemoveTeachingAssistantButton
                      classroomSlug={classroom.slug}
                      teachingAssistantId={assistant.id}
                      login={assistant.githubLogin ?? ''}
                    />
                  </article>
                </li>
              ))}
            </ul>
          )}
          <div className="Box-row color-fg-muted">
            <p className="note my-0">
              Un ayudante ve los trabajos prácticos y, en cada uno, solo los alumnos o equipos que
              tiene asignados, y puede escribirles la devolución. No necesita ser miembro de la
              organización.
            </p>
          </div>
        </div>
      </div>

      <div className="d-md-flex gutter-md mt-5">
        <h2 className="col-md-3 f5 text-mono text-normal color-fg-muted px-md-5 py-3">
          Agregar ayudante
        </h2>
        <div className="Box col-md-9">
          <div className="Box-row">
            {classroom.archivedAt ? (
              <p className="color-fg-muted mb-0">
                El classroom está archivado: no se pueden agregar ayudantes.
              </p>
            ) : (
              <AddTeachingAssistantForm classroomSlug={classroom.slug} />
            )}
          </div>
        </div>
      </div>
    </ClassroomShell>
  )
}

/** Avatar and login, the live row's `avatar circle` + bold link */
function Member({ member }: { member: StaffMember }) {
  if (!member.githubLogin) return <span className="color-fg-muted">Cuenta sin login</span>

  return (
    <span className="d-inline-flex flex-items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://github.com/${member.githubLogin}.png?size=64`}
        className="avatar circle"
        height={32}
        width={32}
        alt=""
      />
      <a href={`https://github.com/${member.githubLogin}`} className="text-bold ml-2">
        {member.githubLogin}
      </a>
    </span>
  )
}
