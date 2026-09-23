import 'server-only'

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  checkpoints,
  gradingRuns,
  organizations,
  submissionExemptions,
  submissions,
} from '@/db/schema'
import { disabledState } from '@/lib/data/invitations'
import { findTeachingClassroom } from '@/lib/data/organizations'
import { db } from '@/lib/db'
import { isReachableFromDefaultBranch, resolveRepositoryRef } from '@/lib/github/repositories'

/**
 * The student's confirmed submission: they name a ref of their repository and
 * confirm, which freezes a SHA.
 *
 * DA-4: both functions take the session and reach the row through the
 * invitation key **and** the caller's own user id, so one student can never
 * read or write another's submission.
 *
 * There is no equivalent in the original, whose `submission_sha` was written
 * by `DeadlineJob` with whatever HEAD the worker found when it woke up. The
 * inversion is deliberate — the student chooses the tree that gets graded —
 * and docs/entregas.md records why it cannot be reconstructed after the fact.
 */

export type ConfirmSubmissionResult =
  | { success: true; sha: string; unchanged: boolean; warning: string | null }
  | { success: false; error: string }

export type SubmissionRow = {
  id: number
  sha: string
  ref: string
  /** Null on submissions confirmed before this field existed */
  aiDeclaration: string | null
  committedAt: Date
  submittedAt: Date
  /** `submitted_at` past the deadline. Accepted anyway — it closes nothing */
  late: boolean
}

export type CheckpointPanel = {
  checkpointId: number
  /** "2A". Null is the single unnamed entrega of an assignment with no parts */
  title: string | null
  deadlineAt: Date | null
  /** Read on the server: the screen must not decide "late" off the viewer's clock */
  overdue: boolean
  /** False when the assignment is Inactive/archived, or this entrega itself was closed */
  enabled: boolean
  /**
   * The entrega is closed but the teacher let this repository back in — see
   * `submissionExemptions` in db/schema.ts. Only ever true on a closed entrega:
   * on an open one the exemption changes nothing and is not reported.
   */
  exempt: boolean
  disabledReason: string | null
  current: SubmissionRow | null
  /** Every confirmation, newest first. The student argues with data, not memory */
  history: SubmissionRow[]
  /**
   * What the student may see of the automated grading of `current`. Null
   * when there is nothing to say: no autograder on this entrega, nothing
   * confirmed, or an open entrega nobody has graded yet.
   */
  grading: StudentGrading | null
}

export type StudentGradingTest = {
  name: string
  status: string | null
  score: number | null
  maxScore: number | null
  output: string | null
  /** `output` was cut to its last STUDENT_OUTPUT_MAX_CHARS */
  truncated: boolean
}

/**
 * - `pending`: the entrega has an autograder but nothing is visible yet —
 *   not graded, or graded and not published.
 * - `failed`: published, and the only runs are the worker failing. The
 *   student gets Gradescope's "the autograder failed to execute", never the
 *   worker's own output: that failure is not theirs.
 * - `graded`: `score` is null when some test is still hidden, as Gradescope
 *   withholds the total then; `hiddenTests` says how many.
 */
export type StudentGrading =
  | { state: 'pending' }
  | { state: 'failed' }
  | {
      state: 'graded'
      score: number | null
      maxScore: number | null
      output: string | null
      outputTruncated: boolean
      tests: StudentGradingTest[]
      hiddenTests: number
    }

export type CurrentSubmission = {
  sha: string
  submittedAt: Date
  /** `submitted_at` past the checkpoint's deadline. Accepted anyway — it closes nothing */
  late: boolean
  /**
   * What the automated grading made of this SHA: true when every test of its
   * succeeded run passed, false when one did not, null when no run has
   * succeeded yet — the entrega has no autograder, is still open, or the
   * worker has not reached it. See `passedAllTests`.
   */
  passed: boolean | null
}

