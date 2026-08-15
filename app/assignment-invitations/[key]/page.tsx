import { MarkGithubIcon, PersonIcon } from '@primer/octicons-react'
import { notFound, redirect } from 'next/navigation'
import type { Session } from 'next-auth'

import { auth, signIn } from '@/auth'
import { InvitationShell } from '@/components/InvitationShell'
import { PageContainer } from '@/components/PageContainer'
import { findInvitation, listUnlinkedRosterEntries } from '@/lib/data/invitations'
import { findInstallationAccount } from '@/lib/github/organizations'
import { isUsableSession } from '@/lib/session'

import { AcceptForm } from './AcceptForm'
import { JoinRosterForm } from './JoinRosterForm'

export const dynamic = 'force-dynamic'

/**
 * Port of AssignmentInvitationsController#show, with the
 * `check_should_redirect_to_roster_page` before_action that renders
 * `join_roster` instead, and the `show` branch of `route_based_on_status`.
 *
 * The original's #success is not ported: its whole body is a link to
 * `current_submission.github_repository.html_url`, and no repository exists in
 * this port yet. `completed` is unreachable for the same reason, so every
 * status past `unaccepted` lands on /setup.
 */
export default async function AssignmentInvitationPage(
  props: PageProps<'/assignment-invitations/[key]'>,
) {
  const { key } = await props.params
  const searchParams = await props.searchParams

  const session = await auth()

  // The original's `authenticate_user!`, which redirected to login_path and
  // came back here. Rendered rather than redirected: `/` would sign them in
  // and land on /classrooms, which a student has no business seeing, and the
  // assignment they were invited to would be lost on the way.
  if (!isUsableSession(session)) return <SignIn invitationKey={key} />

  const invitation = await findInvitation(session, key)

  // `find_by!(key: params[:id])` raising RecordNotFound
  if (!invitation) notFound()

  // route_based_on_status: anything past `unaccepted` belongs on #setup
  if (invitation.status !== 'unaccepted') {
    redirect(`/assignment-invitations/${key}/setup`)
  }

  // DA-2: the org is read from GitHub. Resolved through the App's own JWT, so
  // it works for a student who belongs to no classroom and may not even be a
  // member of the organization yet.
  const organization = await findInstallationAccount(invitation.classroom.installationId)

  // check_should_redirect_to_roster_page: a roster exists, the student is not
  // on it, and they did not ask to skip
  const joinRoster =
    invitation.roster !== null &&
    invitation.rosterEntry === null &&
    searchParams.roster !== 'ignore'
      ? invitation.roster
      : null

  return (
    <InvitationShell classroomTitle={invitation.classroom.title} organization={organization}>
      {/* flash[:success] of #join_roster, which names the entry it linked */}
      {searchParams.joined === '1' && invitation.rosterEntry && (
        <div className="flash flash-success mb-4">
          Tu cuenta quedó vinculada a {invitation.rosterEntry.identifier} en el roster. Si no es
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
            <PersonIcon size={22} className="mr-2 color-fg-muted" />
            <h2 className="f2 text-normal">
              Aceptar el assignment <strong>{invitation.assignmentTitle}</strong>
            </h2>
          </div>

          {invitation.rosterEntry ? (
            <p className="color-fg-muted">
              Vas a figurar en el roster como{' '}
              <strong className="text-mono">{invitation.rosterEntry.identifier}</strong>.
            </p>
          ) : invitation.roster ? (
            // They skipped: the original left no trace of this, and a teacher
            // chasing an unlinked account is the cost of that silence
            <p className="color-fg-muted">
              Todavía no elegiste tu {invitation.roster.identifierName.toLowerCase()}.{' '}
              <a href={`/assignment-invitations/${key}`}>Elegirlo ahora</a>
            </p>
          ) : null}

          <div className="Box my-4">
            <div className="Box-row">
              {invitation.enabled ? (
                <p className="mb-0">
                  Aceptar este assignment te va a dar acceso al repositorio{' '}
                  <strong className="text-mono">
                    {invitation.assignmentSlug}-{session.user.githubLogin}
                  </strong>{' '}
                  en la organización{' '}
                  {organization ? (
                    <a href={`https://github.com/${organization.login}`}>@{organization.login}</a>
                  ) : (
                    'de la cátedra'
                  )}{' '}
                  en GitHub.
                </p>
              ) : (
                // Decision for this port: the reason is shown on the way in,
                // instead of only after clicking a button that cannot work.
                // AssignmentInvitation#reason_for_disabled_invitations
                <p className="mb-0">{invitation.disabledReason}</p>
              )}
            </div>
          </div>

          {invitation.enabled && <AcceptForm invitationKey={key} />}
        </>
      )}
    </InvitationShell>
  )
}

/** The `join_roster` view, whose list is the only thing that needs a query */
async function JoinRoster({
  invitationKey,
  identifierName,
  session,
}: {
  invitationKey: string
  identifierName: string
  session: Session
}) {
  const entries = await listUnlinkedRosterEntries(session, invitationKey)

  return (
    <>
      <div className="d-flex flex-items-center mb-2">
        <PersonIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal">Sumate al roster del classroom</h2>
      </div>

      <p className="f4">
        La cátedra vincula cada cuenta de GitHub con un {identifierName.toLowerCase()}. Elegí el
        tuyo de la lista. También podés saltear este paso por ahora.
      </p>

      <JoinRosterForm
        invitationKey={invitationKey}
        identifierName={identifierName}
        entries={entries}
        skipHref={`/assignment-invitations/${invitationKey}?roster=ignore`}
      />
    </>
  )
}

/** `redirect_to login_path`, with the invitation as the return address */
function SignIn({ invitationKey }: { invitationKey: string }) {
  return (
    <PageContainer>
      <div className="blankslate blankslate-large blankslate-spacious">
        <h1 className="h2 mb-3">Iniciá sesión para ver el assignment</h1>
        <p className="f4 color-fg-muted mb-4">
          Usá la misma cuenta de GitHub con la que vas a entregar los trabajos prácticos.
        </p>

        <form
          action={async () => {
            'use server'
            await signIn('github', {
              redirectTo: `/assignment-invitations/${invitationKey}`,
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
