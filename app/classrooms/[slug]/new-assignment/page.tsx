import { OrganizationIcon, PersonIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { Breadcrumb } from '@/components/Breadcrumb'
import { findClassroom } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Port of organizations#new_assignment: the screen that asks which kind of
 * assignment before showing either form.
 *
 * A click that could be saved by putting two buttons on the classroom page,
 * and the original spends it on purpose — the two rows carry the descriptions
 * that say what the difference *is*, which is what a teacher who has not run a
 * group assignment before needs to read.
 *
 * The frame is the breadcrumb alone, like the two forms it leads to: this is a
 * step away from the classroom, not one of its tabs.
 */
export default async function NewAssignmentChooserPage(
  props: PageProps<'/classrooms/[slug]/new-assignment'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params
  const classroom = await findClassroom(session, slug)
  if (!classroom) notFound()

  // validate :organization_is_not_archived, said before either form is opened
  if (classroom.archivedAt) {
    return (
      <>
        <Chrome classroom={classroom} />
        <div className="container-md p-responsive mt-6">
          <div className="blankslate blankslate-spacious">
            <h3 className="mb-2">Este classroom está archivado</h3>
            <p className="color-fg-muted mb-4">
              No se pueden crear assignments en un classroom archivado.
            </p>
            <Link href={`/classrooms/${classroom.slug}`} className="btn" role="button">
              Volver al classroom
            </Link>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Chrome classroom={classroom} />

      <div className="container-md p-responsive mt-6">
        <h1 className="f2 text-normal mb-3">Nuevo assignment</h1>

        <div className="Box">
          <Option
            icon={<PersonIcon size={22} />}
            title="Assignment individual"
            description="Cada alumno trabaja por su cuenta en su propio repositorio."
            href={`/classrooms/${classroom.slug}/assignments/new`}
            action="Crear un assignment individual"
          />

          <Option
            icon={<OrganizationIcon size={22} />}
            title="Assignment grupal"
            description="Los alumnos arman equipos y cada equipo trabaja en un repositorio compartido."
            href={`/classrooms/${classroom.slug}/group-assignments/new`}
            action="Crear un assignment grupal"
          />
        </div>
      </div>
    </>
  )
}

/** One `Box-row` of the original, whose whole row is a link plus a button */
function Option({
  icon,
  title,
  description,
  href,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  href: string
  action: string
}) {
  return (
    <div className="Box-row d-md-flex flex-justify-between flex-items-center">
      <div className="d-flex">
        <span className="mr-3 color-fg-muted">{icon}</span>
        <div>
          <h2 className="h3">
            <Link href={href}>{title}</Link>
          </h2>
          <p className="color-fg-muted mb-0">{description}</p>
        </div>
      </div>
      <div className="mt-3 mt-md-0">
        <Link href={href} className="btn btn-primary" role="button">
          {action}
        </Link>
      </div>
    </div>
  )
}

function Chrome({ classroom }: { classroom: { title: string; slug: string } }) {
  return (
    <Breadcrumb
      items={[
        { label: 'Classrooms', href: '/classrooms' },
        { label: classroom.title, href: `/classrooms/${classroom.slug}` },
        { label: 'Nuevo assignment', href: `/classrooms/${classroom.slug}/new-assignment` },
      ]}
    />
  )
}