export type CheckpointSubmissions = {
  id: number
  /** "2A". Null is the single unnamed entrega of an assignment with no parts */
  title: string | null
  deadlineAt: Date | null
  /** The teacher closed it by hand — what makes "Extender entrega" mean something */
  closed: boolean
  /** Has an `autograderId`: its submissions get a `passed` once graded */
  autograded: boolean
  /** Repositories with an active exemption from that close, by GitHub repo id */
  exemptRepoIds: Set<number>
  /** Keyed by the GitHub repo id — the same key `listRepositorySnapshots` and
   *  `AssignmentAcceptances` use, not the internal `assignment_repos.id` */
  byRepoId: Map<number, CurrentSubmission>
}

export type AssignmentSubmissions = {
  /** Empty when the teacher has not opened entregas at all — nothing to
   *  confirm yet. Ordered by `position`, the same order the edit screen and
   *  the student's own panel use, so the dashboard's tabs read left to right
   *  the same way. */
  checkpoints: CheckpointSubmissions[]
}

/**
 * The current submission of every repository, on every entrega of the
 * assignment, for the teacher dashboard's per-checkpoint tabs.
 *
 * "Current" is the literal latest row by id, late or not — the same reading
 * `findSubmissionPanels` gives the student as `current`. Serves the
 * `distinct on` that `index_submissions_on_repo_and_checkpoint`'s comment
 * anticipates, one distinct group per (repo, checkpoint) instead of per repo.
 *
 * DA-4: verifies the caller teaches this classroom independently, the same
 * way `setClassroomArchived` does, rather than trusting a sibling call in the
 * page's `Promise.all` to have checked.
 */
