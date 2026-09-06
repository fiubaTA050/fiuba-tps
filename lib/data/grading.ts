import 'server-only'

import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import {
  assignmentRepos,
  assignments,
  checkpoints,
  gradingRuns,
  organizations,
  organizationsUsers,
  submissions,
} from '@/db/schema'
import { db } from '@/lib/db'
import { mintRepositoryScopedToken } from '@/lib/github/client'
import { findRepositoryOwnerAndName } from '@/lib/github/repositories'

/**
 * The grading worker's data layer — see grading-runs-plan and
 * worker-corrector-plan memories, no equivalent in the original.
 *
 * Unlike the rest of `lib/data/`, these functions do not take a `Session`:
 * the caller is authenticated by API key (`authenticateApiKey` in
 * lib/data/api-keys.ts), which resolves a `userId` and an `apiKeyId`
 * directly, with no browser session behind it — the same exception
 * `lib/data/import.ts` documents, for the same reason.
 *
 * Group assignments are out of scope: `submissions` only references
 * `assignment_repos` today (see entregas-confirmadas-plan), so there is
 * nothing group-shaped to grade yet.
 */

/** Fixed, not configurable. No extension endpoint yet — see grading-runs-plan */
const LEASE_TTL_MS = 60 * 60 * 1000

/**
 * A submission stops being offered once it has this many rows in
 * `grading_runs` with none `succeeded` among them — the cap that keeps a
 * worker that fails every job instantly from re-leasing the same submission
 * forever and burning the installation's shared GitHub rate limit on it.
 * Surfacing that a submission is stuck past this cap is future work.
 */
const MAX_ATTEMPTS = 3

type AttemptStatus = 'leased' | 'succeeded' | 'failed'
type Attempt = { status: AttemptStatus; expiresAt: Date }
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type Lease = {
  leaseId: number
  repo: { owner: string; name: string }
  sha: string
  autograderId: string
  token: string
  expiresAt: Date
}

type Candidate = {
  submissionId: number
  sha: string
  autograderId: string
  githubRepoId: number
  installationId: number
}

/**
 * Hands the worker one submission to grade, or null when there is nothing
 * eligible — the caller answers that with 204, not an error.
 *
 * Algorithm (grading-runs-plan):
 * 1. Every classroom this user teaches — all of them, not one slug, unlike
 *    `findTeachingClassroom`.
 * 2. Among their current submissions (append-only: the last row per
 *    (assignmentRepo, checkpoint)) whose checkpoint has an `autograderId` and
 *    is closed, the oldest one that is not already graded, not already
 *    leased and active, and under the attempt cap.
 * 3. GitHub is asked for the repo and the token **before** anything is
 *    written: if either fails (a deleted repository, a stale installation —
 *    see installation-id-goes-stale, not self-healed here since there is no
 *    browser session to re-resolve it against), nothing is inserted and the
 *    submission's attempt count is not spent on a failure that was never its
 *    own.
 * 4. Only then, inside a transaction, the candidate row is locked
 *    (`SELECT ... FOR UPDATE`) and re-checked — otherwise a second lease
 *    request racing this one between step 2 and the insert could grab the
 *    same submission. Needed even with one worker, since it can poll for
 *    several leases in parallel.
 */
