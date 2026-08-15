import { FileCodeIcon, LockIcon, PersonIcon, RepoIcon, ShieldLockIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { InvitationLink } from '@/components/InvitationLink'
import { findAssignment } from '@/lib/data/assignments'
import { listAssignmentAcceptances } from '@/lib/data/invitations'
import { findClassroom } from '@/lib/data/organizations'
import { findRepositoryById } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'
import { baseUrl } from '@/lib/url'

import { AcceptanceList } from './AcceptanceList'

export const dynamic = 'force-dynamic'

/**
 * Port of assignments#show: the invitation link, the assignment's settings,
 * and below them who accepted and who is missing.
 *
 * The original keyed that list off `assignment_repos`; here it comes from
 * `invite_statuses`, which is where an acceptance lands before any repository
 * exists. See lib/data/invitations.ts.
 */
export default async function AssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/[assignmentSlug]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  const [classroom, assignment, acceptances] = await Promise.all([
    findClassroom(session, slug),
    findAssignment(session, slug, assignmentSlug),
    listAssignmentAcceptances(session, slug, assignmentSlug),
  ])

  if (!classroom || !assignment || !acceptances) notFound()

  // flash[:success]: only right after creating, not on every later visit
  const justCreated = (await props.searchParams).created === '1'

  // InvitationHelper#invitation_url, without the short_key branch
  const invitationUrl = `${await baseUrl()}/assignment-invitations/${assignment.invitationKey}`

  // AssignmentInvitation#enabled?
  const invitationsEnabled = assignment.invitationsEnabled && !classroom.archivedAt

  // DA-2: only the id is stored, the name is read from GitHub at render time.
  // Null when the template was deleted or the App lost access — the
  // NullGitHubRepository case, shown as unreachable rather than hidden.
  const starterCode =
    assignment.starterCodeRepoId !== null && classroom.organization
      ? await findRepositoryById(
          classroom.organization.installationId,
          assignment.starterCodeRepoId,
        )
      : null

  return (
    <ClassroomShell session={session} classroom={classroom} tab="assignments">
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
            <FileCodeIcon className="mr-2 color-fg-muted" />
            <span>
              {assignment.starterCodeRepoId === null ? (
                <>Sin starter code, cada alumno arranca de un repo vacío</>
              ) : starterCode ? (
                <>
                  Starter code:{' '}
                  <a href={starterCode.htmlUrl} className="text-mono">
                    {starterCode.fullName}
                  </a>
                </>
              ) : (
                <span className="color-fg-attention">
                  Starter code inaccesible: el repo se borró o la App perdió acceso
                </span>
              )}
            </span>
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

        <AcceptanceList acceptances={acceptances} assignmentTitle={assignment.title} />
    </ClassroomShell>
  )
}