export async function listAssignmentSubmissions(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<AssignmentSubmissions | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const checkpointRows = await db
    .select({
      id: checkpoints.id,
      title: checkpoints.title,
      deadlineAt: checkpoints.deadlineAt,
      closedAt: checkpoints.closedAt,
      autograderId: checkpoints.autograderId,
    })
    .from(checkpoints)
    .innerJoin(assignments, eq(assignments.id, checkpoints.assignmentId))
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
      ),
    )
    // `id` breaks a tie on `position` — see the same comment on listCheckpoints
    .orderBy(checkpoints.position, checkpoints.id)

  if (checkpointRows.length === 0) return { checkpoints: [] }

  const checkpointIds = checkpointRows.map((row) => row.id)
  const deadlineById = new Map(checkpointRows.map((row) => [row.id, row.deadlineAt]))

  const rows = await db
    .selectDistinctOn([submissions.assignmentRepoId, submissions.checkpointId], {
      id: submissions.id,
      checkpointId: submissions.checkpointId,
      githubRepoId: assignmentRepos.githubRepoId,
      sha: submissions.sha,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .innerJoin(assignmentRepos, eq(assignmentRepos.id, submissions.assignmentRepoId))
    .where(inArray(submissions.checkpointId, checkpointIds))
    .orderBy(submissions.assignmentRepoId, submissions.checkpointId, desc(submissions.id))

  // Only the current submissions' runs, and only the succeeded ones: a
  // `failed` run is the worker failing, not the student, and says nothing
  // about the tests. The lease never hands out a submission that already has
  // a succeeded run (`isEligible` in lib/data/grading.ts), so there is at
  // most one per submission.
  const runs =
    rows.length === 0
      ? []
      : await db
          .select({ submissionId: gradingRuns.submissionId, tests: gradingRuns.tests })
          .from(gradingRuns)
          .where(
            and(
              inArray(
                gradingRuns.submissionId,
                rows.map((row) => row.id),
              ),
              eq(gradingRuns.status, 'succeeded'),
            ),
          )

  const passedBySubmission = new Map(runs.map((run) => [run.submissionId, passedAllTests(run.tests)]))

  const byCheckpoint = new Map<number, Map<number, CurrentSubmission>>(
    checkpointIds.map((id) => [id, new Map()]),
  )

  for (const row of rows) {
    const deadlineAt = deadlineById.get(row.checkpointId)!
    byCheckpoint.get(row.checkpointId)!.set(row.githubRepoId, {
      sha: row.sha,
      submittedAt: row.submittedAt,
      late: deadlineAt !== null && row.submittedAt.getTime() > deadlineAt.getTime(),
      passed: passedBySubmission.get(row.id) ?? null,
    })
  }

  const exemptions = await db
    .select({
      checkpointId: submissionExemptions.checkpointId,
      githubRepoId: assignmentRepos.githubRepoId,
    })
    .from(submissionExemptions)
    .innerJoin(assignmentRepos, eq(assignmentRepos.id, submissionExemptions.assignmentRepoId))
    .where(
      and(
        inArray(submissionExemptions.checkpointId, checkpointIds),
        isNull(submissionExemptions.revokedAt),
      ),
    )

  const exemptByCheckpoint = new Map<number, Set<number>>(
    checkpointIds.map((id) => [id, new Set()]),
  )
  for (const row of exemptions) {
    exemptByCheckpoint.get(row.checkpointId)!.add(row.githubRepoId)
  }

  return {
    checkpoints: checkpointRows.map((row) => ({
      id: row.id,
      title: row.title,
      deadlineAt: row.deadlineAt,
      closed: row.closedAt !== null,
      autograded: row.autograderId !== null,
      exemptRepoIds: exemptByCheckpoint.get(row.id)!,
      byRepoId: byCheckpoint.get(row.id)!,
    })),
  }
}

/**
 * The live site's "Passing": a student passes when the autograder awarded
 * every point. Here the run's `tests` are Gradescope's `results.json` array,
 * so that reads as every test `passed` — the per-test status the autograder
 * runner (~/fiuba/autograder, cmd/runner) writes, rather than comparing
 * `score` to a maximum the run does not store. A run with no tests passes
 * nothing: a build that broke before any test ran reads as failing.
 */
export function passedAllTests(tests: unknown): boolean {
  if (!Array.isArray(tests) || tests.length === 0) return false
  return tests.every(
    (test) => typeof test === 'object' && test !== null && (test as { status?: unknown }).status === 'passed',
  )
}

/**
 * How long a repository has to wait between confirmations.
 *
 * Not a submission limit — see docs/entregas.md on why there is none. It
 * protects the installation's GitHub rate limit, which is shared by every
 * teacher's dashboard, from a script that commits and confirms in a loop. The
 * SHA dedupe below does not cover that case: each of those confirmations
 * carries a different SHA.
 */
/** The teacher closed this entrega by hand — see checkpoints.closedAt in db/schema.ts */
const CHECKPOINT_CLOSED = 'Esta entrega ya está cerrada.'

const COOLDOWN_MS = 10_000

const MAX_REF_LENGTH = 255

const MAX_AI_DECLARATION_LENGTH = 2000

/**
 * The runner keeps up to 256 KB per test; the student gets the tail, which is
 * where `go test` puts the failure. Measured on TP1: 33 KB the largest, 1 KB on average.
 */
export const STUDENT_OUTPUT_MAX_CHARS = 16_000

/**
 * What the setup screen needs, one panel per entrega — 2A to 2D for TP2, or
 * a list of one for a TP with a single date. Empty means the teacher has not
 * opened entregas at all: nothing to hand in.
 */
export async function findSubmissionPanels(
  session: Session,
  key: string,
): Promise<CheckpointPanel[] | null> {
  const context = await loadContext(session, key)
  if (!context) return null

  const base = disabledState(context.invitationsEnabled, context.archivedAt)

  const panels: CheckpointPanel[] = []
  for (const checkpoint of context.checkpoints) {
    let { enabled, disabledReason } = base

    // A closed entrega is a second, independent reason confirmations are
    // refused — checked after the assignment-level one so an Inactive/archived
    // message still wins if both apply. An exemption lifts this one only.
    const closed = checkpoint.closedAt !== null
    if (enabled && closed && !checkpoint.exempt) {
      enabled = false
      disabledReason = CHECKPOINT_CLOSED
    }

    const panel: CheckpointPanel = {
      checkpointId: checkpoint.id,
      title: checkpoint.title,
      deadlineAt: checkpoint.deadlineAt,
      overdue: checkpoint.deadlineAt !== null && checkpoint.deadlineAt.getTime() < Date.now(),
      enabled,
      disabledReason,
      // Only when it is what lets them in: an Inactive/archived assignment
      // refuses anyway, and the notice would contradict the disabled form
      exempt: enabled && closed && checkpoint.exempt,
      current: null,
      history: [],
      grading: null,
    }

    if (context.repoId === null) {
      panels.push(panel)
      continue
    }

    const history = await listSubmissions(context.repoId, checkpoint.id, checkpoint.deadlineAt)
    // Append-only: the current submission is the last row, and the serial id
    // is what breaks the tie — `submitted_at` can repeat
    const current = history[0] ?? null

    const grading =
      current && checkpoint.autograderId !== null
        ? studentGradingView(await listGradingRuns(current.id), {
            closed,
            published: checkpoint.resultsPublishedAt !== null,
            deadlinePassed: panel.overdue,
          })
        : null

    panels.push({ ...panel, current, history, grading })
  }

  return panels
}

/**
 * One repo's full submission history on one entrega, teacher-facing —
 * fetched on demand when a dashboard row is expanded, not eagerly for the
 * whole cohort. A single repo can carry many confirmations (the cooldown
 * limits the rate, not the count — see docs/entregas.md), which would
 * otherwise inflate every teacher's page load for rows nobody opens.
 *
 * `checkpointId` picks which entrega — the dashboard shows one tab at a
 * time (`listAssignmentSubmissions`), and this mirrors that scoping rather
 * than assuming the assignment's single unnamed checkpoint.
 */
export async function findSubmissionHistory(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  githubRepoId: number,
  checkpointId: number,
): Promise<SubmissionRow[] | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [row] = await db
    .select({
      repoId: assignmentRepos.id,
      deadlineAt: checkpoints.deadlineAt,
    })
    .from(assignmentRepos)
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentRepos.assignmentId), isNull(assignments.deletedAt)),
    )
    .innerJoin(
      checkpoints,
      and(eq(checkpoints.id, checkpointId), eq(checkpoints.assignmentId, assignments.id)),
    )
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        eq(assignmentRepos.githubRepoId, githubRepoId),
      ),
    )

  // No such checkpoint on this assignment, or this repo isn't this
  // assignment's — nothing to show, never "not yours to see" (that
  // classroom check already happened above)
  if (!row) return []

  return listSubmissions(row.repoId, checkpointId, row.deadlineAt)
}

