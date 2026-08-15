import { LockIcon, PersonIcon, RepoIcon, ShieldLockIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomHeader } from '@/components/ClassroomHeader'
import { InvitationLink } from '@/components/InvitationLink'
import { findAssignment } from '@/lib/data/assignments'
import { findClassroom } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'
import { baseUrl } from '@/lib/url'

export const dynamic = 'force-dynamic'

/**
 * Trimmed-down port of assignments#show.
 *
 * What the original showed below the invitation was the roster, or the list of
 * `assignment_repos` when the classroom has none. Both wait for the invitation
 * to be redeemable, so this page stops at the invitation link and a blankslate.
 */
export default async function AssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/[assignmentSlug]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  const [classroom, assignment] = await Promise.all([
    findClassroom(session, slug),
    findAssignment(session, slug, assignmentSlug),
  ])

  if (!classroom || !assignment) notFound()

  // flash[:success]: only right after creating, not on every later visit
  const justCreated = (await props.searchParams).created === '1'

  // InvitationHelper#invitation_url, without the short_key branch
  const invitationUrl = `${await baseUrl()}/assignment-invitations/${assignment.invitationKey}`

  // AssignmentInvitation#enabled?
  const invitationsEnabled = assignment.invitationsEnabled && !classroom.archivedAt

  return (
    <>
      <ClassroomHeader classroom={classroom} />

      {justCreated && (
        <div className="flash flash-success mb-4">
          Assignment creado. Compartí el link de invitación con los alumnos.
        </div>
      )}

      <div className="d-flex flex-items-center mb-2">
        <PersonIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal flex-auto">{assignment.title}</h2>
      </div>

      <p className="color-fg-muted">
        Assignment individual · los repos se van a llamar{' '}
        <code>{assignment.slug}-usuario</code>
      </p>

      <div className="Box my-4">
        <div className="Box-row">
          <h3 className="h5 mb-2">Link de invitación</h3>
          <InvitationLink url={invitationUrl} disabled={!invitationsEnabled} />
          <p className="note mt-2 mb-0">
            {invitationsEnabled ? (
              <>Compartilo con los alumnos para que acepten el assignment.</>
            ) : (
              // The two reasons of AssignmentInvitation#reason_for_disabled_invitations
              <span className="color-fg-attention">
                {classroom.archivedAt
                  ? 'El link está deshabilitado porque el classroom está archivado.'
                  : 'El link está deshabilitado: este assignment no acepta invitaciones.'}
              </span>
            )}
          </p>
        </div>

        <div className="Box-row d-flex flex-items-center">
          {assignment.publicRepo ? (
            <RepoIcon className="mr-2 color-fg-muted" />
          ) : (
            <LockIcon className="mr-2 color-fg-attention" />
          )}
          <span>
            Repositorios <strong>{assignment.publicRepo ? 'públicos' : 'privados'}</strong>
          </span>
        </div>

        <div className="Box-row d-flex flex-items-center">
          <ShieldLockIcon className="mr-2 color-fg-muted" />
          <span>
            Los alumnos{' '}
            <strong>{assignment.studentsAreRepoAdmins ? 'son' : 'no son'}</strong> admin de su
            repo
          </span>
        </div>
      </div>

      <div className="blankslate blankslate-spacious">
        <h3 className="mb-2">Todavía nadie aceptó &quot;{assignment.title}&quot;</h3>
        <p className="color-fg-muted mb-0">
          Aceptar la invitación y crear el repo de cada alumno es el próximo paso del port; por
          ahora el link no lleva a ninguna página.
        </p>
      </div>
    </>
  )
}
