import {
  AccountAvatar,
  AssignmentRepoList,
  NoAccountAvatar,
  RepoListItem,
  submissionLabel,
  type SubmissionLabel,
} from '@/components/AssignmentRepoList'
import type { AssignmentAcceptances, AcceptanceRow } from '@/lib/data/invitations'
import type { RepositorySnapshot } from '@/lib/github/repositories'

/**
 * Who accepted the assignment, where their repository is and how far along it
 * is. Port of the roster list of `assignments/show.html.erb` and the three
 * partials `orgs/roster_entries/assignment_repos/_linked_accepted`,
 * `_linked_not_accepted` and `_not_in_classroom`, wearing the live site's
 * `.assignment-repo-list` markup.
 *
 * The original's search-and-sort header is still not here: it paginated a list
 * the cátedra reads whole. The order is `RosterEntry.order_for_view`'s, done in
 * SQL.
 *
 * The original's second tab, "Unlinked GitHub accounts", is rendered inline
 * underneath instead: it holds the students who skipped `join_roster`, and a
 * teacher who cannot see them at a glance will not go looking behind a tab.
 */
export function AcceptanceList({
  acceptances,
  assignmentTitle,
  snapshots,
}: {
  acceptances: AssignmentAcceptances
  assignmentTitle: string
  snapshots: Map<number, RepositorySnapshot>
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
        <AssignmentRepoList title={identifierName ?? 'Roster'}>
          {entries.map((entry) => (
            <EntryRow
              key={entry.entryId}
              entry={entry}
              snapshot={entry.repoId === null ? null : (snapshots.get(entry.repoId) ?? null)}
            />
          ))}
        </AssignmentRepoList>
      )}

      {unlinkedAccounts.length > 0 && (
        <div className={entries.length > 0 ? 'mt-4' : ''}>
          <AssignmentRepoList
            title={
              // The live site's tab title, for the accounts with no entry
              identifierName === null ? 'Aceptaron el assignment' : 'Cuentas de GitHub sin vincular'
            }
          >
            {unlinkedAccounts.map((account) => {
              const snapshot =
                account.repoId === null ? null : (snapshots.get(account.repoId) ?? null)

              return (
                <RepoListItem
                  key={account.userId}
                  avatar={<AccountAvatar login={account.githubLogin} />}
                  name={
                    account.githubLogin ? (
                      <a
                        href={`https://github.com/${account.githubLogin}`}
                        className="Link Link--primary"
                      >
                        @{account.githubLogin}
                      </a>
                    ) : (
                      'Cuenta desconocida'
                    )
                  }
                  label={submissionLabel(account.repoId !== null, snapshot)}
                  snapshot={snapshot}
                />
              )
            })}
          </AssignmentRepoList>

          {identifierName !== null && (
            <p className="color-fg-muted f6 mt-2">
              Aceptaron el assignment pero todavía no eligieron su{' '}
              {identifierName.toLowerCase()} en el roster.
            </p>
          )}
        </div>
      )}
    </>
  )
}

function EntryRow({
  entry,
  snapshot,
}: {
  entry: AcceptanceRow
  snapshot: RepositorySnapshot | null
}) {
  return (
    <RepoListItem
      avatar={
        entry.state === 'not_joined' ? (
          // _not_in_classroom: the octicon takes the avatar's place
          <NoAccountAvatar />
        ) : (
          <AccountAvatar login={entry.githubLogin} />
        )
      }
      name={entry.identifier}
      label={entryLabel(entry, snapshot)}
      meta={
        <p className="color-fg-muted mr-3 text-small mb-0">
          {entry.githubLogin ? (
            <a href={`https://github.com/${entry.githubLogin}`} className="Link Link--muted">
              @{entry.githubLogin}
            </a>
          ) : (
            'Sin vincular'
          )}
        </p>
      }
      snapshot={snapshot}
    />
  )
}

/** The three texts of the original's partials, then the repository's own state */
function entryLabel(entry: AcceptanceRow, snapshot: RepositorySnapshot | null): SubmissionLabel {
  // "Not joined classroom"
  if (entry.state === 'not_joined') return { text: 'Sin cuenta vinculada', tone: 'neutral' }

  // `render 'shared/failed_repo_detail', text: "Not accepted"`
  if (entry.state === 'linked_not_accepted') return { text: 'No aceptó', tone: 'neutral' }

  return submissionLabel(entry.repoId !== null, snapshot)
}
