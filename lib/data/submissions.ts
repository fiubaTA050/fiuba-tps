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
  disabledReason: string | null
  current: SubmissionRow | null
  /** Every confirmation, newest first. The student argues with data, not memory */
  history: SubmissionRow[]
}

export type CurrentSubmission = {
  sha: string
  submittedAt: Date
  /** `submitted_at` past the checkpoint's deadline. Accepted anyway — it closes nothing */
  late: boolean
}

export type CheckpointSubmissions = {
  id: number
  /** "2A". Null is the single unnamed entrega of an assignment with no parts */
  title: string | null
  deadlineAt: Date | null
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
    .select({ id: checkpoints.id, title: checkpoints.title, deadlineAt: checkpoints.deadlineAt })
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
      checkpointId: submissions.checkpointId,
      githubRepoId: assignmentRepos.githubRepoId,
      sha: submissions.sha,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .innerJoin(assignmentRepos, eq(assignmentRepos.id, submissions.assignmentRepoId))
    .where(inArray(submissions.checkpointId, checkpointIds))
    .orderBy(submissions.assignmentRepoId, submissions.checkpointId, desc(submissions.id))

  const byCheckpoint = new Map<number, Map<number, CurrentSubmission>>(
    checkpointIds.map((id) => [id, new Map()]),
  )

  for (const row of rows) {
    const deadlineAt = deadlineById.get(row.checkpointId)!
    byCheckpoint.get(row.checkpointId)!.set(row.githubRepoId, {
      sha: row.sha,
      submittedAt: row.submittedAt,
      late: deadlineAt !== null && row.submittedAt.getTime() > deadlineAt.getTime(),
    })
  }

  return {
    checkpoints: checkpointRows.map((row) => ({
      id: row.id,
      title: row.title,
      deadlineAt: row.deadlineAt,
      byRepoId: byCheckpoint.get(row.id)!,
    })),
  }
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
    // message still wins if both apply
    if (enabled && checkpoint.closedAt !== null) {
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
      current: null,
      history: [],
    }

    if (context.repoId === null) {
      panels.push(panel)
      continue
    }

    const history = await listSubmissions(context.repoId, checkpoint.id, checkpoint.deadlineAt)
    // Append-only: the current submission is the last row, and the serial id
    // is what breaks the tie — `submitted_at` can repeat
    panels.push({ ...panel, current: history[0] ?? null, history })
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

  if (checkpoint.closedAt !== null) {
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
      })),
  }
}
