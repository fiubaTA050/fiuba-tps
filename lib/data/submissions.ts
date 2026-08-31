import 'server-only'

import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  checkpoints,
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
  committedAt: Date
  submittedAt: Date
  /** `submitted_at` past the deadline. Accepted anyway — it closes nothing */
  late: boolean
}

export type SubmissionPanel = {
  /** Null when the teacher has not opened entregas: no checkpoint, nothing to hand in */
  deadlineAt: Date | null
  /** Read on the server: the screen must not decide "late" off the viewer's clock */
  overdue: boolean
  hasCheckpoint: boolean
  /** AssignmentInvitation#enabled?, the only thing that actually closes entregas */
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

export type AssignmentSubmissions = {
  /** Null when the teacher has not opened entregas — nothing to confirm yet */
  checkpoint: { id: number; deadlineAt: Date | null } | null
  /** Keyed by the GitHub repo id — the same key `listRepositorySnapshots` and
   *  `AssignmentAcceptances` use, not the internal `assignment_repos.id` */
  byRepoId: Map<number, CurrentSubmission>
}

/**
 * The current submission of every repository on an assignment's single
 * checkpoint, for the teacher dashboard.
 *
 * "Current" is the literal latest row by id, late or not — the same reading
 * `findSubmissionPanel` gives the student as `current`. Serves the
 * `distinct on` that `index_submissions_on_repo_and_checkpoint`'s comment
 * anticipates.
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

  const [checkpoint] = await db
    .select({ id: checkpoints.id, deadlineAt: checkpoints.deadlineAt })
    .from(checkpoints)
    .innerJoin(assignments, eq(assignments.id, checkpoints.assignmentId))
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignments.deletedAt),
        isNull(checkpoints.title),
      ),
    )

  if (!checkpoint) return { checkpoint: null, byRepoId: new Map() }

  const rows = await db
    .selectDistinctOn([submissions.assignmentRepoId], {
      githubRepoId: assignmentRepos.githubRepoId,
      sha: submissions.sha,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .innerJoin(assignmentRepos, eq(assignmentRepos.id, submissions.assignmentRepoId))
    .where(eq(submissions.checkpointId, checkpoint.id))
    .orderBy(submissions.assignmentRepoId, desc(submissions.id))

  const byRepoId = new Map(
    rows.map((row) => [
      row.githubRepoId,
      {
        sha: row.sha,
        submittedAt: row.submittedAt,
        late:
          checkpoint.deadlineAt !== null && row.submittedAt.getTime() > checkpoint.deadlineAt.getTime(),
      },
    ]),
  )

  return { checkpoint, byRepoId }
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
const COOLDOWN_MS = 10_000

const MAX_REF_LENGTH = 255

/** What the setup screen needs, in one query plus the submissions of this repo */
export async function findSubmissionPanel(
  session: Session,
  key: string,
): Promise<SubmissionPanel | null> {
  const context = await loadContext(session, key)
  if (!context) return null

  const { enabled, disabledReason } = disabledState(context.invitationsEnabled, context.archivedAt)

  const base: SubmissionPanel = {
    deadlineAt: context.deadlineAt,
    overdue: context.deadlineAt !== null && context.deadlineAt.getTime() < Date.now(),
    hasCheckpoint: context.checkpointId !== null,
    enabled,
    disabledReason,
    current: null,
    history: [],
  }

  if (context.repoId === null || context.checkpointId === null) return base

  const history = await listSubmissions(context.repoId, context.checkpointId, context.deadlineAt)

  // Append-only: the current submission is the last row, and the serial id is
  // what breaks the tie — `submitted_at` can repeat
  return { ...base, current: history[0] ?? null, history }
}

/**
 * One repo's full submission history, teacher-facing — fetched on demand
 * when a dashboard row is expanded, not eagerly for the whole cohort. A
 * single repo can carry many confirmations (the cooldown limits the rate,
 * not the count — see docs/entregas.md), which would otherwise inflate
 * every teacher's page load for rows nobody opens.
 */
export async function findSubmissionHistory(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  githubRepoId: number,
): Promise<SubmissionRow[] | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [row] = await db
    .select({
      repoId: assignmentRepos.id,
      checkpointId: checkpoints.id,
      deadlineAt: checkpoints.deadlineAt,
    })
    .from(assignmentRepos)
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentRepos.assignmentId), isNull(assignments.deletedAt)),
    )
    .innerJoin(
      checkpoints,
      and(eq(checkpoints.assignmentId, assignments.id), isNull(checkpoints.title)),
    )
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        eq(assignmentRepos.githubRepoId, githubRepoId),
      ),
    )

  // No checkpoint, or this repo isn't this assignment's — nothing to show,
  // never "not yours to see" (that classroom check already happened above)
  if (!row) return []

  return listSubmissions(row.repoId, row.checkpointId, row.deadlineAt)
}

