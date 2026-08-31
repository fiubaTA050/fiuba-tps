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

/** The repo's current confirmed submission, as `listAssignmentSubmissions` reads it */
export type RepoSubmission = {
  sha: string
  late: boolean
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
  /** The GitHub repo id `snapshot` was read with — null when there is no repo.
   *  Kept separately from `snapshot` because it's needed even when the repo
   *  is unreachable (fetching the submission history by repo id). */
  repoId: number | null
  /**
   * The repo's current confirmed submission. `undefined` on a dashboard with
   * no checkpoint concept at all (the group one, for now — group checkpoints
   * do not exist yet); `null` once a checkpoint is tracked but this repo
   * has not confirmed.
   */
  submission?: RepoSubmission | null
  /** Accepted the assignment, whatever came of the repository afterwards */
  accepted: boolean
  /** A roster entry nobody claimed — the live filter's "student identifiers" */
  unlinkedIdentifier: boolean
  /** Accepted without claiming an identifier — the live filter's "GitHub accounts" */
  unlinkedAccount: boolean
  /**
   * Which account "Link to student" would link. Set only on an unlinked-account
   * row: it is the `user_id` the original's `_link_to_student_modal` posts.
   */
  userId?: number
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
 * That commit-based reading is the whole story only where no checkpoint is
 * tracked — the group dashboard today, which calls this with `submission`
 * left `undefined`. Where one is (the individual dashboard), "Entregado" means
 * the stronger fact: the student named a SHA and confirmed it. A repo with
 * commits and no confirmation reads as "Sin confirmar" instead, per
 * docs/entregas.md.
 *
 * `snapshot` null with an id set is the NullGitHubRepository case — the repo
 * was deleted or moved out of the org. Deleting an assignment here does not
 * delete repositories (DA-9), so the reverse is common too and harmless.
 */
export function submissionLabel(
  hasRepo: boolean,
  snapshot: RepositorySnapshot | null,
  submission?: RepoSubmission | null,
): SubmissionLabel {
  if (!hasRepo) return { text: 'Sin repo', tone: 'neutral' }
  if (!snapshot) return { text: 'Repo inaccesible', tone: 'attention' }

  // No checkpoint tracked on this dashboard at all (the group one, for now)
  if (submission === undefined) {
    return snapshot.commitCount > 0
      ? { text: 'Entregado', tone: 'success' }
      : { text: 'Sin entregar', tone: 'danger' }
  }

  if (submission !== null) {
    return { text: `Entregado · ${submission.sha.slice(0, 7)}`, tone: 'success' }
  }

  return snapshot.commitCount > 0
    ? { text: 'Sin confirmar', tone: 'attention' }
    : { text: 'Sin entregar', tone: 'danger' }
}

/** Whether the row counts as handed in, which is what the filter asks */
export function hasSubmitted(row: RepoRow): boolean {
  if (row.submission !== undefined) return row.submission !== null
  return (row.snapshot?.commitCount ?? 0) > 0
}
