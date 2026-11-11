import 'server-only'

import { type SQL, and, asc, count, eq, exists, isNull, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentRepos,
  assignments,
  groups,
  groupsUsers,
  organizations,
  organizationsUsers,
  rosterEntries,
  teachingAssistants,
  users,
} from '@/db/schema'
import { findTeachingClassroom } from '@/lib/data/organizations'
import { isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'
import { findGitHubUserByLogin } from '@/lib/github/users'

/**
 * The classroom's staff: its teachers and its teaching assistants, the
 * "TAs and Admins" tab of the live site. See docs/teaching-assistants.md.
 *
 * DA-4: every function takes the session, and all of them are teacher-only —
 * they go through `findTeachingClassroom`, which a TA does not pass.
 */

/** One person on the tab. Login and avatar as last seen in `users` */
export type StaffMember = {
  userId: number
  githubLogin: string | null
}

export type TeachingAssistantItem = StaffMember & {
  /** `teaching_assistants.id`, what "Sacar" posts */
  id: number
  /**
   * Also a teacher of this classroom: a TA later made an owner of the org,
   * linked as a teacher by the classroom index. The teacher role wins
   * (`findClassroomRole`), and this row only matters if they stop being one.
   */
  alsoTeacher: boolean
}

export type ClassroomStaff = {
  teachers: StaffMember[]
  assistants: TeachingAssistantItem[]
}

/** `exists (subquery)` as a selected column: drizzle types the bare one as unknown */
function flag(subquery: Parameters<typeof exists>[0]): SQL<boolean> {
  return sql<boolean>`${exists(subquery)}`
}

/** A GitHub login: alphanumerics and single hyphens, up to 39 characters */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** Port of `organizations#invitation`'s list, plus the TAs of this port */
export async function listClassroomStaff(
  session: Session,
  classroomSlug: string,
): Promise<ClassroomStaff | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [teachers, assistants] = await Promise.all([
    db
      .select({ userId: users.id, githubLogin: users.githubLogin })
      .from(organizationsUsers)
      .innerJoin(users, eq(users.id, organizationsUsers.userId))
      .where(eq(organizationsUsers.organizationId, classroom.id))
      .orderBy(asc(users.githubLogin)),
    db
      .select({
        id: teachingAssistants.id,
        userId: users.id,
        githubLogin: users.githubLogin,
        alsoTeacher: flag(
          db
            .select({ one: organizationsUsers.userId })
            .from(organizationsUsers)
            .where(
              and(
                eq(organizationsUsers.organizationId, classroom.id),
                eq(organizationsUsers.userId, teachingAssistants.userId),
              ),
            ),
        ),
      })
      .from(teachingAssistants)
      .innerJoin(users, eq(users.id, teachingAssistants.userId))
      .where(eq(teachingAssistants.organizationId, classroom.id))
      .orderBy(asc(users.githubLogin)),
  ])

  return { teachers, assistants }
}

/**
 * The counter of the tab. Teachers and TAs together, as the live "TAs and
 * Admins 1" counts everybody on it. Null for anybody but a teacher, who gets
 * no tab at all.
 */
export async function countClassroomStaff(
  session: Session,
  classroomSlug: string,
): Promise<number | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  // Distinct people: a TA who is also a teacher is one person on the tab
  const [row] = await db
    .select({ n: count() })
    .from(
      db
        .select({ userId: organizationsUsers.userId })
        .from(organizationsUsers)
        .where(eq(organizationsUsers.organizationId, classroom.id))
        .union(
          db
            .select({ userId: teachingAssistants.userId })
            .from(teachingAssistants)
            .where(eq(teachingAssistants.organizationId, classroom.id)),
        )
        .as('staff'),
    )

  return row.n
}

export type StaffResult = { success: true; login: string } | { success: false; error: string }

/**
 * "Agregar ayudante": the teacher types a GitHub login and that account
 * becomes a TA of this classroom. No equivalent in the original, which had
 * no way to add anybody — being an owner of the org was the whole invitation.
 *
 * No link, on purpose: nobody turns into a TA by holding a URL. The login is
 * resolved to its numeric id once, here, and the id is what is stored (DA-2),
 * so a later rename of the account does not lose the TA.
 *
 * An account that never signed in gets its `users` row now, from what GitHub
 * says about it; its first login updates it (`auth.ts` upserts on `uid`).
 */