export type GradingRunRow = {
  id: number
  status: 'leased' | 'succeeded' | 'failed'
  leasedAt: Date
  expiresAt: Date
  completedAt: Date | null
  score: number | null
  output: string | null
  tests: unknown
}

export type SubmissionDetail = {
  submission: SubmissionRow
  gradingRuns: GradingRunRow[]
}

/**
 * One submission, teacher-facing, with every grading_runs attempt against
 * it — the two facts a docente cannot see anywhere else: the AI declaration
 * and the automated grading result. See worker-corrector-plan.
 *
 * Unlike `findSubmissionHistory`, the join here does not restrict to the
 * single unnamed checkpoint: `submissions.id` already pins the row, so there
 * is nothing to disambiguate.
 */
export async function findSubmissionDetail(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  githubRepoId: number,
  submissionId: number,
): Promise<SubmissionDetail | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [row] = await db
    .select({
      id: submissions.id,
      sha: submissions.sha,
      ref: submissions.ref,
      aiDeclaration: submissions.aiDeclaration,
      committedAt: submissions.committedAt,
      submittedAt: submissions.submittedAt,
      deadlineAt: checkpoints.deadlineAt,
    })
    .from(submissions)
    .innerJoin(assignmentRepos, eq(assignmentRepos.id, submissions.assignmentRepoId))
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentRepos.assignmentId), isNull(assignments.deletedAt)),
    )
    .innerJoin(checkpoints, eq(checkpoints.id, submissions.checkpointId))
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        eq(assignmentRepos.githubRepoId, githubRepoId),
        eq(submissions.id, submissionId),
      ),
    )

  // Not this classroom's, not this assignment's repo, or not this
  // submission's id — never distinguished from each other, same stance as
  // findSubmissionHistory's "nothing to show" above
  if (!row) return null

  const runs = await db
    .select({
      id: gradingRuns.id,
      status: gradingRuns.status,
      leasedAt: gradingRuns.leasedAt,
      expiresAt: gradingRuns.expiresAt,
      completedAt: gradingRuns.completedAt,
      score: gradingRuns.score,
      output: gradingRuns.output,
      tests: gradingRuns.tests,
    })
    .from(gradingRuns)
    .where(eq(gradingRuns.submissionId, row.id))
    .orderBy(desc(gradingRuns.id))

  return {
    submission: {
      id: row.id,
      sha: row.sha,
      ref: row.ref,
      aiDeclaration: row.aiDeclaration,
      committedAt: row.committedAt,
      submittedAt: row.submittedAt,
      late: row.deadlineAt !== null && row.submittedAt.getTime() > row.deadlineAt.getTime(),
    },
    gradingRuns: runs,
  }
}

