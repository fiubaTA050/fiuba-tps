import { AssignmentRepoList } from '@/components/AssignmentRepoList'
import { submissionLabel, type RepoRow } from '@/lib/assignment-rows'
import type { AssignmentAcceptances } from '@/lib/data/invitations'
import type { RepositorySnapshot } from '@/lib/github/repositories'

import { linkAccountAction } from './actions'

/**
 * Who accepted the assignment, where their repository is and how far along it
 * is. Port of the roster list of `assignments/show.html.erb` and the three
 * partials `orgs/roster_entries/assignment_repos/_linked_accepted`,
 * `_linked_not_accepted` and `_not_in_classroom`.
 *
 * This builds the rows and hands them to the client component that filters and
 * sorts them; the order below is only the starting one,
 * `RosterEntry.order_for_view`, done in SQL.
 *
 * The original's second tab, "Unlinked GitHub accounts", is folded into the
 * same list instead of sitting behind a tab: the live filter bar has a "GitHub
 * accounts" option under "unlinked" that singles them out, which is the same
 * affordance without hiding them from a teacher who is not looking for them.
 */
export function AcceptanceList({
  acceptances,
  assignmentTitle,
  snapshots,
  classroomSlug,
  assignmentSlug,
  unlinkedEntries,
}: {
  acceptances: AssignmentAcceptances
  assignmentTitle: string
  snapshots: Map<number, RepositorySnapshot>
  classroomSlug: string
  assignmentSlug: string
  /** The identifiers "Link to student" offers — empty when there is no roster */
  unlinkedEntries: { id: number; identifier: string }[]
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

  const snapshotOf = (repoId: number | null) =>
    repoId === null ? null : (snapshots.get(repoId) ?? null)

  const rows: RepoRow[] = [
    ...entries.map((entry): RepoRow => {
      const snapshot = snapshotOf(entry.repoId)

      return {
        key: `entry-${entry.entryId}`,
        name: entry.identifier,
        githubLogin: entry.githubLogin,
        visual: entry.state === 'not_joined' ? 'no-account' : 'account',
        label:
          // "Not joined classroom"
          entry.state === 'not_joined'
            ? { text: 'Sin cuenta vinculada', tone: 'neutral' }
            : // `render 'shared/failed_repo_detail', text: "Not accepted"`
              entry.state === 'linked_not_accepted'
              ? { text: 'No aceptó', tone: 'neutral' }
              : submissionLabel(entry.repoId !== null, snapshot),
        snapshot,
        accepted: entry.state === 'accepted',
        unlinkedIdentifier: entry.state === 'not_joined',
        unlinkedAccount: false,
      }
    }),

    ...unlinkedAccounts.map((account): RepoRow => {
      const snapshot = snapshotOf(account.repoId)

      return {
        key: `account-${account.userId}`,
        name: account.githubLogin ? `@${account.githubLogin}` : 'Cuenta desconocida',
        githubLogin: account.githubLogin,
        visual: 'account',
        label: submissionLabel(account.repoId !== null, snapshot),
        snapshot,
        accepted: true,
        unlinkedIdentifier: false,
        unlinkedAccount: true,
        userId: account.userId,
      }
    }),
  ]

  return (
    <>
      <AssignmentRepoList
        title={identifierName ?? 'Aceptaron el assignment'}
        rows={rows}
        // No roster, nothing to link to — `set_unlinked_users` returns early on
        // the same condition
        linkToStudent={
          identifierName === null
            ? undefined
            : {
                classroomSlug,
                assignmentSlug,
                identifierName,
                entries: unlinkedEntries,
                action: linkAccountAction,
              }
        }
      />

      {identifierName !== null && unlinkedAccounts.length > 0 && (
        <p className="color-fg-muted f6 mt-2">
          {unlinkedAccounts.length === 1 ? 'Hay 1 alumno' : `Hay ${unlinkedAccounts.length} alumnos`}{' '}
          que aceptaron el assignment sin elegir su {identifierName.toLowerCase()} en el roster.
          Filtralos con &quot;Sin vincular · Cuentas de GitHub&quot;.
        </p>
      )}
    </>
  )
}
