import 'server-only'

import { type SQL, and, eq, exists, isNull, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentRepos,
  groupAssignmentRepos,
  organizations,
  rosterEntries,
  teachingAssistantAllocations,
} from '@/db/schema'
import { type AssignmentKind, KIND, findTeachingAssignment } from '@/lib/data/assignment-kind'
import { type StaffAccess, type StaffRole, findStaffClassroom } from '@/lib/data/organizations'
import { db } from '@/lib/db'

/**
 * What the readers a teaching assistant may reach share: the gate that lets
 * one through, and what narrows them to their own rows. A teacher reads every
 * row; a TA only the padrones and teams allocated to them in that assignment
 * (`teaching_assistant_allocations`). See docs/teaching-assistants.md.
 */

/** An assignment the caller may read, in which role, and over which rows */
export type StaffAssignment = {
  role: StaffRole
  classroom: { id: number; archivedAt: Date | null }
  /** Null when the classroom is the caller's but has no live assignment by that slug */
  assignment: { id: number; title: string; slug: string } | null
  /** `teaching_assistants.id` for a TA, null for a teacher */
  teachingAssistantId: number | null
}

/**
 * `findTeachingAssignment`, letting a TA through when the caller opts in —
 * the gate is `findStaffClassroom`. Teacher-only otherwise, and then exactly
 * the one query it always was.
 */
export async function findStaffAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  kind: AssignmentKind,
  access?: StaffAccess,
): Promise<StaffAssignment | null> {
  if (!access?.allowAssistant) {
    const found = await findTeachingAssignment(session, classroomSlug, assignmentSlug, kind)
    return found && { ...found, role: 'teacher', teachingAssistantId: null }
  }

  const classroom = await findStaffClassroom(session, classroomSlug, access)
  if (!classroom) return null

  const table = KIND[kind].assignments
  const [assignment] = await db
    .select({ id: table.id, title: table.title, slug: table.slug })
    .from(table)
    .where(
      and(
        eq(table.organizationId, classroom.id),
        eq(table.slug, assignmentSlug),
        isNull(table.deletedAt),
      ),
    )

  return {
    role: classroom.role,
    classroom: { id: classroom.id, archivedAt: classroom.archivedAt },
    assignment: assignment ?? null,
    teachingAssistantId: classroom.teachingAssistantId,
  }
}

/**
 * Whether the repository row of the current query is one the caller may
 * read: every one for a teacher, and for a TA one of the rows allocated to
 * them in this assignment. To put in the WHERE of a query over `KIND[kind].repos`.
 *
 * An individual repository is reached through its student's padrón: the
 * allocation names the roster entry, and the repository belongs to whichever
 * account is linked to it now — relinking moves the repository, not the TA.
 */
export function visibleRepo(staff: StaffAssignment, kind: AssignmentKind): SQL {
  if (staff.role === 'teacher' || !staff.assignment) {
    return staff.role === 'teacher' ? sql`true` : sql`false`
  }

  const taId = staff.teachingAssistantId!
  const assignmentId = staff.assignment.id

  if (kind === 'group') {
    return exists(
      db
        .select({ one: teachingAssistantAllocations.id })
        .from(teachingAssistantAllocations)
        .where(
          and(
            eq(teachingAssistantAllocations.teachingAssistantId, taId),
            eq(teachingAssistantAllocations.groupAssignmentId, assignmentId),
            eq(teachingAssistantAllocations.groupId, groupAssignmentRepos.groupId),
          ),
        ),
    )
  }

  return exists(
    db
      .select({ one: teachingAssistantAllocations.id })
      .from(teachingAssistantAllocations)
      .innerJoin(rosterEntries, eq(rosterEntries.id, teachingAssistantAllocations.rosterEntryId))
      .innerJoin(organizations, eq(organizations.rosterId, rosterEntries.rosterId))
      .where(
        and(
          eq(teachingAssistantAllocations.teachingAssistantId, taId),
          eq(teachingAssistantAllocations.assignmentId, assignmentId),
          eq(organizations.id, staff.classroom.id),
          eq(rosterEntries.userId, assignmentRepos.userId),
        ),
      ),
  )
}

/**
 * The rows a TA was allocated in this assignment — roster entry ids on an
 * individual one, team ids on a group one — or null for a teacher, who reads
 * all of them. For the readers that list padrones and teams rather than
 * repositories, and filter them in TypeScript.
 */
export async function allocatedTargets(
  staff: StaffAssignment,
  kind: AssignmentKind,
): Promise<Set<number> | null> {
  if (staff.role === 'teacher') return null
  if (!staff.assignment) return new Set()

  const rows = await db
    .select({
      target:
        kind === 'group'
          ? teachingAssistantAllocations.groupId
          : teachingAssistantAllocations.rosterEntryId,
    })
    .from(teachingAssistantAllocations)
    .where(
      and(
        eq(teachingAssistantAllocations.teachingAssistantId, staff.teachingAssistantId!),
        kind === 'group'
          ? eq(teachingAssistantAllocations.groupAssignmentId, staff.assignment.id)
          : eq(teachingAssistantAllocations.assignmentId, staff.assignment.id),
      ),
    )

  return new Set(rows.flatMap((row) => (row.target === null ? [] : [row.target])))
}