export type SubmissionExemptionResult = { success: true } | { success: false; error: string }

/**
 * Lets one repository back into a closed entrega, or takes that back — the
 * live site's "Extend …'s assignment deadline" / "Revoke …'s deadline
 * extension". See `submissionExemptions` in db/schema.ts.
 *
 * Refused on an open entrega: there is nothing to exempt from, and an
 * exemption lying in wait would silently outlive the next close.
 */
export async function setSubmissionExemption(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  checkpointId: number,
  githubRepoId: number,
  exempt: boolean,
): Promise<SubmissionExemptionResult | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  if (classroom.archivedAt) {
    return {
      success: false,
      error: 'No se pueden modificar trabajos prácticos en un classroom archivado.',
    }
  }

  const [row] = await db
    .select({ repoId: assignmentRepos.id, closedAt: checkpoints.closedAt })
    .from(assignmentRepos)
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentRepos.assignmentId), isNull(assignments.deletedAt)),
    )
    .innerJoin(
      checkpoints,
      and(eq(checkpoints.id, checkpointId), eq(checkpoints.assignmentId, assignments.id)),
    )
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        eq(assignmentRepos.githubRepoId, githubRepoId),
      ),
    )

  if (!row) return { success: false, error: 'No encontramos esa entrega.' }

  if (exempt && row.closedAt === null) {
    return { success: false, error: 'La entrega está abierta, no hace falta extenderla.' }
  }

  if (exempt) {
    await db
      .insert(submissionExemptions)
      .values({
        checkpointId,
        assignmentRepoId: row.repoId,
        createdByUserId: Number(session.user.id),
      })
      .onConflictDoUpdate({
        target: [submissionExemptions.checkpointId, submissionExemptions.assignmentRepoId],
        set: { revokedAt: null, createdByUserId: Number(session.user.id), createdAt: new Date() },
      })
  } else {
    // Revoking an exemption that does not exist is a no-op, not an error:
    // the double click on "Revocar" lands here
    await db
      .update(submissionExemptions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(submissionExemptions.checkpointId, checkpointId),
          eq(submissionExemptions.assignmentRepoId, row.repoId),
          isNull(submissionExemptions.revokedAt),
        ),
      )
  }

  return { success: true }
}

/**
 * The student confirms a ref as their submission.
 *
 * The deadline is deliberately **not** a rejection: late submissions are
 * accepted and read as `Tarde`. What closes entregas is the assignment going
 * Inactive, or this entrega's own checkpoint being closed by hand — the two
 * levers the teacher has, checked here as `disabledState` and `closedAt`.
 */
