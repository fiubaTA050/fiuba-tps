import 'server-only'

import { type SQL, type SQLWrapper, and, eq, exists, isNull, or, sql } from 'drizzle-orm'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  groups,
  groupsUsers,
  inviteStatuses,
  organizations,
  rosterEntries,
} from '@/db/schema'
import { db } from '@/lib/db'

/**
 * Whether an account is a student of a classroom, as a boolean SQL expression
 * to select or filter on. The one definition both sides of the TA rule use:
 * `addTeachingAssistant` refuses to make a student a TA, and
 * `findClassroomRole` refuses the TA role to a TA who became a student
 * afterwards — by accepting a TP, claiming a padrón or joining a team, none of
 * which knows TAs exist. A TA who is also a student would read their
 * classmates' entregas. See docs/teaching-assistants.md.
 *
 * "Student" is anything that ties the account to the classroom's coursework,
 * whichever came first:
 *  - a padrón of the classroom's roster linked to it;
 *  - an accepted invitation of one of its individual assignments, with or
 *    without the repository yet (`invite_statuses` is written on accepting);
 *  - a repository of one of them (an account the roster never knew);
 *  - a seat on one of its teams.
 *
 * Either argument is a value or a column, so the same expression serves a
 * lookup by id and a correlated subquery over `organizations` or `users`.
 */
export function isStudentOf(
  organizationId: number | SQLWrapper,
  userId: number | SQLWrapper,
): SQL<boolean> {
  return or(
    exists(
      db
        .select({ one: rosterEntries.id })
        .from(rosterEntries)
        .innerJoin(organizations, eq(organizations.rosterId, rosterEntries.rosterId))
        .where(and(eq(organizations.id, organizationId), eq(rosterEntries.userId, userId))),
    ),
    exists(
      db
        .select({ one: inviteStatuses.id })
        .from(inviteStatuses)
        .innerJoin(
          assignmentInvitations,
          eq(assignmentInvitations.id, inviteStatuses.assignmentInvitationId),
        )
        .innerJoin(assignments, eq(assignments.id, assignmentInvitations.assignmentId))
        .where(
          and(
            eq(assignments.organizationId, organizationId),
            isNull(assignments.deletedAt),
            eq(inviteStatuses.userId, userId),
          ),
        ),
    ),
    exists(
      db
        .select({ one: assignmentRepos.id })
        .from(assignmentRepos)
        .innerJoin(assignments, eq(assignments.id, assignmentRepos.assignmentId))
        .where(
          and(
            eq(assignments.organizationId, organizationId),
            isNull(assignments.deletedAt),
            eq(assignmentRepos.userId, userId),
          ),
        ),
    ),
    exists(
      db
        .select({ one: groupsUsers.userId })
        .from(groupsUsers)
        .innerJoin(groups, eq(groups.id, groupsUsers.groupId))
        .where(and(eq(groups.organizationId, organizationId), eq(groupsUsers.userId, userId))),
    ),
  ) as SQL<boolean>
}

/** A boolean expression as a selected column: drizzle types a bare one as unknown */
export function asFlag(expression: SQL): SQL<boolean> {
  return sql<boolean>`(${expression})`
}
