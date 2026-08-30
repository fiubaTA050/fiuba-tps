import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { Breadcrumb } from '@/components/Breadcrumb'
import { findClassroom } from '@/lib/data/organizations'
import { listTemplateRepositories } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'

import { NewAssignmentForm } from './NewAssignmentForm'

export const dynamic = 'force-dynamic'

/**
 * Port of assignments#new, reached through the chooser of
 * organizations#new_assignment — see ../../new-assignment.
 *
 * The frame is the live site's: breadcrumb down to "Nuevo trabajo práctico" and
 * nothing else — no title band and no tabs, because this screen is not one of
 * them, it is a step away from the classroom. Its `container-xl p-responsive
 * mt-6`, the `h1.f2.mb-5` and the form inside a `Box` are copied from a saved
 * copy of that page. What is left out is the "Assignment creation steps"
 * sidebar: the live form is a three-step wizard, and this one is a single
 * form — everything it asks for fits on one screen.
 */
export default async function NewAssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/new'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await props.params
  const classroom = await findClassroom(session, slug)
  if (!classroom) notFound()

  // The org's own templates, to offer without making the teacher type. An
  // unreachable org means no list — the free-text field still works, and the
  // server revalidates whatever arrives either way.
  const templates =
    classroom.organization && !classroom.archivedAt
      ? await listTemplateRepositories(
          classroom.organization.installationId,
          classroom.organization.login,
        )
      : []

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
          { label: 'Nuevo trabajo práctico', href: `/classrooms/${classroom.slug}/assignments/new` },
        ]}
      />

      {/* The live page is `container-xl`, but its width is spent on the
          "Assignment creation steps" sidebar; with no sidebar to fill the left
          third, the same class would stretch the inputs across 1280px */}
      <div className="container-md p-responsive mt-6">
        <h1 className="f2 mb-5">Configurá el trabajo práctico.</h1>

        {/* validate :organization_is_not_archived. The original let you open
            the form and only failed on submit; refusing here says it sooner. */}
        {classroom.archivedAt ? (
          <div className="blankslate blankslate-spacious">
            <h3 className="mb-2">Este classroom está archivado</h3>
            <p className="color-fg-muted mb-4">
              No se pueden crear trabajos prácticos en un classroom archivado.
            </p>
            <Link href={`/classrooms/${classroom.slug}`} className="btn" role="button">
              Volver al classroom
            </Link>
          </div>
        ) : (
          <NewAssignmentForm classroomSlug={classroom.slug} templates={templates} />
        )}
      </div>
    </>
  )
}
