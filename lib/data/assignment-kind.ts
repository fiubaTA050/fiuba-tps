import 'server-only'

import { and, eq, isNull } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentRepos,
  assignments,
  checkpoints,
  groupAssignmentRepos,
  groupAssignments,
  organizations,
  organizationsUsers,
  submissionExemptions,
  submissions,
} from '@/db/schema'
import type { AssignmentKind } from '@/lib/assignment-paths'
import { db } from '@/lib/db'

export type { AssignmentKind }

/*
 * `checkpoints`, `submissions` and `submission_exemptions` carry one foreign
 * key per kind of assignment, exactly one of them set — the original's
 * polymorphic `deadlines` with real foreign keys (see `checkpoints` in
 * db/schema.ts). This is where the code that serves both kinds picks the
 * columns.
 */

/** A student's or a team's repository row, by its internal id */
export type RepoRef = { kind: AssignmentKind; id: number }

export const KIND = {
  individual: {
    assignments,
    repos: assignmentRepos,
    reposAssignmentId: assignmentRepos.assignmentId,
    checkpointAssignmentId: checkpoints.assignmentId,
    submissionRepoId: submissions.assignmentRepoId,
    exemptionRepoId: submissionExemptions.assignmentRepoId,
  },
  group: {
    assignments: groupAssignments,
    repos: groupAssignmentRepos,
    reposAssignmentId: groupAssignmentRepos.groupAssignmentId,
    checkpointAssignmentId: checkpoints.groupAssignmentId,
    submissionRepoId: submissions.groupAssignmentRepoId,
    exemptionRepoId: submissionExemptions.groupAssignmentRepoId,
  },
}

/** The foreign key a new checkpoint row carries */
export function checkpointOwner(kind: AssignmentKind, assignmentId: number) {
  return kind === 'group' ? { groupAssignmentId: assignmentId } : { assignmentId }
}

/** The foreign key a new submission or exemption row carries */
export function repoOwner(repo: RepoRef) {
  return repo.kind === 'group'
    ? { groupAssignmentRepoId: repo.id }
    : { assignmentRepoId: repo.id }
}

export type TeachingAssignment = {
  classroom: { id: number; archivedAt: Date | null }
  /** Null when the classroom is the caller's but has no live assignment by that slug */
  assignment: { id: number; title: string; slug: string } | null
}

/**
 * A classroom the session teaches and, in the same query, its live
 * assignment of this kind by slug — `findTeachingClassroom` and the
 * assignment lookup every entrega function needs, in one round trip.
 * Null when the caller does not teach the classroom (DA-4).
 */
export async function findTeachingAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  kind: AssignmentKind,
): Promise<TeachingAssignment | null> {
  const table = KIND[kind].assignments
  const [row] = await db
    .select({
      classroomId: organizations.id,
      archivedAt: organizations.archivedAt,
      assignmentId: table.id,
      title: table.title,
      slug: table.slug,
    })
    .from(organizations)
    .innerJoin(organizationsUsers, eq(organizationsUsers.organizationId, organizations.id))
    .leftJoin(
      table,
      and(
        eq(table.organizationId, organizations.id),
        eq(table.slug, assignmentSlug),
        isNull(table.deletedAt),
      ),
    )
    .where(
      and(
        eq(organizations.slug, classroomSlug),
        eq(organizationsUsers.userId, Number(session.user.id)),
        isNull(organizations.deletedAt),
      ),
    )

  if (!row) return null

  return {
    classroom: { id: row.classroomId, archivedAt: row.archivedAt },
    assignment:
      row.assignmentId === null
        ? null
        : { id: row.assignmentId, title: row.title!, slug: row.slug! },
  }
}
