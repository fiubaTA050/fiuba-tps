import 'server-only'

import { and, asc, eq, exists } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { organizations, organizationsUsers, teachingAssistants, users } from '@/db/schema'
import { asFlag, isStudentOf } from '@/lib/data/classroom-students'
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

/** One person on the tab, as last seen in `users` */
export type StaffMember = {
  userId: number
  githubLogin: string | null
  /**
   * `avatars.githubusercontent.com/u/<id>`: keyed by the account id, so it
   * stays theirs after a rename. `github.com/<login>.png` would show whoever
   * took the old login until the account signs in again and refreshes it.
   */
  githubAvatarUrl: string | null
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

/**
 * What could be a GitHub login: alphanumerics and hyphens, not starting with
 * one, up to 39 characters. Looser than what GitHub accepts at sign-up today
 * on purpose — older accounts end in a hyphen or carry two in a row — so this
 * only keeps garbage from reaching the API, and GitHub decides the rest.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

/** Port of `organizations#invitation`'s list, plus the TAs of this port */
export async function listClassroomStaff(
  session: Session,
  classroomSlug: string,
): Promise<ClassroomStaff | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [teachers, assistants] = await Promise.all([
    db
      .select({
        userId: users.id,
        githubLogin: users.githubLogin,
        githubAvatarUrl: users.githubAvatarUrl,
      })
      .from(organizationsUsers)
      .innerJoin(users, eq(users.id, organizationsUsers.userId))
      .where(eq(organizationsUsers.organizationId, classroom.id))
      .orderBy(asc(users.githubLogin)),
    db
      .select({
        id: teachingAssistants.id,
        userId: users.id,
        githubLogin: users.githubLogin,
        githubAvatarUrl: users.githubAvatarUrl,
        alsoTeacher: asFlag(
          exists(
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
        ),
      })
      .from(teachingAssistants)
      .innerJoin(users, eq(users.id, teachingAssistants.userId))
      .where(eq(teachingAssistants.organizationId, classroom.id))
      .orderBy(asc(users.githubLogin)),
  ])

  return { teachers, assistants }
}

export type StaffResult = { success: true; login: string } | { success: false; error: string }

export type RemoveResult = { success: true } | { success: false; error: string }

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

  let account
  try {
    account = await findGitHubUserByLogin(session, login)
  } catch (error) {
    // A rate limit or an outage: say so next to the field instead of
    // throwing the teacher onto the error page
    console.error('addTeachingAssistant: GitHub lookup failed', error)
    return { success: false, error: 'No pudimos consultar GitHub. Probá de nuevo en un rato.' }
  }
  if (!account) return { success: false, error: `No existe la cuenta @${login} en GitHub.` }

  // Refused before anything is written: an account with no `users` row cannot
  // be a teacher, a TA or a student of anything, so only an existing row needs
  // the check — and a refusal leaves no row behind for a stranger who never
  // signed in, `last_active_at` and all.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.uid, account.id))
  if (existing) {
    const refusal = await staffRefusal(classroom.id, existing.id, account.login)
    if (refusal) return { success: false, error: refusal }
  }

  const [user] = await db
    .insert(users)
    .values({
      uid: account.id,
      githubLogin: account.login,
      githubName: account.name,
      githubAvatarUrl: account.avatarUrl,
      githubHtmlUrl: account.htmlUrl,
    })
    // Login and avatar only: the rest is what the account's own sign-in
    // writes, and a rename is the one thing worth catching up on from here.
    // Also the backstop for two teachers adding a new account at once.
    .onConflictDoUpdate({
      target: users.uid,
      set: { githubLogin: account.login, githubAvatarUrl: account.avatarUrl },
    })
    .returning({ id: users.id })

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
 * Why this account cannot be a TA of this classroom, or null if it can. A
 * student cannot: the role would let them read their classmates' entregas —
 * `isStudentOf` says what a student is, and `findClassroomRole` applies the
 * same rule to a TA who becomes one later.
 */
async function staffRefusal(
  organizationId: number,
  userId: number,
  login: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      teacher: asFlag(
        exists(
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
      ),
      assistant: asFlag(
        exists(
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
      ),
      student: asFlag(isStudentOf(organizationId, userId)),
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))

  if (row.teacher) return `@${login} ya es profesor de este classroom.`
  if (row.assistant) return `@${login} ya es ayudante de este classroom.`
  if (row.student) return `@${login} es alumno de este classroom: no puede ser ayudante.`
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
): Promise<RemoveResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No se encontró el classroom.' }

  const removed = await db
    .delete(teachingAssistants)
    .where(
      and(
        eq(teachingAssistants.id, teachingAssistantId),
        eq(teachingAssistants.organizationId, classroom.id),
      ),
    )
    .returning({ id: teachingAssistants.id })

  // Somebody else removed it first, or the id was never of this classroom
  if (removed.length === 0) {
    return { success: false, error: 'Ese ayudante ya no está en el classroom.' }
  }

  return { success: true }
}
