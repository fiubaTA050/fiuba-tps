import 'server-only'

import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentInvitations,
  assignments,
  groups,
  groupsUsers,
  inviteStatuses,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  users,
} from '@/db/schema'
import { unlinkedEntriesOf } from '@/lib/data/invitations'
import { isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'

/**
 * Roster data layer. DA-4: no query lives outside here, and every function
 * receives the session and filters by user.
 *
 * Port of Orgs::RostersController, the Roster and RosterEntry models,
 * Roster::Creator and the DuplicateRosterEntries concern.
 *
 * What is not ported: the Google Classroom and LTI imports (`import_from_lms`,
 * `sync_google_classroom`), which are the reason most of the original's
 * controller is as long as it is.
 *
 * `roster_entries.user_id` is written from two places, as in the original: the
 * student claims their own identifier on the `join_roster` screen while
 * accepting an assignment (lib/data/invitations.ts), and the teacher repairs
 * the ones nobody claimed with `#link` / `#unlink` below.
 *
 * Like the original, none of this is blocked on an archived classroom: the
 * roster is just a list, nothing here touches GitHub.
 */

/** Roster::Creator::DEFAULT_IDENTIFIER_NAME, translated. The original's was "Identifiers" */
export const DEFAULT_IDENTIFIER_NAME = 'Padrón'

const IDENTIFIER_NAME_MAX_LENGTH = 255
const IDENTIFIER_MAX_LENGTH = 255

/** One row of the roster table */
export type RosterEntryItem = {
  id: number
  identifier: string
  /** The linked GitHub account, null while the entry is unlinked */
  githubLogin: string | null
}

export type RosterView = {
  id: number
  identifierName: string
  entries: RosterEntryItem[]
}

/** How many students the classroom page needs to know about, without loading them */
export type RosterSummary = {
  identifierName: string
  count: number
}

export type RosterResult = { success: true } | { success: false; error: string }

/**
 * The result of adding students: the original's controller says a different
 * thing for each of the three cases, so the counts have to come back.
 * `created < requested` means duplicates were dropped along the way.
 */
export type AddStudentsResult =
  | { success: true; created: number; requested: number }
  | { success: false; error: string }

/**
 * Port of RostersController#show.
 *
 * Returns null when the classroom has no roster — which is the
 * `ensure_current_roster` before_action, redirecting to #new — and also when
 * the classroom is not the teacher's, so the page 404s without leaking
 * whether it exists.
 */
export async function findRoster(
  session: Session,
  classroomSlug: string,
): Promise<RosterView | null> {
  const classroom = await findClassroomRow(session, classroomSlug)
  if (!classroom?.rosterId) return null

  const [roster] = await db
    .select({ id: rosters.id, identifierName: rosters.identifierName })
    .from(rosters)
    .where(eq(rosters.id, classroom.rosterId))

  if (!roster) return null

  // `current_roster.roster_entries.includes(:user).order(:identifier)`. The
  // original paginated here; a cátedra roster is a few hundred rows at most,
  // and pagination costs the teacher the browser's find-in-page.
  const entries = await db
    .select({
      id: rosterEntries.id,
      identifier: rosterEntries.identifier,
      githubLogin: users.githubLogin,
    })
    .from(rosterEntries)
    .leftJoin(users, eq(users.id, rosterEntries.userId))
    .where(eq(rosterEntries.rosterId, roster.id))
    .orderBy(asc(rosterEntries.identifier))

  return { ...roster, entries }
}

/** The roster's size for organizations#show, which lists the classroom's sections */
export async function rosterSummary(
  session: Session,
  classroomSlug: string,
): Promise<RosterSummary | null> {
  const classroom = await findClassroomRow(session, classroomSlug)
  if (!classroom?.rosterId) return null

  const [row] = await db
    .select({
      identifierName: rosters.identifierName,
      count: sql<number>`count(${rosterEntries.id})::int`,
    })
    .from(rosters)
    .leftJoin(rosterEntries, eq(rosterEntries.rosterId, rosters.id))
    .where(eq(rosters.id, classroom.rosterId))
    .groupBy(rosters.identifierName)

  return row ?? null
}

/**
 * Port of Roster::Creator#perform.
 *
 * The original's order:
 *   1. ensure_organization_does_not_have_roster!
 *   2. add_identifiers_to_roster — split, drop blanks, suffix the duplicates
 *   3. save! the roster with its entries, in a transaction
 *   4. organization.update_attributes!(roster: roster)
 *
 * Steps 3 and 4 stay in one transaction for the same reason as there: a roster
 * no classroom points at is unreachable, and `remove_organization` would never
 * collect it.
 */
export async function createRoster(
  session: Session,
  classroomSlug: string,
  input: { identifierName: string; identifiers: string },
): Promise<RosterResult> {
  const classroom = await findClassroomRow(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No encontramos ese classroom.' }

  // ensure_organization_does_not_have_roster!
  if (classroom.rosterId) {
    return { success: false, error: 'Este classroom ya tiene un roster.' }
  }

  const identifierName = input.identifierName.trim()

  // validates :identifier_name, presence: true
  if (identifierName.length === 0) {
    return { success: false, error: 'El nombre del identificador no puede estar vacío.' }
  }
  if (identifierName.length > IDENTIFIER_NAME_MAX_LENGTH) {
    return {
      success: false,
      error: `El nombre del identificador no puede superar los ${IDENTIFIER_NAME_MAX_LENGTH} caracteres.`,
    }
  }

  const identifiers = addSuffixToDuplicates({ identifiers: parseIdentifiers(input.identifiers) })

  // validates :roster_entries, presence: true
  if (identifiers.length === 0) {
    return { success: false, error: 'Agregá al menos un alumno.' }
  }

  const tooLong = identifiers.find((identifier) => identifier.length > IDENTIFIER_MAX_LENGTH)
  if (tooLong) {
    return { success: false, error: identifierTooLongMessage(tooLong) }
  }

  await db.transaction(async (tx) => {
    const [roster] = await tx
      .insert(rosters)
      .values({ identifierName })
      .returning({ id: rosters.id })

    await tx
      .insert(rosterEntries)
      .values(identifiers.map((identifier) => ({ rosterId: roster.id, identifier })))

    await tx
      .update(organizations)
      .set({ rosterId: roster.id, updatedAt: new Date() })
      .where(eq(organizations.id, classroom.id))
  })

  return { success: true }
}

/**
 * Port of RostersController#add_students, which is RosterEntry.create_entries
 * plus the three flash messages the controller picks between.
 *
 * The original inserted row by row inside a transaction and skipped the ones
 * that came back with a duplicate-identifier error. Here the suffixing already
 * ran against the existing identifiers, so a conflict left over is a race with
 * another teacher pasting at the same time: `onConflictDoNothing` drops it, and
 * the count that comes back is what the message is built from.
 */
export async function addStudents(
  session: Session,
  classroomSlug: string,
  rawIdentifiers: string,
): Promise<AddStudentsResult> {
  const roster = await findRosterRow(session, classroomSlug)
  if (!roster) return { success: false, error: 'Este classroom no tiene un roster.' }

  const requested = parseIdentifiers(rawIdentifiers)
  if (requested.length === 0) return { success: true, created: 0, requested: 0 }

  const existing = await db
    .select({ identifier: rosterEntries.identifier })
    .from(rosterEntries)
    .where(eq(rosterEntries.rosterId, roster.id))

  const identifiers = addSuffixToDuplicates({
    identifiers: requested,
    existing: existing.map((entry) => entry.identifier),
  })

  const tooLong = identifiers.find((identifier) => identifier.length > IDENTIFIER_MAX_LENGTH)
  if (tooLong) {
    return { success: false, error: identifierTooLongMessage(tooLong) }
  }

  const created = await db
    .insert(rosterEntries)
    .values(identifiers.map((identifier) => ({ rosterId: roster.id, identifier })))
    .onConflictDoNothing()
    .returning({ id: rosterEntries.id })

  return { success: true, created: created.length, requested: identifiers.length }
}

/**
 * Port of RostersController#edit_entry, with its `check_for_duplicate_entry`
 * before_action. The original renamed to whatever arrived and only refused an
 * identifier already on the roster.
 */
export async function renameEntry(
  session: Session,
  classroomSlug: string,
  entryId: number,
  rawIdentifier: string,
): Promise<RosterResult> {
  const roster = await findRosterRow(session, classroomSlug)
  if (!roster) return { success: false, error: 'Este classroom no tiene un roster.' }

  const identifier = rawIdentifier.trim()

  // validates :identifier, presence: true
  if (identifier.length === 0) {
    return { success: false, error: 'El identificador no puede estar vacío.' }
  }
  if (identifier.length > IDENTIFIER_MAX_LENGTH) {
    return { success: false, error: identifierTooLongMessage(identifier) }
  }

  // ensure_current_roster_entry: the entry has to belong to this roster
  const [entry] = await db
    .select({ id: rosterEntries.id, identifier: rosterEntries.identifier })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.id, entryId), eq(rosterEntries.rosterId, roster.id)))

  if (!entry) return { success: false, error: 'No encontramos a ese alumno en el roster.' }
  if (entry.identifier === identifier) return { success: true }

  // check_for_duplicate_entry
  const [clash] = await db
    .select({ id: rosterEntries.id })
    .from(rosterEntries)
    .where(
      and(eq(rosterEntries.rosterId, roster.id), eq(rosterEntries.identifier, identifier)),
    )

  if (clash) {
    return { success: false, error: `Ya hay un alumno con el identificador "${identifier}".` }
  }

  await db
    .update(rosterEntries)
    .set({ identifier, updatedAt: new Date() })
    .where(eq(rosterEntries.id, entry.id))

  return { success: true }
}

