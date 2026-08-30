import { MarkGithubIcon, OrganizationIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'
import type { Session } from 'next-auth'

import { auth, signIn } from '@/auth'
import { InvitationShell } from '@/components/InvitationShell'
import { JoinRosterForm } from '@/components/JoinRosterForm'
import { PageContainer } from '@/components/PageContainer'
import {
  findGroupInvitation,
  listInvitationTeams,
  listUnlinkedEntriesForGroup,
} from '@/lib/data/group-invitations'
import { findInstallationAccount } from '@/lib/github/organizations'
import { isUsableSession } from '@/lib/session'

import { joinRosterAction } from './actions'
import { TeamPicker } from './TeamPicker'

export const dynamic = 'force-dynamic'

/**
 * Port of GroupAssignmentInvitationsController#show, with the
 * `check_user_not_group_member` and `check_should_redirect_to_roster_page`
 * before_actions.
 *
 * The three routes the original's `route_based_on_status` sorts between are the
 * same three here: no team yet → this picker; a team that never accepted →
 * /accept; anything past that → /setup.
 */
export default async function GroupAssignmentInvitationPage(
  props: PageProps<'/group-assignment-invitations/[key]'>,
) {
  const { key } = await props.params
  const searchParams = await props.searchParams

  const session = await auth()
  if (!isUsableSession(session)) return <SignIn invitationKey={key} />

  const invitation = await findGroupInvitation(session, key)
  if (!invitation) notFound()

  // check_user_not_group_member: the pick is over once they are on a team
  if (invitation.team) {
    redirect(
      invitation.status === 'unaccepted'
        ? `/group-assignment-invitations/${key}/accept`
        : `/group-assignment-invitations/${key}/setup`,
    )
  }

  const organization = await findInstallationAccount(invitation.classroom.installationId)

  const joinRoster =
    invitation.roster !== null &&
    invitation.rosterEntry === null &&
    searchParams.roster !== 'ignore'
      ? invitation.roster
      : null

  return (
    <InvitationShell classroomTitle={invitation.classroom.title} organization={organization}>
      {searchParams.joined === '1' && invitation.rosterEntry && (
        <div className="flash flash-success mb-4">
          Tu cuenta quedó vinculada a {invitation.rosterEntry.identifier} en la lista de alumnos. Si no es
          correcto, escribile al docente.
        </div>
      )}

      {joinRoster ? (
        <JoinRoster
          invitationKey={key}
          identifierName={joinRoster.identifierName}
          session={session}
        />
      ) : (
        <>
          <div className="d-flex flex-items-center mb-2">
            <OrganizationIcon size={22} className="mr-2 color-fg-muted" />
            <h2 className="f2 text-normal">
              Aceptar el trabajo práctico grupal <strong>{invitation.assignmentTitle}</strong>
            </h2>
          </div>

          {invitation.rosterEntry ? (
            <p className="color-fg-muted">
              Vas a figurar en la lista de alumnos como{' '}
              <strong className="text-mono">{invitation.rosterEntry.identifier}</strong>.
            </p>
          ) : invitation.roster ? (
            <p className="color-fg-muted">
              Todavía no elegiste tu {invitation.roster.identifierName.toLowerCase()}.{' '}
              <a href={`/group-assignment-invitations/${key}`}>Elegirlo ahora</a>
            </p>
          ) : null}

          {invitation.enabled ? (
            <>
              <div className="Box my-4">
                <div className="Box-row">
                  <p className="mb-0">
                    Aceptar este trabajo práctico le va a dar a tu equipo acceso a un repositorio en la
                    organización{' '}
                    {organization ? (
                      <a href={`https://github.com/${organization.login}`}>@{organization.login}</a>
                    ) : (
                      'de la cátedra'
                    )}{' '}
                    en GitHub.
                  </p>
                  {/* "Please be certain that the team you are selecting is the
                      correct team as you cannot change this later" — softened,
                      because unlike the original there is a teacher screen that
                      can fix it */}
                  <p className="mb-0 mt-2 color-fg-muted">
                    Elegí con cuidado: no vas a poder cambiarte de equipo solo. Si te equivocás,
                    escribile al docente.
                  </p>
                </div>
              </div>

              <TeamPicker
                invitationKey={key}
                {...(await listInvitationTeams(session, key))}
                maxMembers={invitation.maxMembers}
              />
            </>
          ) : (
            <div className="Box my-4">
              <div className="Box-row">
                <p className="mb-0">{invitation.disabledReason}</p>
              </div>
            </div>
          )}
        </>
      )}
    </InvitationShell>
  )
}

/** The `join_roster` view, shared with the individual flow */
async function JoinRoster({
  invitationKey,
  identifierName,
  session,
}: {
  invitationKey: string
  identifierName: string
  session: Session
}) {
  const entries = await listUnlinkedEntriesForGroup(session, invitationKey)

  return (
    <>
      <div className="d-flex flex-items-center mb-2">
        <OrganizationIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal">Sumate a la lista de alumnos del classroom</h2>
      </div>

      <p className="f4">
        La cátedra vincula cada cuenta de GitHub con un {identifierName.toLowerCase()}. Elegí el
        tuyo de la lista. También podés saltear este paso por ahora.
      </p>

      <JoinRosterForm
        invitationKey={invitationKey}
        identifierName={identifierName}
        entries={entries}
        skipHref={`/group-assignment-invitations/${invitationKey}?roster=ignore`}
        joinRosterAction={joinRosterAction}
      />
    </>
  )
}

/** `redirect_to login_path`, with the invitation as the return address */
function SignIn({ invitationKey }: { invitationKey: string }) {
  return (
    <PageContainer>
      <div className="blankslate blankslate-large blankslate-spacious">
        <h1 className="h2 mb-3">Iniciá sesión para ver el trabajo práctico</h1>
        <p className="f4 color-fg-muted mb-4">
          Usá la misma cuenta de GitHub con la que vas a entregar los trabajos prácticos.
        </p>

        <form
          action={async () => {
            'use server'
            await signIn('github', {
              redirectTo: `/group-assignment-invitations/${invitationKey}`,
            })
          }}
        >
          <button type="submit" className="btn btn-primary btn-large">
            <MarkGithubIcon className="mr-2" />
            Iniciar sesión con GitHub
          </button>
        </form>
      </div>
    </PageContainer>
  )
}