/**
 * The student confirms a ref as their submission.
 *
 * The deadline is deliberately **not** a rejection: late submissions are
 * accepted and read as `Tarde`. What closes entregas is the assignment going
 * Inactive, which is the lever the teacher already has.
 */
export async function confirmSubmission(
  session: Session,
  key: string,
  ref: string,
): Promise<ConfirmSubmissionResult> {
  const trimmed = ref.trim()

  if (trimmed.length === 0) {
    return { success: false, error: 'Escribí una rama, un tag o un commit de tu repositorio.' }
  }

  if (trimmed.length > MAX_REF_LENGTH) {
    return { success: false, error: 'Ese ref es demasiado largo.' }
  }

  const context = await loadContext(session, key)
  if (!context) return { success: false, error: 'No encontramos ese trabajo práctico.' }

  const { enabled, disabledReason } = disabledState(context.invitationsEnabled, context.archivedAt)
  if (!enabled) return { success: false, error: disabledReason! }

  if (context.checkpointId === null) {
    return { success: false, error: 'El docente todavía no habilitó las entregas.' }
  }

  if (context.repoId === null || context.githubRepoId === null) {
    return { success: false, error: 'Todavía no tenés un repositorio para este trabajo práctico.' }
  }

  const [last] = await db
    .select({ sha: submissions.sha, submittedAt: submissions.submittedAt })
    .from(submissions)
    .where(
      and(
        eq(submissions.assignmentRepoId, context.repoId),
        eq(submissions.checkpointId, context.checkpointId),
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

  // The double click. Confirming the same tree twice is not a new submission,
  // which is what makes the unique index the first design wanted unnecessary
  if (last?.sha === sha) {
    return { success: true, sha, unchanged: true, warning: null }
  }

  await db.insert(submissions).values({
    assignmentRepoId: context.repoId,
    checkpointId: context.checkpointId,
    sha,
    ref: trimmed,
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
 * The invitation, the assignment's single entrega and this student's own
 * repository row, in one query.
 *
 * The repository and the checkpoint are left joins on purpose: "no repository
 * yet" and "the teacher has not opened entregas" are different answers, and
 * both have their own message on the screen.
 */
async function loadContext(session: Session, key: string) {
  const userId = Number(session.user.id)

  const [row] = await db
    .select({
      repoId: assignmentRepos.id,
      githubRepoId: assignmentRepos.githubRepoId,
      installationId: organizations.installationId,
      invitationsEnabled: assignments.invitationsEnabled,
      archivedAt: organizations.archivedAt,
      checkpointId: checkpoints.id,
      deadlineAt: checkpoints.deadlineAt,
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
    .leftJoin(
      checkpoints,
      and(eq(checkpoints.assignmentId, assignments.id), isNull(checkpoints.title)),
    )
    .where(and(eq(assignmentInvitations.key, key), isNull(assignmentInvitations.deletedAt)))

  return row ?? null
}