/**
 * Port of RostersController#delete_entry and its
 * `ensure_enough_members_in_roster` before_action: the original refuses to
 * empty the roster, because `validates :roster_entries, presence: true` would
 * leave the classroom holding a roster it could no longer save.
 */
export async function deleteEntry(
  session: Session,
  classroomSlug: string,
  entryId: number,
): Promise<RosterResult> {
  const roster = await findRosterRow(session, classroomSlug)
  if (!roster) return { success: false, error: 'Este classroom no tiene un roster.' }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rosterEntries)
    .where(eq(rosterEntries.rosterId, roster.id))

  if (count <= 1) {
    return {
      success: false,
      error: 'No podés borrar al último alumno del roster. Eliminá el roster entero.',
    }
  }

  const deleted = await db
    .delete(rosterEntries)
    .where(and(eq(rosterEntries.id, entryId), eq(rosterEntries.rosterId, roster.id)))
    .returning({ id: rosterEntries.id })

  if (deleted.length === 0) {
    return { success: false, error: 'No encontramos a ese alumno en el roster.' }
  }

  return { success: true }
}

/**
 * The roster identifiers nobody has claimed, for the teacher's "Link to
 * student" dialog — `current_roster.unlinked_entries` in the original's
 * `_unlinked_user.html.erb:22`.
 *
 * The query itself is `Roster#unlinked_entries`, already ported in
 * lib/data/invitations.ts for the student's own `join_roster` screen. What this
 * adds is the boundary: there it is reached with an invitation key, here with
 * the teacher's membership of the classroom.
 */