export async function confirmSubmission(
  session: Session,
  key: string,
  checkpointId: number,
  ref: string,
  aiDeclaration: string,
): Promise<ConfirmSubmissionResult> {
  const trimmed = ref.trim()

  if (trimmed.length === 0) {
    return { success: false, error: 'Escribí una rama, un tag o un commit de tu repositorio.' }
  }

  if (trimmed.length > MAX_REF_LENGTH) {
    return { success: false, error: 'Ese ref es demasiado largo.' }
  }

  const trimmedDeclaration = aiDeclaration.trim()

  if (trimmedDeclaration.length === 0) {
    return {
      success: false,
      error: 'Contá si usaste herramientas de IA para este trabajo práctico, aunque no hayas usado ninguna.',
    }
  }

  if (trimmedDeclaration.length > MAX_AI_DECLARATION_LENGTH) {
    return { success: false, error: 'Esa declaración es demasiado larga.' }
  }

  const context = await loadContext(session, key)
  if (!context) return { success: false, error: 'No encontramos ese trabajo práctico.' }

  const { enabled, disabledReason } = disabledState(context.invitationsEnabled, context.archivedAt)
  if (!enabled) return { success: false, error: disabledReason! }

  if (context.checkpoints.length === 0) {
    return { success: false, error: 'El docente todavía no habilitó las entregas.' }
  }

  const checkpoint = context.checkpoints.find((row) => row.id === checkpointId)
  if (!checkpoint) {
    return { success: false, error: 'No encontramos esa entrega.' }
  }

  if (checkpoint.closedAt !== null && !checkpoint.exempt) {
    return { success: false, error: CHECKPOINT_CLOSED }
  }

  if (context.repoId === null || context.githubRepoId === null) {
    return { success: false, error: 'Todavía no tenés un repositorio para este trabajo práctico.' }
  }

  const [last] = await db
    .select({
      sha: submissions.sha,
      aiDeclaration: submissions.aiDeclaration,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.assignmentRepoId, context.repoId),
        eq(submissions.checkpointId, checkpoint.id),
      ),
    )
    .orderBy(desc(submissions.id))
    .limit(1)

  if (last && Date.now() - last.submittedAt.getTime() < COOLDOWN_MS) {
    return {
      success: false,
      error: 'Esperá unos segundos antes de volver a confirmar.',
    }
  }

  // DA-2: the repository is asked for by id, and the same call brings back the
  // name and the default branch. Nothing is written if the ref does not resolve.
  const resolved = await resolveRepositoryRef(context.installationId, context.githubRepoId, trimmed)

  if (!resolved) {
    return {
      success: false,
      error: `No encontramos "${trimmed}" en tu repositorio. Puede ser una rama, un tag o un commit.`,
    }
  }

  const { sha, committedAt } = resolved.commit

  // The double click. Confirming the same tree with the same declaration
  // twice is not a new submission, which is what makes the unique index the
  // first design wanted unnecessary. A changed declaration on the same SHA
  // still counts as a change — the student may be correcting what they wrote.
  if (last?.sha === sha && last?.aiDeclaration === trimmedDeclaration) {
    return { success: true, sha, unchanged: true, warning: null }
  }

  await db.insert(submissions).values({
    assignmentRepoId: context.repoId,
    checkpointId: checkpoint.id,
    sha,
    ref: trimmed,
    aiDeclaration: trimmedDeclaration,
    committedAt,
    submittedByUserId: Number(session.user.id),
  })

  // A warning, never a rejection: handing in a tag outside the default branch
  // is legitimate, and null means GitHub could not tell us — no scary message
  // we cannot back up
  const reachable = await isReachableFromDefaultBranch(
    context.installationId,
    resolved.fullName,
    resolved.defaultBranch,
    sha,
  )

  return {
    success: true,
    sha,
    unchanged: false,
    warning:
      reachable === false
        ? `Ojo: ese commit no está en la rama ${resolved.defaultBranch}. Si no era lo que querías, volvé a confirmar.`
        : null,
  }
}

type GradingRunForStudent = {
  status: 'leased' | 'succeeded' | 'failed'
  score: number | null
  output: string | null
  tests: unknown
}

