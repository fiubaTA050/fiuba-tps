import type { RepositorySnapshot } from '@/lib/github/repositories'

/**
 * The row model the assignment dashboard filters and sorts over, and the rules
 * that derive it. Its own module, and not part of the component, because
 * `components/AssignmentRepoList` is a client component: a server page has to
 * be able to call `submissionLabel` while building the rows.
 */

export type SubmissionTone = 'success' | 'danger' | 'attention' | 'neutral'

export type SubmissionLabel = {
  text: string
  tone: SubmissionTone
}

/** One student or one team, with everything the filters need to decide on it */
export type RepoRow = {
  key: string
  /** The roster identifier, the team name, or the `@handle` of an unlinked account */
  name: string
  /** Searched alongside the name; null on a team row */
  githubLogin: string | null
  /** Whether to lead the row with an avatar, an octicon, or nothing (teams) */
  visual: 'account' | 'no-account' | 'none'
  /** Set on a team row, for the stacked member avatars */
  members?: { githubLogin: string | null; githubAvatarUrl: string | null }[]
  label: SubmissionLabel
  snapshot: RepositorySnapshot | null
  /** Accepted the assignment, whatever came of the repository afterwards */
  accepted: boolean
  /** A roster entry nobody claimed — the live filter's "student identifiers" */
  unlinkedIdentifier: boolean
  /** Accepted without claiming an identifier — the live filter's "GitHub accounts" */
  unlinkedAccount: boolean
}

/**
 * What a row says about a repository, from the two facts the dashboard has:
 * whether a repository exists, and what GitHub says about it.
 *
 * "Entregado" is one or more commits of the student's own — the baseline the
 * repository was created with is already subtracted in
 * `listRepositorySnapshots`, so a repo still sitting at the starter code reads
 * as "Sin entregar", which is the point.
 *
 * The archived Rails app decided this differently and could not be followed:
 * `SharedAssignmentRepoView#submission_succeeded?` is
 * `deadline&.passed? && submission_sha.present?`, so the label only ever
 * appeared **after a deadline**, and deadlines are not ported. The live site
 * has since moved to the commit-based reading this follows — its own filter
 * says "Submitted: students who've committed to repository".
 *
 * `snapshot` null with an id set is the NullGitHubRepository case — the repo
 * was deleted or moved out of the org. Deleting an assignment here does not
 * delete repositories (DA-9), so the reverse is common too and harmless.
 */
export function submissionLabel(
  hasRepo: boolean,
  snapshot: RepositorySnapshot | null,
): SubmissionLabel {
  if (!hasRepo) return { text: 'Sin repo', tone: 'neutral' }
  if (!snapshot) return { text: 'Repo inaccesible', tone: 'attention' }
  return snapshot.commitCount > 0
    ? { text: 'Entregado', tone: 'success' }
    : { text: 'Sin entregar', tone: 'danger' }
}

/** Whether the row counts as handed in, which is what the filter asks */
export function hasSubmitted(row: RepoRow): boolean {
  return (row.snapshot?.commitCount ?? 0) > 0
}
