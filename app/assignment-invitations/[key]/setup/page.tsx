import { PersonIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { InvitationShell } from '@/components/InvitationShell'
import { findInvitation } from '@/lib/data/invitations'
import { claimPendingInvitation, findStudentRepository } from '@/lib/data/repositories'
import { findInstallationAccount } from '@/lib/github/organizations'
import { isUsableSession } from '@/lib/session'

import { SetupProgress } from './SetupProgress'

export const dynamic = 'force-dynamic'

/**
 * Port of AssignmentInvitationsController#setup and
 * `assignment_invitations/setup.html.erb`.
 *
 * The original showed two stages side by side, "Creating repository" and
 * "Importing starter code". Only the first survives the port: the second
 * belonged to `assignment.use_importer?`, the source-importer path, and GitHub
 * retired the Source Imports API it called. What is left is
 * `create_repository_from_template`, which hands back a repository that
 * already holds the starter code — one stage, see db/schema.ts on
 * `template_repos_enabled`.
 *
 * The work itself is started by `SetupProgress`, which POSTs `create-repo` on
 * mount — the original did the same from the `connected()` callback of its
 * websocket. See docs/creacion-de-repos.md for why it runs in the student's own
 * request instead of a queue.
 */
export default async function AssignmentInvitationSetupPage(
  props: PageProps<'/assignment-invitations/[key]/setup'>,
) {
  const { key } = await props.params

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/assignment-invitations/${key}`)

  const invitation = await findInvitation(session, key)
  if (!invitation) notFound()

  // route_based_on_status: `unaccepted` belongs on #show
  if (invitation.status === 'unaccepted') {
    redirect(`/assignment-invitations/${key}`)
  }

  const [organization, repository] = await Promise.all([
    findInstallationAccount(invitation.classroom.installationId),
    // Already built: a reload, or the student coming back days later. Rendering
    // it server-side means the finished case never flashes "En espera" first.
    findStudentRepository(session, key),
  ])

  // The student's half of add_user_to_github_repository!, for the repository
  // that exists but whose invitation was never accepted — the request that
  // built it died right after the invite. Cheap when there is nothing pending.
  if (repository) await claimPendingInvitation(session, key)

  return (
    <InvitationShell classroomTitle={invitation.classroom.title} organization={organization}>
      <div className="d-flex flex-items-center mb-2">
        <PersonIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal">
          Aceptaste el assignment <strong>{invitation.assignmentTitle}</strong>
        </h2>
      </div>

      {invitation.rosterEntry ? (
        <p className="color-fg-muted">
          Figurás en el roster como{' '}
          <strong className="text-mono">{invitation.rosterEntry.identifier}</strong>.
        </p>
      ) : invitation.roster ? (
        <p className="color-fg-muted">
          Tu cuenta no está vinculada a ningún {invitation.roster.identifierName.toLowerCase()}{' '}
          del roster. <a href={`/assignment-invitations/${key}`}>Vinculala ahora</a>
        </p>
      ) : null}

      <SetupProgress
        invitationKey={key}
        initialStatus={invitation.status}
        initialRepoUrl={repository?.htmlUrl ?? null}
        repoName={`${invitation.assignmentSlug}-${session.user.githubLogin}`}
      />
    </InvitationShell>
  )
}