export async function addTeachingAssistant(
  session: Session,
  classroomSlug: string,
  rawLogin: string,
): Promise<StaffResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No se encontró el classroom.' }
  if (classroom.archivedAt) {
    return { success: false, error: 'El classroom está archivado: no se pueden agregar ayudantes.' }
  }

  const login = rawLogin.trim().replace(/^@/, '')
  if (!GITHUB_LOGIN.test(login)) {
    return { success: false, error: `"${login.slice(0, 40)}" no es un usuario de GitHub válido.` }
  }

  const account = await findGitHubUserByLogin(session, login)
  if (!account) return { success: false, error: `No existe la cuenta @${login} en GitHub.` }

  const [user] = await db
    .insert(users)
    .values({
      uid: account.id,
      githubLogin: account.login,
      githubName: account.name,
      githubAvatarUrl: account.avatarUrl,
      githubHtmlUrl: account.htmlUrl,
    })
    // Only the login: the rest is what the account's own sign-in writes, and
    // a rename is the one thing worth catching up on from here
    .onConflictDoUpdate({ target: users.uid, set: { githubLogin: account.login } })
    .returning({ id: users.id })

  const refusal = await staffRefusal(classroom.id, user.id, account.login)
  if (refusal) return { success: false, error: refusal }

  try {
    await db.insert(teachingAssistants).values({
      organizationId: classroom.id,
      userId: user.id,
      createdByUserId: Number(session.user.id),
    })
  } catch (error) {
    // Two teachers adding the same account at once
    if (isUniqueViolation(error)) {
      return { success: false, error: `@${account.login} ya es ayudante de este classroom.` }
    }
    throw error
  }

  return { success: true, login: account.login }
}

/**
 * Why this account cannot be a TA of this classroom, or null if it can.
 *
 * A student cannot: the role would let them read their classmates' entregas.
 * "Student" is anything that ties the account to this classroom's coursework
 * — a linked padrón of its roster, a repository of one of its individual
 * assignments, a seat on one of its teams — whichever came first.
 */
async function staffRefusal(
  organizationId: number,
  userId: number,
  login: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      teacher: flag(
        db
          .select({ one: organizationsUsers.userId })
          .from(organizationsUsers)
          .where(
            and(
              eq(organizationsUsers.organizationId, organizationId),
              eq(organizationsUsers.userId, userId),
            ),
          ),
      ),
      assistant: flag(
        db
          .select({ one: teachingAssistants.id })
          .from(teachingAssistants)
          .where(
            and(
              eq(teachingAssistants.organizationId, organizationId),
              eq(teachingAssistants.userId, userId),
            ),
          ),
      ),
      rostered: flag(
        db
          .select({ one: rosterEntries.id })
          .from(rosterEntries)
          .innerJoin(organizations, eq(organizations.rosterId, rosterEntries.rosterId))
          .where(and(eq(organizations.id, organizationId), eq(rosterEntries.userId, userId))),
      ),
      accepted: flag(
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
      teamed: flag(
        db
          .select({ one: groupsUsers.userId })
          .from(groupsUsers)
          .innerJoin(groups, eq(groups.id, groupsUsers.groupId))
          .where(and(eq(groups.organizationId, organizationId), eq(groupsUsers.userId, userId))),
      ),
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))

  if (row.teacher) return `@${login} ya es profesor de este classroom.`
  if (row.assistant) return `@${login} ya es ayudante de este classroom.`
  if (row.rostered || row.accepted || row.teamed) {
    return `@${login} es alumno de este classroom: no puede ser ayudante.`
  }
  return null
}

/**
 * "Sacar": the account stops being a TA of this classroom, and its
 * allocations go with it (the foreign key cascades). Its devoluciones stay,
 * attributed to it: `submission_feedbacks` points at `users`.
 *
 * Allowed on an archived classroom, unlike every other writer: archiving
 * freezes the coursework, and taking someone's access away is not coursework.
 */
export async function removeTeachingAssistant(
  session: Session,
  classroomSlug: string,
  teachingAssistantId: number,
): Promise<StaffResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No se encontró el classroom.' }

  const [removed] = await db
    .delete(teachingAssistants)
    .where(
      and(
        eq(teachingAssistants.id, teachingAssistantId),
        eq(teachingAssistants.organizationId, classroom.id),
      ),
    )
    .returning({ userId: teachingAssistants.userId })

  // Somebody else removed it first, or the id was never of this classroom
  if (!removed) return { success: false, error: 'Ese ayudante ya no está en el classroom.' }

  const [user] = await db
    .select({ githubLogin: users.githubLogin })
    .from(users)
    .where(eq(users.id, removed.userId))

  return { success: true, login: user?.githubLogin ?? '' }
}