export async function listUnlinkedEntries(
  session: Session,
  classroomSlug: string,
): Promise<{ id: number; identifier: string }[]> {
  const roster = await findRosterRow(session, classroomSlug)
  if (!roster) return []

  return unlinkedEntriesOf(roster.id)
}

/** One GitHub account of the classroom that holds no identifier on the roster */
export type UnlinkedAccount = {
  /** `users.id`, which is what #link is authorized against */
  id: number
  /** null if GitHub lost the account — the NullGitHubUser case */
  githubLogin: string | null
}

/**
 * Port of `RostersController#show`'s `@current_unlinked_users`, which fills the
 * "Unlinked GitHub accounts" tab of the roster page.
 *
 * `.order(:id)` is the original's, and it is worth keeping over sorting by
 * login: it puts the accounts in the order they first reached the classroom, so
 * the one that just accepted is at the bottom where the teacher left off. The
 * original paginated; this does not, for the same reason `findRoster` does not.
 */
export async function listUnlinkedAccounts(
  session: Session,
  classroomSlug: string,
): Promise<UnlinkedAccount[]> {
  const classroom = await findClassroomRow(session, classroomSlug)
  if (!classroom?.rosterId) return []

  const ids = await unlinkedUserIdsOf(classroom.id, classroom.rosterId)
  if (ids.size === 0) return []

  return db
    .select({ id: users.id, githubLogin: users.githubLogin })
    .from(users)
    .where(inArray(users.id, [...ids]))
    .orderBy(asc(users.id))
}

