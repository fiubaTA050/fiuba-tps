import 'server-only'

import {
  type SQLWrapper,
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
} from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentRepos,
  assignments,
  groupAssignments,
  groups,
  groupsUsers,
  organizations,
  organizationsUsers,
  rosterEntries,
  teachingAssistantAllocations,
  teachingAssistantRepoAccesses,
  teachingAssistants,
  users,
} from '@/db/schema'
import { type AssignmentKind, findTeachingAssignment } from '@/lib/data/assignment-kind'
import { type RevokeMemo, revokeAssistantRepoAccess } from '@/lib/data/assistant-repo-access'
import { asFlag, isStudentOf } from '@/lib/data/classroom-students'
import { findTeachingClassroom } from '@/lib/data/organizations'
import { isForeignKeyViolation, isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'
import { type GitHubUserHit, findGitHubUserByLogin, searchGitHubUsers } from '@/lib/github/users'

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

/** One suggestion of the "Agregar ayudante" field */
export type AssistantSuggestion = {
  /** GitHub's numeric account id */
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
  /** Already a TA or a student of another classroom of this teacher */
  known: boolean
  /** Why "Agregar" would be refused, shown greyed out instead of hidden */
  refusal: string | null
}

export type AssistantSuggestions = { suggestions: AssistantSuggestion[]; error: string | null }

/** Below this, a search returns half of GitHub and the field is barely started */
export const SUGGESTION_MIN_QUERY = 2

const KNOWN_LIMIT = 5
const SUGGESTION_LIMIT = 10

/**
 * The suggestions of the "Agregar ayudante" field. No equivalent in the
 * original, which had nobody to add; the field and its behaviour copy the
 * starter code autocomplete (`components/StarterCodeField`).
 *
 * The same trick that one uses to fix GitHub's ranking: what this deployment
 * already knows goes first. GitHub's own people picker favours the accounts
 * you follow and your org's members through an internal endpoint; the public
 * search ranks all of GitHub, so "juan" is mostly strangers. A TA is very
 * often last term's TA or a former student, and both are in `users` already,
 * tied to another classroom of the same teacher — those come first, at no
 * request to GitHub.
 *
 * Accounts that `addTeachingAssistant` would refuse are kept, with the
 * reason: a teacher looking for someone who is a student here is better told
 * so than shown nothing, the same as `/classrooms/new` greys out the orgs it
 * would refuse.
 *
 * Null when the session is not a teacher of the classroom.
 */
export async function suggestTeachingAssistants(
  session: Session,
  classroomSlug: string,
  rawQuery: string,
): Promise<AssistantSuggestions | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const query = rawQuery.trim().replace(/^@/, '').slice(0, 100)
  if (query.length < SUGGESTION_MIN_QUERY) return { suggestions: [], error: null }

  const [known, remote] = await Promise.all([
    knownAccounts(session, query),
    searchGitHubUsers(session, query).then(
      (hits) => ({ hits, error: null }),
      (error: unknown) => {
        console.error('suggestTeachingAssistants: GitHub search failed', error)
        return { hits: [], error: searchErrorMessage(error) }
      },
    ),
  ])

  const knownIds = new Set(known.map((account) => account.id))
  const merged = [
    ...known.map((account) => ({ ...account, known: true })),
    ...remote.hits
      .filter((hit) => !knownIds.has(hit.id))
      .map((hit) => ({ ...hit, known: false })),
  ].slice(0, SUGGESTION_LIMIT)

  if (merged.length === 0) return { suggestions: [], error: remote.error }

  // One query for every candidate: only an account with a `users` row can
  // already be anything in this classroom
  const flagged = await db
    .select({ uid: users.uid, ...refusalFlags(classroom.id, users.id) })
    .from(users)
    .where(
      inArray(
        users.uid,
        merged.map((account) => account.id),
      ),
    )
  const flags = new Map(flagged.map((row) => [row.uid, row]))

  return {
    suggestions: merged.map((account) => {
      const row = flags.get(account.id)
      return { ...account, refusal: row ? refusalMessage(row, account.login) : null }
    }),
    error: remote.error,
  }
}

/**
 * Accounts tied to any classroom this teacher teaches — as a TA, a linked
 * padrón, a repository or a team seat — whose login or stored name matches.
 * TAs first: they are the likeliest to be one again.
 */