/** Every attempt against one submission, newest first */
async function listGradingRuns(submissionId: number): Promise<GradingRunForStudent[]> {
  return db
    .select({
      status: gradingRuns.status,
      score: gradingRuns.score,
      output: gradingRuns.output,
      tests: gradingRuns.tests,
    })
    .from(gradingRuns)
    .where(eq(gradingRuns.submissionId, submissionId))
    .orderBy(desc(gradingRuns.id))
}

type GradingVisibilityContext = {
  closed: boolean
  /** The teacher's "Publicar resultados" — checkpoints.resultsPublishedAt */
  published: boolean
  deadlinePassed: boolean
}

/**
 * Gradescope's `visibility`, per test, from the autograder spec
 * (gradescope-autograders.readthedocs.io/en/latest/specs/). One divergence: a
 * test with no `visibility` reads as `after_published`, where Gradescope
 * reads it as `visible`. There the student is waiting for the result of what
 * they just uploaded; here grading only starts once the entrega closes, and
 * TP1 showed why a review comes first — an image missing `libprotobuf-dev`
 * failed a correct submission as "no compila". See docs/entregas.md.
 *
 * `after_due_date` is the deadline or the close, whichever comes first:
 * Gradescope waits for the late due date when late submissions are allowed,
 * and the close is what ends them here.
 */
function isVisibleToStudent(visibility: unknown, context: GradingVisibilityContext): boolean {
  switch (visibility) {
    case 'visible':
      return true
    case 'hidden':
      return false
    case 'after_due_date':
      return context.deadlinePassed || context.closed
    default:
      return context.published
  }
}

function hasTests(run: GradingRunForStudent): boolean {
  return Array.isArray(run.tests) && run.tests.length > 0
}