/**
 * Port of RostersController#link, which the original reaches from two places
 * that write the same column from opposite sides: `_link_to_student_modal`
 * (a GitHub account, pick an identifier) and `_link_to_github_account_modal`
 * (an identifier, pick an account). Both are ported: the first from the two
 * screens that list the accounts — the roster's "Cuentas de GitHub sin
 * vincular" tab and the assignment dashboard, see the note in AcceptanceList —
 * and the second from the roster's own rows.
 *
 * The original's guard is `raise unless unlinked_user_ids.include?(user_id)`,
 * and it is the whole authorization on the account side: without it a teacher
 * could point one of their entries at any user id in the database. Kept, with
 * the same rescue-into-a-message shape.
 *
 * Two checks the original does not have, both for the same reason as in
 * `linkRosterEntry`: an entry that is already linked is refused rather than
 * silently taken over, and the `WHERE user_id IS NULL` makes the read above
 * decisive when two teachers submit at once.
 */
export async function linkAccountToEntry(
  session: Session,
  classroomSlug: string,
  entryId: number,
  userId: number,
): Promise<RosterResult> {
  const classroom = await findClassroomRow(session, classroomSlug)
  if (!classroom?.rosterId) return { success: false, error: 'Este classroom no tiene un roster.' }

  // ensure_current_roster_entry, scoped to this roster
  const [entry] = await db
    .select({
      id: rosterEntries.id,
      identifier: rosterEntries.identifier,
      userId: rosterEntries.userId,
    })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.id, entryId), eq(rosterEntries.rosterId, classroom.rosterId)))

  if (!entry) return { success: false, error: 'No encontramos a ese alumno en el roster.' }
  if (entry.userId !== null) return { success: false, error: alreadyLinkedMessage(entry.identifier) }

  const unlinked = await unlinkedUserIdsOf(classroom.id, classroom.rosterId)

  if (!unlinked.has(userId)) {
    return {
      success: false,
      error: 'Esa cuenta de GitHub no participa de este classroom, o ya está vinculada.',
    }
  }

  try {
    const updated = await db
      .update(rosterEntries)
      .set({ userId, updatedAt: new Date() })
      .where(and(eq(rosterEntries.id, entry.id), isNull(rosterEntries.userId)))
      .returning({ id: rosterEntries.id })

    if (updated.length === 0) {
      return { success: false, error: alreadyLinkedMessage(entry.identifier) }
    }

    return { success: true }
  } catch (error) {
    // index_roster_entries_on_roster_id_and_user_id: that account already holds
    // another identifier of this roster, claimed while this dialog was open
    if (isUniqueViolation(error)) {
      return { success: false, error: 'Esa cuenta ya está vinculada a otro alumno del roster.' }
    }

    throw error
  }
}

/**
 * Port of RostersController#unlink:
 *
 *   current_roster_entry.update_attributes!(user_id: nil)
 *
 * The original succeeds on an entry that was not linked to begin with — its
 * spec has a `with an unlinked entry` case that expects the same flash — and so
 * does this, for the same reason: the teacher asked for a state, and the state
 * is what they get.
 */