export async function leaseSubmissionForGrading(
  userId: number,
  apiKeyId: number,
): Promise<Lease | null> {
  const orgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(organizationsUsers, eq(organizationsUsers.organizationId, organizations.id))
    .where(and(eq(organizationsUsers.userId, userId), isNull(organizations.deletedAt)))

  const orgIds = orgs.map((org) => org.id)
  if (orgIds.length === 0) return null

  const candidate = await findOldestEligibleCandidate(orgIds)
  if (!candidate) return null

  // Asked for before writing anything — see point 3 above.
  const repo = await findRepositoryOwnerAndName(candidate.installationId, candidate.githubRepoId)
  if (!repo) return null

  const scoped = await mintRepositoryScopedToken(candidate.installationId, candidate.githubRepoId)

  const inserted = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from submissions where id = ${candidate.submissionId} for update`)

    if (!(await isStillEligible(tx, candidate.submissionId))) return null

    const [run] = await tx
      .insert(gradingRuns)
      .values({
        submissionId: candidate.submissionId,
        apiKeyId,
        status: 'leased',
        expiresAt: new Date(Date.now() + LEASE_TTL_MS),
      })
      .returning({ id: gradingRuns.id, expiresAt: gradingRuns.expiresAt })

    return run
  })

  // Lost the race to another lease request. The token minted above is simply
  // never handed out — it is read-only, scoped to this one repo, and expires
  // on its own within the hour.
  if (!inserted) return null

  return {
    leaseId: inserted.id,
    repo,
    sha: candidate.sha,
    autograderId: candidate.autograderId,
    token: scoped.token,
    expiresAt: inserted.expiresAt,
  }
}

export type GradingResultInput = {
  status: 'succeeded' | 'failed'
  score: number | null
  output: string | null
  /** The Gradescope-shaped `tests` array of results.json, stored as-is */
  tests: unknown
}

export type RecordGradingResultResult =
  | { success: true }
  | { success: false; status: 404 | 409; error: string }

/**
 * The worker posts what it read from `results.json` back for one lease.
 *
 * Ownership and state are both checked in the same `UPDATE ... WHERE`, not a
 * read first — the pattern `deleteApiKey` already uses. `apiKeyId` has to
 * match the exact key that took the lease, not merely a key of the same
 * user: that is the only identity this layer has once the lease is handed
 * out, and it is what the `grading_runs.api_key_id` column is for.
 *
 * A second query runs only when the update matched nothing, purely to tell
 * the caller *why* — 404 when the lease is not this caller's (or does not
 * exist), 409 when it is but is no longer open (already completed, or its
 * TTL passed). Never writes on that second query.
 */
export async function recordGradingResult(
  apiKeyId: number,
  leaseId: number,
  result: GradingResultInput,
): Promise<RecordGradingResultResult> {
  const [updated] = await db
    .update(gradingRuns)
    .set({
      status: result.status,
      score: result.score,
      output: result.output,
      tests: result.tests,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(gradingRuns.id, leaseId),
        eq(gradingRuns.apiKeyId, apiKeyId),
        eq(gradingRuns.status, 'leased'),
        gt(gradingRuns.expiresAt, new Date()),
      ),
    )
    .returning({ id: gradingRuns.id })

  if (updated) return { success: true }

  const [existing] = await db
    .select({ apiKeyId: gradingRuns.apiKeyId })
    .from(gradingRuns)
    .where(eq(gradingRuns.id, leaseId))

  if (!existing || existing.apiKeyId !== apiKeyId) {
    return { success: false, status: 404, error: 'No encontramos ese lease.' }
  }

  return { success: false, status: 409, error: 'Ese lease ya no está abierto.' }
}

function isEligible(attempts: Attempt[]): boolean {
  if (attempts.length >= MAX_ATTEMPTS) return false
  if (attempts.some((attempt) => attempt.status === 'succeeded')) return false
  if (attempts.some((attempt) => attempt.status === 'leased' && attempt.expiresAt.getTime() > Date.now())) {
    return false
  }
  return true
}

async function isStillEligible(tx: Transaction, submissionId: number): Promise<boolean> {
  const attempts = await tx
    .select({ status: gradingRuns.status, expiresAt: gradingRuns.expiresAt })
    .from(gradingRuns)
    .where(eq(gradingRuns.submissionId, submissionId))

  return isEligible(attempts)
}

/**
 * The current submission of every (assignmentRepo, checkpoint) across the
 * given classrooms whose assignment has automated grading configured, minus
 * the ones a `grading_runs` row already covers, oldest first (FIFO — the
 * simplest tie-break, not refined further per grading-runs-plan).
 *
 * Two queries rather than one combined one: batching the attempt counts for
 * every candidate at once and filtering in JS reads far simpler than a
 * `DISTINCT ON` joined to a conditional aggregate, and at this scale — the
 * assignments of one cátedra with automated grading turned on — the extra
 * round trip costs nothing next to the GraphQL call and token mint that
 * follow.
 */
async function findOldestEligibleCandidate(orgIds: number[]): Promise<Candidate | null> {
  const current = await db
    .selectDistinctOn([submissions.assignmentRepoId, submissions.checkpointId], {
      submissionId: submissions.id,
      sha: submissions.sha,
      submittedAt: submissions.submittedAt,
      githubRepoId: assignmentRepos.githubRepoId,
      autograderId: checkpoints.autograderId,
      installationId: organizations.installationId,
    })
    .from(submissions)
    .innerJoin(assignmentRepos, eq(assignmentRepos.id, submissions.assignmentRepoId))
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentRepos.assignmentId), isNull(assignments.deletedAt)),
    )
    .innerJoin(organizations, eq(organizations.id, assignments.organizationId))
    .innerJoin(checkpoints, eq(checkpoints.id, submissions.checkpointId))
    .where(
      and(
        isNotNull(checkpoints.autograderId),
        isNotNull(checkpoints.closedAt),
        inArray(organizations.id, orgIds),
      ),
    )
    .orderBy(submissions.assignmentRepoId, submissions.checkpointId, desc(submissions.id))

  if (current.length === 0) return null

  const attempts = await db
    .select({
      submissionId: gradingRuns.submissionId,
      status: gradingRuns.status,
      expiresAt: gradingRuns.expiresAt,
    })
    .from(gradingRuns)
    .where(
      inArray(
        gradingRuns.submissionId,
        current.map((row) => row.submissionId),
      ),
    )

  const bySubmission = new Map<number, Attempt[]>()
  for (const attempt of attempts) {
    const list = bySubmission.get(attempt.submissionId) ?? []
    list.push(attempt)
    bySubmission.set(attempt.submissionId, list)
  }

  const eligible = current
    .filter((row) => isEligible(bySubmission.get(row.submissionId) ?? []))
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())

  const winner = eligible[0]
  // Only defensive: excluded by `isNotNull(checkpoints.autograderId)` above,
  // Drizzle just does not narrow the column's type from the WHERE clause.
  if (!winner?.autograderId) return null

  return {
    submissionId: winner.submissionId,
    sha: winner.sha,
    autograderId: winner.autograderId,
    githubRepoId: winner.githubRepoId,
    installationId: winner.installationId,
  }
}
