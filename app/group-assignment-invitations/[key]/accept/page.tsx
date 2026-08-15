import { OrganizationIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { InvitationShell } from '@/components/InvitationShell'
import { findGroupInvitation } from '@/lib/data/group-invitations'
import { findInstallationAccount } from '@/lib/github/organizations'
import { isUsableSession } from '@/lib/session'

import { AcceptTeamForm } from './AcceptTeamForm'

export const dynamic = 'force-dynamic'

/**
 * Port of GroupAssignmentInvitationsController#accept and
 * `group_assignment_invitations/accept.html.erb`.
 *
 * The screen a student sees once they are on a team but the team has not
 * accepted yet — reached by picking a team, and by coming back to the link
 * later. `check_group_exists` sends anybody without a team back to the picker.
 */
export default async function AcceptGroupAssignmentPage(
  props: PageProps<'/group-assignment-invitations/[key]/accept'>,
) {
  const { key } = await props.params

  const session = await auth()
  if (!isUsableSession(session)) redirect(`/group-assignment-invitations/${key}`)

  const invitation = await findGroupInvitation(session, key)
  if (!invitation) notFound()

  // check_group_exists
  if (!invitation.team) redirect(`/group-assignment-invitations/${key}`)

  // route_based_on_status: the team is already on its way to a repository
  if (invitation.status !== 'unaccepted') {
    redirect(`/group-assignment-invitations/${key}/setup`)
  }

  const organization = await findInstallationAccount(invitation.classroom.installationId)

  return (
    <InvitationShell classroomTitle={invitation.classroom.title} organization={organization}>
      <div className="d-flex flex-items-center mb-2">
        <OrganizationIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal">
          Aceptar el assignment <strong>{invitation.assignmentTitle}</strong>
        </h2>
      </div>

      <div className="Box my-4">
        <div className="Box-row">
          <p className="mb-0">
            Aceptar este assignment le va a dar a tu equipo (<strong>{invitation.team.title}</strong>
            ) acceso al repositorio{' '}
            <strong className="text-mono">
              {invitation.assignmentSlug}-{invitation.team.slug}
            </strong>{' '}
            en la organización{' '}
            {organization ? (
              <a href={`https://github.com/${organization.login}`}>@{organization.login}</a>
            ) : (
              'de la cátedra'
            )}{' '}
            en GitHub.
          </p>
        </div>
      </div>

      {invitation.enabled ? (
        <AcceptTeamForm invitationKey={key} />
      ) : (
        <div className="flash flash-warn">{invitation.disabledReason}</div>
      )}
    </InvitationShell>
  )
}
