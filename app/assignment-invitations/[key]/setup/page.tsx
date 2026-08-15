import { PersonIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { InvitationShell } from '@/components/InvitationShell'
import { findInvitation } from '@/lib/data/invitations'
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
 * **The stage this renders does not run yet.** Repository creation is out of
 * scope for this change: nothing enqueues a job, so a student who accepts sits
 * on "En espera". The screen is here, with its polling, so that the job only
 * has to move `invite_statuses.status` for it to come alive.
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

  const organization = await findInstallationAccount(invitation.classroom.installationId)

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

      {/* "Your assignment repository is being set up. This might take a while." */}
      <h3 className="f3 text-normal mt-4 mb-3">
        Tu repositorio se está preparando. Esto puede demorar.
      </h3>

      <SetupProgress
        invitationKey={key}
        initialStatus={invitation.status}
        repoName={`${invitation.assignmentSlug}-${session.user.githubLogin}`}
      />
    </InvitationShell>
  )
}