function tail(text: string | null): { text: string | null; truncated: boolean } {
  if (text === null || text.length <= STUDENT_OUTPUT_MAX_CHARS) return { text, truncated: false }
  return { text: text.slice(-STUDENT_OUTPUT_MAX_CHARS), truncated: true }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * What the student sees of one submission's grading runs. Pure, so the
 * visibility rules are tested without a database.
 *
 * Reads the newest `succeeded` run — the lease never grades a submission
 * twice once one succeeded, so there is at most one. The overall `output`
 * (the build log) has no `visibility` of its own stored yet, so it follows
 * the default: shown once published.
 *
 * A `succeeded` run with no tests counts as a worker failure: it is what the
 * runner writes when it fails on its own before grading (`main` in
 * ~/fiuba/autograder/cmd/runner, "El autograder falló antes de poder
 * corregir"), and its output is that internal error, not the student's.
 * A build that breaks still lists every test, via the runner's `zeroed`.
 */
export function studentGradingView(
  runs: GradingRunForStudent[],
  context: GradingVisibilityContext,
): StudentGrading | null {
  const succeeded = runs.find((run) => run.status === 'succeeded' && hasTests(run))

  if (!succeeded) {
    if (runs.length === 0 && !context.closed) return null
    const onlyFailures = runs.length > 0 && runs.every((run) => run.status !== 'leased')
    return context.published && onlyFailures ? { state: 'failed' } : { state: 'pending' }
  }

  const all = Array.isArray(succeeded.tests)
    ? succeeded.tests.filter((test): test is Record<string, unknown> => typeof test === 'object' && test !== null)
    : []
  const visible = all.filter((test) => isVisibleToStudent(test.visibility, context))

  if (visible.length === 0 && !context.published) return { state: 'pending' }

  const allVisible = visible.length === all.length
  const maxScores = all.map((test) => numberOrNull(test.max_score))
  const scores = all.map((test) => numberOrNull(test.score))
  const sum = (values: (number | null)[]) =>
    values.every((value) => value !== null) ? values.reduce<number>((a, b) => a + b!, 0) : null

  const output = context.published ? tail(succeeded.output) : { text: null, truncated: false }

  return {
    state: 'graded',
    // The run's own `score` first: Gradescope's top-level score "overrides
    // total of tests if specified"
    score: allVisible && all.length > 0 ? (succeeded.score ?? sum(scores)) : null,
    maxScore: allVisible && all.length > 0 ? sum(maxScores) : null,
    output: output.text,
    outputTruncated: output.truncated,
    tests: visible.map((test) => {
      const testOutput = tail(typeof test.output === 'string' ? test.output : null)
      return {
        name: typeof test.name === 'string' ? test.name : '—',
        status: typeof test.status === 'string' ? test.status : null,
        score: numberOrNull(test.score),
        maxScore: numberOrNull(test.max_score),
        output: testOutput.text,
        truncated: testOutput.truncated,
      }
    }),
    hiddenTests: all.length - visible.length,
  }
}

/** Newest first, with the deadline applied to each row */
async function listSubmissions(
  repoId: number,
  checkpointId: number,
  deadlineAt: Date | null,
): Promise<SubmissionRow[]> {
  const rows = await db
    .select({
      id: submissions.id,
      sha: submissions.sha,
      ref: submissions.ref,
      aiDeclaration: submissions.aiDeclaration,
      committedAt: submissions.committedAt,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .where(
      and(eq(submissions.assignmentRepoId, repoId), eq(submissions.checkpointId, checkpointId)),
    )
    .orderBy(desc(submissions.id))

  return rows.map((row) => ({
    ...row,
    late: deadlineAt !== null && row.submittedAt.getTime() > deadlineAt.getTime(),
  }))
}

/**
 * The invitation, every one of the assignment's entregas and this student's
 * own repository row, in one query — one result row per entrega, since
 * `checkpoints` is left-joined on the assignment alone.
 *
 * The repository and the checkpoints are left joins on purpose: "no
 * repository yet" and "the teacher has not opened entregas" are different
 * answers, and both have their own message on the screen.
 */
async function loadContext(session: Session, key: string) {
  const userId = Number(session.user.id)

  const rows = await db
    .select({
      repoId: assignmentRepos.id,
      githubRepoId: assignmentRepos.githubRepoId,
      installationId: organizations.installationId,
      invitationsEnabled: assignments.invitationsEnabled,
      archivedAt: organizations.archivedAt,
      checkpointId: checkpoints.id,
      title: checkpoints.title,
      deadlineAt: checkpoints.deadlineAt,
      closedAt: checkpoints.closedAt,
      autograderId: checkpoints.autograderId,
      resultsPublishedAt: checkpoints.resultsPublishedAt,
      exemptionId: submissionExemptions.id,
    })
    .from(assignmentInvitations)
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentInvitations.assignmentId), isNull(assignments.deletedAt)),
    )
    .innerJoin(
      organizations,
      and(eq(organizations.id, assignments.organizationId), isNull(organizations.deletedAt)),
    )
    .leftJoin(
      assignmentRepos,
      and(eq(assignmentRepos.assignmentId, assignments.id), eq(assignmentRepos.userId, userId)),
    )
    .leftJoin(checkpoints, eq(checkpoints.assignmentId, assignments.id))
    // At most one row per checkpoint: the index is unique on (checkpoint, repo)
    .leftJoin(
      submissionExemptions,
      and(
        eq(submissionExemptions.checkpointId, checkpoints.id),
        eq(submissionExemptions.assignmentRepoId, assignmentRepos.id),
        isNull(submissionExemptions.revokedAt),
      ),
    )
    .where(and(eq(assignmentInvitations.key, key), isNull(assignmentInvitations.deletedAt)))
    // `id` breaks a tie on `position` — see the same comment on listCheckpoints
    .orderBy(checkpoints.position, checkpoints.id)

  const [first] = rows
  if (!first) return null

  return {
    repoId: first.repoId,
    githubRepoId: first.githubRepoId,
    installationId: first.installationId,
    invitationsEnabled: first.invitationsEnabled,
    archivedAt: first.archivedAt,
    checkpoints: rows
      .filter((row) => row.checkpointId !== null)
      .map((row) => ({
        id: row.checkpointId!,
        title: row.title,
        deadlineAt: row.deadlineAt,
        closedAt: row.closedAt,
        autograderId: row.autograderId,
        resultsPublishedAt: row.resultsPublishedAt,
        exempt: row.exemptionId !== null,
      })),
  }
}