async function knownAccounts(session: Session, query: string): Promise<GitHubUserHit[]> {
  const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`

  const mine = db
    .select({ id: organizationsUsers.organizationId })
    .from(organizationsUsers)
    .innerJoin(organizations, eq(organizations.id, organizationsUsers.organizationId))
    .where(
      and(eq(organizationsUsers.userId, Number(session.user.id)), isNull(organizations.deletedAt)),
    )

  const assistantElsewhere = exists(
    db
      .select({ one: teachingAssistants.id })
      .from(teachingAssistants)
      .where(
        and(
          eq(teachingAssistants.userId, users.id),
          inArray(teachingAssistants.organizationId, mine),
        ),
      ),
  )

  const rows = await db
    .select({
      id: users.uid,
      login: users.githubLogin,
      name: users.githubName,
      avatarUrl: users.githubAvatarUrl,
    })
    .from(users)
    .where(
      and(
        isNotNull(users.githubLogin),
        or(ilike(users.githubLogin, pattern), ilike(users.githubName, pattern)),
        or(
          assistantElsewhere,
          exists(
            db
              .select({ one: rosterEntries.id })
              .from(rosterEntries)
              .innerJoin(organizations, eq(organizations.rosterId, rosterEntries.rosterId))
              .where(and(eq(rosterEntries.userId, users.id), inArray(organizations.id, mine))),
          ),
          exists(
            db
              .select({ one: assignmentRepos.id })
              .from(assignmentRepos)
              .innerJoin(assignments, eq(assignments.id, assignmentRepos.assignmentId))
              .where(
                and(
                  eq(assignmentRepos.userId, users.id),
                  inArray(assignments.organizationId, mine),
                ),
              ),
          ),
          exists(
            db
              .select({ one: groupsUsers.userId })
              .from(groupsUsers)
              .innerJoin(groups, eq(groups.id, groupsUsers.groupId))
              .where(and(eq(groupsUsers.userId, users.id), inArray(groups.organizationId, mine))),
          ),
        ),
      ),
    )
    .orderBy(desc(assistantElsewhere), asc(users.githubLogin))
    .limit(KNOWN_LIMIT)

  return rows.map((row) => ({
    id: row.id,
    login: row.login ?? '',
    name: row.name,
    avatarUrl: row.avatarUrl ?? '',
  }))
}

/** The search API is rate limited apart from the rest; saying so beats an empty list */
function searchErrorMessage(error: unknown): string {
  const status = (error as { status?: number }).status
  const limited =
    status === 403 || status === 429 || /rate limit/i.test(String((error as Error)?.message))
  return limited
    ? 'GitHub está limitando las búsquedas. Esperá unos segundos.'
    : 'No pudimos buscar en GitHub. Escribí el usuario completo.'
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
    .select(refusalFlags(organizationId, userId))
    .from(organizations)
    .where(eq(organizations.id, organizationId))

  return refusalMessage(row, login)
}

/** What `staffRefusal` checks, as columns over an id or a `users.id` column */
function refusalFlags(organizationId: number, userId: number | SQLWrapper) {
  return {
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
  }
}

function refusalMessage(
  flags: { teacher: boolean; assistant: boolean; student: boolean },
  login: string,
): string | null {
  if (flags.teacher) return `@${login} ya es profesor de este classroom.`
  if (flags.assistant) return `@${login} ya es ayudante de este classroom.`
  if (flags.student) return `@${login} es alumno de este classroom: no puede ser ayudante.`
  return null
}

/**
 * "Sacar": the account stops being a TA of this classroom, and its
 * allocations go with it (the foreign key cascades). Its devoluciones stay,
 * attributed to it: `submission_feedbacks` points at `users`.
 *
 * Its access to the teams' repositories on GitHub goes first: the rows that
 * record it cascade with the TA, so once it is deleted nothing would know
 * which repositories to take back. If GitHub fails on any, the TA stays and
 * the teacher is told to retry.
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

  const [assistant] = await db
    .select({ id: teachingAssistants.id })
    .from(teachingAssistants)
    .where(
      and(
        eq(teachingAssistants.id, teachingAssistantId),
        eq(teachingAssistants.organizationId, classroom.id),
      ),
    )
  if (!assistant) return { success: false, error: 'Ese ayudante ya no está en el classroom.' }

  const githubFailed = {
    success: false as const,
    error: 'No pudimos sacarle el acceso a los repositorios en GitHub. Probá de nuevo en un rato.',
  }

  // A grant from the TA's own dashboard can land between the revoke and the
  // delete, and would cascade away with the TA, access and all. So the delete
  // runs with the TA's row locked and only if no access is left: a grant
  // recorded first is seen and revoked on the next round, and one that comes
  // after waits on the lock, then finds no TA and takes its own access back.
  const memo: RevokeMemo = {}
  for (let round = 0; round < 3; round++) {
    let failed: number
    try {
      failed = await revokeAssistantRepoAccess(session, classroom.id, assistant.id, null, memo)
    } catch (error) {
      // The lookup of the account by id failed: a rate limit or an outage
      console.error('removeTeachingAssistant: revoke failed', error)
      failed = 1
    }
    if (failed > 0) return githubFailed

    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: teachingAssistants.id })
        .from(teachingAssistants)
        .where(
          and(
            eq(teachingAssistants.id, assistant.id),
            eq(teachingAssistants.organizationId, classroom.id),
          ),
        )
        .for('update')
      // Somebody else removed it first
      if (!locked) return 'gone'

      const [left] = await tx
        .select({ id: teachingAssistantRepoAccesses.id })
        .from(teachingAssistantRepoAccesses)
        .where(eq(teachingAssistantRepoAccesses.teachingAssistantId, locked.id))
        .limit(1)
      if (left) return 'again'

      await tx.delete(teachingAssistants).where(eq(teachingAssistants.id, locked.id))
      return 'removed'
    })

    if (outcome === 'removed') return { success: true }
    if (outcome === 'gone') return { success: false, error: 'Ese ayudante ya no está en el classroom.' }
  }

  // Granted again on every round: they keep reloading the dashboard
  return githubFailed
}

/** A TA as the dashboard's menus offer it */
export type AllocatableAssistant = {
  id: number
  githubLogin: string | null
  /** Keyed by the account id, as on `StaffMember` */
  githubAvatarUrl: string | null
}

/**
 * Who corrects what in one assignment, for the teacher's dashboard. A target
 * is the row the allocation hangs off: a roster entry's id on an individual
 * assignment, a team's id on a group one.
 */
export type AssignmentAllocations = {
  /** Every TA of the classroom, the options of the menus */
  assistants: AllocatableAssistant[]
  /** target id → the ids of the TAs allocated to it */
  byTarget: Map<number, number[]>
}

/**
 * The allocations of one assignment, teacher-only. Null when the caller does
 * not teach the classroom or there is no live assignment by that slug.
 */
export async function listAllocations(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  kind: AssignmentKind,
): Promise<AssignmentAllocations | null> {
  const found = await findTeachingAssignment(session, classroomSlug, assignmentSlug, kind)
  if (!found?.assignment) return null

  const assistants = await db
    .select({
      id: teachingAssistants.id,
      githubLogin: users.githubLogin,
      githubAvatarUrl: users.githubAvatarUrl,
    })
    .from(teachingAssistants)
    .innerJoin(users, eq(users.id, teachingAssistants.userId))
    .where(eq(teachingAssistants.organizationId, found.classroom.id))
    .orderBy(asc(users.githubLogin))

  // Most classrooms have no TAs, and the dashboard shows nothing then: no
  // reason to read allocations that cannot exist
  if (assistants.length === 0) return { assistants, byTarget: new Map() }

  const individual = kind === 'individual'
  const rows = await db
    .select({
      teachingAssistantId: teachingAssistantAllocations.teachingAssistantId,
      target: individual
        ? teachingAssistantAllocations.rosterEntryId
        : teachingAssistantAllocations.groupId,
    })
    .from(teachingAssistantAllocations)
    .where(
      individual
        ? eq(teachingAssistantAllocations.assignmentId, found.assignment.id)
        : eq(teachingAssistantAllocations.groupAssignmentId, found.assignment.id),
    )

  const byTarget = new Map<number, number[]>()
  for (const row of rows) {
    if (row.target === null) continue
    const list = byTarget.get(row.target)
    if (list) list.push(row.teachingAssistantId)
    else byTarget.set(row.target, [row.teachingAssistantId])
  }

  return { assistants, byTarget }
}

/** More rows than any cohort has: a bound on what one request can write */
const MAX_TARGETS = 2000

export type AllocationResult = { success: true } | { success: false; error: string }

/**
 * Allocates one TA to several rows of an assignment, or takes them off —
 * the per-row menu and the bulk bar of the dashboard both land here.
 * Allocating twice is a no-op (the unique indexes), and so is taking off a TA
 * who was not there.
 *
 * Every target must belong to this assignment: a team of the grouping it runs
 * on, or a padrón of the classroom's roster. The second is checked only here —
 * a roster can be shared between classrooms and replaced, so the database has
 * nothing to pin it to (docs/teaching-assistants.md) — and it is what keeps a
 * TA of one classroom from being handed a student of another.
 */
export async function setAllocation(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  kind: AssignmentKind,
  input: { teachingAssistantId: number; targetIds: number[]; allocate: boolean },
): Promise<AllocationResult> {
  const found = await findTeachingAssignment(session, classroomSlug, assignmentSlug, kind)
  if (!found?.assignment) return { success: false, error: 'No se encontró el trabajo práctico.' }
  if (found.classroom.archivedAt) {
    return { success: false, error: 'El classroom está archivado: no se pueden asignar ayudantes.' }
  }

  const targetIds = [...new Set(input.targetIds)]
  if (targetIds.length === 0) return { success: true }
  if (targetIds.length > MAX_TARGETS) {
    return { success: false, error: 'Son demasiadas filas para una sola asignación.' }
  }

  const [assistant] = await db
    .select({ id: teachingAssistants.id })
    .from(teachingAssistants)
    .where(
      and(
        eq(teachingAssistants.id, input.teachingAssistantId),
        eq(teachingAssistants.organizationId, found.classroom.id),
      ),
    )
  if (!assistant) return { success: false, error: 'Ese ayudante ya no está en el classroom.' }

  const individual = kind === 'individual'
  const assignmentId = found.assignment.id

  // The grouping is only needed for a group assignment: the teams must be its
  // own, and the allocation row carries it for the composite foreign keys
  let groupingId: number | null = null
  if (individual) {
    const valid = await db
      .select({ id: rosterEntries.id })
      .from(rosterEntries)
      .innerJoin(organizations, eq(organizations.rosterId, rosterEntries.rosterId))
      .where(and(eq(organizations.id, found.classroom.id), inArray(rosterEntries.id, targetIds)))
    if (valid.length !== targetIds.length) return { success: false, error: goneMessage(kind) }
  } else {
    // The teams of the grouping this assignment runs on, and the grouping
    // with them, in one query
    const valid = await db
      .select({ id: groups.id, groupingId: groups.groupingId })
      .from(groups)
      .innerJoin(groupAssignments, eq(groupAssignments.groupingId, groups.groupingId))
      .where(and(eq(groupAssignments.id, assignmentId), inArray(groups.id, targetIds)))
    if (valid.length !== targetIds.length) return { success: false, error: goneMessage(kind) }
    groupingId = valid[0].groupingId
  }

  if (!input.allocate) {
    await db
      .delete(teachingAssistantAllocations)
      .where(
        and(
          eq(teachingAssistantAllocations.teachingAssistantId, assistant.id),
          individual
            ? and(
                eq(teachingAssistantAllocations.assignmentId, assignmentId),
                inArray(teachingAssistantAllocations.rosterEntryId, targetIds),
              )
            : and(
                eq(teachingAssistantAllocations.groupAssignmentId, assignmentId),
                inArray(teachingAssistantAllocations.groupId, targetIds),
              ),
        ),
      )

    // Their access on GitHub to those teams' repositories goes with it.
    // Best effort: the allocation is gone either way, and what fails keeps
    // its row, so the TA's next visit or the teacher's next change retries it
    if (!individual) {
      try {
        await revokeAssistantRepoAccess(session, found.classroom.id, assistant.id, assignmentId)
      } catch (error) {
        console.error('setAllocation: revoke failed', error)
      }
    }
    return { success: true }
  }

  const base = {
    teachingAssistantId: assistant.id,
    organizationId: found.classroom.id,
    createdByUserId: Number(session.user.id),
  }
  try {
    await db
      .insert(teachingAssistantAllocations)
      .values(
        targetIds.map((target) =>
          individual
            ? { ...base, assignmentId, rosterEntryId: target }
            : { ...base, groupAssignmentId: assignmentId, groupingId, groupId: target },
        ),
      )
      .onConflictDoNothing()
  } catch (error) {
    // A padrón, a team or the TA deleted between the check above and here
    if (isForeignKeyViolation(error)) return { success: false, error: goneMessage(kind) }
    throw error
  }

  return { success: true }
}

function goneMessage(kind: AssignmentKind): string {
  return kind === 'individual'
    ? 'Algún alumno ya no está en la lista. Recargá la página.'
    : 'Algún equipo ya no existe. Recargá la página.'
}