export async function unlinkAccountFromEntry(
  session: Session,
  classroomSlug: string,
  entryId: number,
): Promise<RosterResult> {
  const roster = await findRosterRow(session, classroomSlug)
  if (!roster) return { success: false, error: 'Este classroom no tiene un roster.' }

  const updated = await db
    .update(rosterEntries)
    .set({ userId: null, updatedAt: new Date() })
    .where(and(eq(rosterEntries.id, entryId), eq(rosterEntries.rosterId, roster.id)))
    .returning({ id: rosterEntries.id })

  if (updated.length === 0) {
    return { success: false, error: 'No encontramos a ese alumno en el roster.' }
  }

  return { success: true }
}

/**
 * Port of RostersController#unlinked_user_ids: everyone who took part in the
 * classroom and holds no identifier on its roster.
 *
 * Note that it is the whole classroom, not one assignment —
 * `AssignmentsController#set_unlinked_users` is the per-assignment one, and it
 * only decides which rows are *shown*. This is the one `#link` authorizes with,
 * so a teacher looking at one assignment can still link a student who accepted
 * a different one.
 *
 * Two divergences, both forced by what this port stores:
 *
 *  - Participation in an individual assignment is `invite_statuses`, not
 *    `assignment_repos`. That is the split the whole dashboard rests on: a
 *    student who accepted and whose repository does not exist yet is already
 *    linkable, where the original had to wait for the repo row.
 *  - The group half is `groups_users`, because `repo_accesses` does not exist
 *    here (see AGENTS.md on group assignments).
 */
async function unlinkedUserIdsOf(classroomId: number, rosterId: number): Promise<Set<number>> {
  const accepted = await db
    .selectDistinct({ userId: inviteStatuses.userId })
    .from(inviteStatuses)
    .innerJoin(
      assignmentInvitations,
      eq(assignmentInvitations.id, inviteStatuses.assignmentInvitationId),
    )
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentInvitations.assignmentId), isNull(assignments.deletedAt)),
    )
    .where(
      and(
        eq(assignments.organizationId, classroomId),
        sql`${inviteStatuses.status} <> 'unaccepted'`,
      ),
    )

  const onTeams = await db
    .selectDistinct({ userId: groupsUsers.userId })
    .from(groupsUsers)
    .innerJoin(groups, eq(groups.id, groupsUsers.groupId))
    .where(eq(groups.organizationId, classroomId))

  const linked = await db
    .select({ userId: rosterEntries.userId })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.rosterId, rosterId), isNotNull(rosterEntries.userId)))

  const onRoster = new Set(linked.map((row) => row.userId))

  return new Set(
    [...accepted, ...onTeams].map((row) => row.userId).filter((id) => !onRoster.has(id)),
  )
}

function alreadyLinkedMessage(identifier: string): string {
  return `"${identifier}" ya está vinculado a una cuenta de GitHub.`
}

/**
 * Port of RostersController#remove_organization.
 *
 * Unhooks the roster from the classroom and destroys it only if no other
 * classroom is still pointing at it — the original's
 * `Organization.where(roster_id: current_roster.id).count.zero?`. The entries
 * go with it through `dependent: :destroy`, which here is the FK's ON DELETE
 * CASCADE.
 */
export async function deleteRoster(
  session: Session,
  classroomSlug: string,
): Promise<RosterResult> {
  const classroom = await findClassroomRow(session, classroomSlug)
  if (!classroom?.rosterId) {
    return { success: false, error: 'Este classroom no tiene un roster.' }
  }

  const rosterId = classroom.rosterId

  await db.transaction(async (tx) => {
    await tx
      .update(organizations)
      .set({ rosterId: null, updatedAt: new Date() })
      .where(eq(organizations.id, classroom.id))

    const stillUsed = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.rosterId, rosterId), isNull(organizations.deletedAt)))

    if (stillUsed.length === 0) {
      await tx.delete(rosters).where(eq(rosters.id, rosterId))
    }
  })

  return { success: true }
}

