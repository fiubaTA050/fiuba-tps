import { OrganizationIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { InvitationShell } from '@/components/InvitationShell'
import { SetupProgress } from '@/components/SetupProgress'
import { findGroupInvitation } from '@/lib/data/group-invitations'
import { claimPendingTeamInvitation, findTeamRepository } from '@/lib/data/repositories'
import { findInstallationAccount } from '@/lib/github/organizations'
import { isUsableSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Port of GroupAssignmentInvitationsController#setup, with the
 * `ensure_github_repo_exists` before_action folded into
 * `claimPendingTeamInvitation`.
 *
 * This is also where every member except the first one gets their access: the
 * repository belongs to the team, so a student who joined after it was built
 * has nothing to create, only their own collaborator invitation to accept —
 * and this page is where their browser, holding their token, passes through.
 */
export default async function GroupAssignmentSetupPage(
  props: PageProps<'/group-assignment-invitations/[key]/setup'>,
) {
  const { key } = await props.params

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/group-assignment-invitations/${key}`)

  const invitation = await findGroupInvitation(session, key)
  if (!invitation) notFound()

  // route_based_on_status: no team, or a team that never accepted
  if (!invitation.team) redirect(`/group-assignment-invitations/${key}`)
  if (invitation.status === 'unaccepted') {
    redirect(`/group-assignment-invitations/${key}/accept`)
  }

  const [organization, repository] = await Promise.all([
    findInstallationAccount(invitation.classroom.installationId),
    findTeamRepository(session, key),
  ])

  if (repository) await claimPendingTeamInvitation(session, key)

  return (
    <InvitationShell classroomTitle={invitation.classroom.title} organization={organization}>
      <div className="d-flex flex-items-center mb-2">
        <OrganizationIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal">
          Aceptaste el trabajo práctico <strong>{invitation.assignmentTitle}</strong>
        </h2>
      </div>

      <p className="color-fg-muted">
        Estás en el equipo <strong>{invitation.team.title}</strong>.
        {invitation.rosterEntry ? (
          <>
            {' '}
            Figurás en la lista de alumnos como{' '}
            <strong className="text-mono">{invitation.rosterEntry.identifier}</strong>.
          </>
        ) : invitation.roster ? (
          <>
            {' '}
            Tu cuenta no está vinculada a ningún {invitation.roster.identifierName.toLowerCase()}{' '}
            de la lista. <a href={`/group-assignment-invitations/${key}`}>Vinculala ahora</a>
          </>
        ) : null}
      </p>

      <SetupProgress
        basePath={`/group-assignment-invitations/${key}`}
        initialStatus={invitation.status}
        initialRepoUrl={repository?.htmlUrl ?? null}
        repoName={`${invitation.assignmentSlug}-${invitation.team.slug}`}
        teamName={invitation.team.title}
      />
    </InvitationShell>
  )
}
