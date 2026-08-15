import { MarkGithubIcon, PersonIcon } from '@primer/octicons-react'

import type { AssignmentAcceptances, AcceptanceRow } from '@/lib/data/invitations'

/**
 * Who accepted the assignment and who is missing. Port of the roster list of
 * `assignments/show.html.erb` and the three partials
 * `orgs/roster_entries/assignment_repos/_linked_accepted`,
 * `_linked_not_accepted` and `_not_in_classroom`.
 *
 * Two things of the original are gone because they have nothing behind them:
 * the "Ver repositorio" button of `_linked_accepted` — no repository exists
 * yet — and the search-and-sort header, which paginated a list the cátedra can
 * read whole. The order is `RosterEntry.order_for_view`'s, done in SQL.
 *
 * The original's second tab, "Unlinked GitHub accounts", is rendered inline
 * underneath instead: it holds the students who skipped `join_roster`, and a
 * teacher who cannot see them at a glance will not go looking behind a tab.
 */
export function AcceptanceList({
  acceptances,
  assignmentTitle,
}: {
  acceptances: AssignmentAcceptances
  assignmentTitle: string
}) {
  const { identifierName, entries, unlinkedAccounts, acceptedCount } = acceptances

  // The blankslate of the original: `No students have accepted "<title>"`
  if (acceptedCount === 0 && entries.length === 0) {
    return (
      <div className="blankslate blankslate-spacious">
        <h3 className="mb-2">Todavía nadie aceptó &quot;{assignmentTitle}&quot;</h3>
        <p className="color-fg-muted mb-0">
          Compartí el link de invitación con los alumnos para arrancar.
        </p>
      </div>
    )
  }

  return (
    <>
      {entries.length > 0 && (
        <div className="Box">
          <div className="Box-header d-flex flex-justify-between flex-items-center">
            <h3 className="Box-title">{identifierName}</h3>
            {/* Counts the rows of *this* list, not `acceptedCount`: a student
                who accepted without claiming an identifier is not on it, and
                counting them here produced "2 de 2" over a list showing one */}
            <span className="color-fg-muted">
              {entries.filter((entry) => entry.state === 'accepted').length} de {entries.length}{' '}
              aceptaron
            </span>
          </div>

          {entries.map((entry) => (
            <EntryRow key={entry.entryId} entry={entry} />
          ))}
        </div>
      )}

      {unlinkedAccounts.length > 0 && (
        <div className={`Box ${entries.length > 0 ? 'mt-4' : ''}`}>
          <div className="Box-header">
            <h3 className="Box-title">
              {/* The live site's tab title, for the accounts with no entry */}
              {identifierName === null
                ? 'Aceptaron el assignment'
                : 'Cuentas de GitHub sin vincular'}
            </h3>
          </div>

          {identifierName !== null && (
            <div className="Box-row color-fg-muted">
              Aceptaron el assignment pero todavía no eligieron su{' '}
              {identifierName.toLowerCase()} en el roster.
            </div>
          )}

          {unlinkedAccounts.map((account) => (
            <div className="Box-row d-flex flex-items-center" key={account.userId}>
              <Avatar login={account.githubLogin} />
              <div>
                <h4 className="mb-0">
                  {account.githubLogin ? (
                    <a href={`https://github.com/${account.githubLogin}`}>
                      @{account.githubLogin}
                    </a>
                  ) : (
                    'Cuenta desconocida'
                  )}
                </h4>
                <p className="color-fg-muted mb-0">Aceptó</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function EntryRow({ entry }: { entry: AcceptanceRow }) {
  return (
    <div className="Box-row d-flex flex-items-center flex-justify-between">
      <div className="d-flex flex-items-center">
        {entry.state === 'not_joined' ? (
          // _not_in_classroom: the octicon takes the avatar's place
          <span className="d-flex flex-items-center color-fg-muted mr-3">
            <PersonIcon size={24} />
          </span>
        ) : (
          <Avatar login={entry.githubLogin} />
        )}

        <div>
          <h4 className="mb-0 text-mono">{entry.identifier}</h4>
          <p className="color-fg-muted mb-0">
            {entry.githubLogin ? (
              <a href={`https://github.com/${entry.githubLogin}`}>@{entry.githubLogin}</a>
            ) : (
              'Sin vincular'
            )}
          </p>
        </div>
      </div>

      <StateLabel state={entry.state} />
    </div>
  )
}

/** The three texts of the original's partials, translated */
function StateLabel({ state }: { state: AcceptanceRow['state'] }) {
  if (state === 'accepted') {
    return <span className="Label Label--outline Label--outline-green">Aceptó</span>
  }

  if (state === 'linked_not_accepted') {
    // `render 'shared/failed_repo_detail', text: "Not accepted"`
    return <span className="Label Label--gray">No aceptó</span>
  }

  // "Not joined classroom"
  return <span className="Label Label--gray">Sin cuenta vinculada</span>
}

function Avatar({ login }: { login: string | null }) {
  if (!login) {
    return (
      <span className="d-flex flex-items-center color-fg-muted mr-3">
        <MarkGithubIcon size={24} />
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://github.com/${login}.png?size=92`}
      className="avatar avatar-user mr-3"
      height={46}
      width={46}
      alt=""
    />
  )
}