/**
 * Port of RosterEntry.to_csv, called from RostersController#download_roster.
 *
 * The column names are the original's, in English: they are what a script
 * reading the file expects, and the original's own exports are already out
 * there. `group_name` is not among them — it only appears when a grouping is
 * passed, and group assignments are not ported.
 *
 * Returns null when the classroom has no roster, or is not the teacher's.
 */
export async function rosterCsv(
  session: Session,
  classroomSlug: string,
): Promise<string | null> {
  const roster = await findRosterRow(session, classroomSlug)
  if (!roster) return null

  const entries = await db
    .select({
      identifier: rosterEntries.identifier,
      githubLogin: users.githubLogin,
      uid: users.uid,
      githubName: users.githubName,
    })
    .from(rosterEntries)
    .leftJoin(users, eq(users.id, rosterEntries.userId))
    .where(eq(rosterEntries.rosterId, roster.id))
    .orderBy(asc(rosterEntries.identifier))

  const rows = [
    ['identifier', 'github_username', 'github_id', 'name'],
    ...entries.map((entry) => [
      entry.identifier,
      entry.githubLogin ?? '',
      entry.uid === null ? '' : String(entry.uid),
      entry.githubName ?? '',
    ]),
  ]

  // `force_quotes: true`, so a padrón that starts with a zero survives the
  // trip through a spreadsheet and a name with a comma does not split.
  return rows.map((row) => row.map(quote).join(',')).join('\n') + '\n'
}

/**
 * Port of Roster::Creator#add_identifiers_to_roster:
 *
 *   raw_identifiers_string.split("\r\n").reject(&:blank?)
 *
 * Split on \n too: the original only handled the CRLF that a browser sends for
 * a textarea, and lost the line breaks of a file pasted from a Unix editor —
 * turning the whole roster into one entry.
 */
export function parseIdentifiers(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((identifier) => identifier.trim())
    .filter((identifier) => identifier.length > 0)
}

/**
 * Port of the DuplicateRosterEntries concern.
 *
 * A repeated identifier is not rejected, it is suffixed: "John" arriving twice
 * becomes "John" and "John-1". The count includes anything that already starts
 * with `<identifier>-`, so re-pasting the same list keeps climbing instead of
 * colliding with the suffixes of the previous paste.
 */
export function addSuffixToDuplicates({
  identifiers,
  existing = [],
}: {
  identifiers: string[]
  existing?: string[]
}): string[] {
  const result: string[] = []

  for (const raw of identifiers) {
    const identifier = raw.trim()
    const duplicates = [...existing, ...result].filter(
      (entry) => entry === identifier || entry.startsWith(`${identifier}-`),
    )

    result.push(duplicates.length > 0 ? `${identifier}-${duplicates.length}` : identifier)
  }

  return result
}

function identifierTooLongMessage(identifier: string): string {
  return `"${identifier.slice(0, 40)}…" supera los ${IDENTIFIER_MAX_LENGTH} caracteres.`
}

/** RFC 4180 quoting, matching Ruby's CSV with force_quotes: true */
function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * The classroom row, filtered by teacher. Port of
 * Orgs::Controller#ensure_current_organization_visible_to_current_user.
 */
async function findClassroomRow(
  session: Session,
  slug: string,
): Promise<{ id: number; rosterId: number | null } | null> {
  const [row] = await db
    .select({ id: organizations.id, rosterId: organizations.rosterId })
    .from(organizations)
    .innerJoin(organizationsUsers, eq(organizationsUsers.organizationId, organizations.id))
    .where(
      and(
        eq(organizations.slug, slug),
        eq(organizationsUsers.userId, Number(session.user.id)),
        isNull(organizations.deletedAt),
      ),
    )

  return row ?? null
}

/** `current_roster`, already checked against the teacher */
async function findRosterRow(
  session: Session,
  slug: string,
): Promise<{ id: number } | null> {
  const classroom = await findClassroomRow(session, slug)
  return classroom?.rosterId ? { id: classroom.rosterId } : null
}
