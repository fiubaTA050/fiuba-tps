import 'server-only'

import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  inviteStatuses,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  users,
  type InviteStatusValue,
} from '@/db/schema'
import { isUniqueViolation } from '@/lib/data/postgres'
import { db } from '@/lib/db'

/**
 * The student's side of an assignment. Port of
 * AssignmentInvitationsController, InvitationsControllerMethods#join_roster,
 * AssignmentInvitation#redeem_for and AssignmentInvitation#status.
 *
 * DA-4 says every function here takes the session and filters by user, and it
 * still does — but the filter is a different one, and copying the pattern of
 * the neighbouring modules would be wrong. Everywhere else the actor is a
 * teacher and the boundary is the join against `organizations_users`: you only
 * ever see a classroom you teach. Here the actor is a **student**, who teaches
 * nothing and belongs to no classroom, so that join would deny everyone.
 *
 * What authorizes a student is the invitation key itself. It is 16 random
 * bytes (`SecureRandom.hex(16)` in the original's `assign_key`, `randomBytes`
 * in ours), it is unguessable, and holding it is exactly what the teacher
 * grants by sharing the link — the original's route is equally open, its only
 * before_action being authentication. So the key selects the assignment, and
 * the session selects the rows *within* it that belong to the caller: their
 * `invite_statuses` row, their `roster_entries` row. Nothing here ever returns
 * another student's row, and nothing lets a student reach a classroom whose
 * key they do not hold.
 *
 * The one teacher-facing function, `listAssignmentAcceptances`, keeps the old
 * boundary and says so.
 */

/** AssignmentInvitation::INVITATIONS_DISABLED */
export const INVITATIONS_DISABLED = 'Las invitaciones para este assignment están deshabilitadas.'

/** AssignmentInvitation::INVITATIONS_DISABLED_ARCHIVED */
export const INVITATIONS_DISABLED_ARCHIVED =
  'Las invitaciones para este assignment están deshabilitadas porque el classroom está archivado.'

/** Everything the student's screens render, for one invitation and one student */
export type StudentInvitation = {
  assignmentTitle: string
  /** Prefixes the repo that will be created: `<slug>-<login>` */
  assignmentSlug: string
  /** AssignmentInvitation#enabled? */
  enabled: boolean
  /** Which of the two reasons of #reason_for_disabled_invitations applies */
  disabledReason: string | null
  /** InviteStatus#status. `unaccepted` when there is no row, see db/schema.ts */
  status: InviteStatusValue
  classroom: { title: string; installationId: number }
  /** The classroom's roster, null when it has none */
  roster: { id: number; identifierName: string } | null
  /** The entry this student already holds on that roster, null while unlinked */
  rosterEntry: { id: number; identifier: string } | null
}

export type AcceptResult =
  | { success: true; status: InviteStatusValue }
  | { success: false; error: string }

export type JoinRosterResult =
  | { success: true; identifier: string }
  | { success: false; error: string }

/**
 * Port of `current_invitation` + `current_invitation_status` + the
 * `organization`/`assignment` helpers, in one query.
 *
 * Returns null when the key matches nothing, which is the original's
 * `find_by!` raising RecordNotFound, and also when the assignment, the
 * invitation or the classroom is soft-deleted — the `default_scope` of all
 * three. The page answers 404 either way, without saying which.
 */
export async function findInvitation(
  session: Session,
  key: string,
): Promise<StudentInvitation | null> {
  const row = await findInvitationRow(session, key)
  return row && toStudentInvitation(row)
}

/**
 * The same read, keeping the ids the writers need. Private: `id` is the
 * database's, and no screen has any business holding it — the key is what
 * identifies an invitation everywhere outside this module, exactly as
 * `AssignmentInvitation#to_param` decided.
 */
async function findInvitationRow(session: Session, key: string) {
  const userId = Number(session.user.id)

  const [row] = await db
    .select({
      id: assignmentInvitations.id,
      assignmentTitle: assignments.title,
      assignmentSlug: assignments.slug,
      invitationsEnabled: assignments.invitationsEnabled,
      classroomTitle: organizations.title,
      installationId: organizations.installationId,
      archivedAt: organizations.archivedAt,
      rosterId: rosters.id,
      identifierName: rosters.identifierName,
      status: inviteStatuses.status,
      rosterEntryId: rosterEntries.id,
      rosterEntryIdentifier: rosterEntries.identifier,
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
    .leftJoin(rosters, eq(rosters.id, organizations.rosterId))
    // Scoped to the caller: their status row and their entry, never anyone
    // else's. This is the "filters by user" half of DA-4 for a student.
    .leftJoin(
      inviteStatuses,
      and(
        eq(inviteStatuses.assignmentInvitationId, assignmentInvitations.id),
        eq(inviteStatuses.userId, userId),
      ),
    )
    .leftJoin(
      rosterEntries,
      and(eq(rosterEntries.rosterId, rosters.id), eq(rosterEntries.userId, userId)),
    )
    .where(and(eq(assignmentInvitations.key, key), isNull(assignmentInvitations.deletedAt)))

  return row ?? null
}

function toStudentInvitation(
  row: NonNullable<Awaited<ReturnType<typeof findInvitationRow>>>,
): StudentInvitation {
  return {
    assignmentTitle: row.assignmentTitle,
    assignmentSlug: row.assignmentSlug,
    ...disabledState(row.invitationsEnabled, row.archivedAt),
    // No row means the student never accepted. The original wrote an
    // `unaccepted` row on the way past instead; see db/schema.ts.
    status: row.status ?? 'unaccepted',
    classroom: { title: row.classroomTitle, installationId: row.installationId },
    roster:
      row.rosterId === null || row.identifierName === null
        ? null
        : { id: row.rosterId, identifierName: row.identifierName },
    rosterEntry:
      row.rosterEntryId === null || row.rosterEntryIdentifier === null
        ? null
        : { id: row.rosterEntryId, identifier: row.rosterEntryIdentifier },
  }
}

/**
 * Port of Roster#unlinked_entries, which is what `_shared_join_roster` lists.
 *
 * Sorted by identifier like the view's `sort_by(&:identifier)`. Reachable only
 * with the invitation key, and it exposes nothing but the identifiers the
 * teacher already pasted — no GitHub account is named, precisely because these
 * are the entries that have none.
 */
export async function listUnlinkedRosterEntries(
  session: Session,
  key: string,
): Promise<{ id: number; identifier: string }[]> {
  const invitation = await findInvitation(session, key)
  if (!invitation?.roster) return []

  return unlinkedEntriesOf(invitation.roster.id)
}

/**
 * The same list for a roster already resolved. Shared with the group flow,
 * whose `join_roster` screen is the same one — `_shared_join_roster` in the
 * original, rendered by both invitation controllers.
 */
export async function unlinkedEntriesOf(
  rosterId: number,
): Promise<{ id: number; identifier: string }[]> {
  return db
    .select({ id: rosterEntries.id, identifier: rosterEntries.identifier })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.rosterId, rosterId), isNull(rosterEntries.userId)))
    .orderBy(asc(rosterEntries.identifier))
}

/**
 * Port of AssignmentInvitationsController#accept together with
 * AssignmentInvitation#redeem_for.
 *
 * The original's `redeem_for` returns :success when an AssignmentRepo already
 * exists, and :pending otherwise — and :pending is the only outcome reachable
 * here, because nothing creates repositories yet. So this is the `when
 * :pending` branch: `current_invitation_status.accepted!`.
 *
 * Divergence, per the decision recorded for this port: the check on
 * `enabled?` also runs when the page is rendered, so a student never sees a
 * button that is going to fail. It stays here as well, because the render is
 * advisory and this is the boundary.
 */
export async function acceptInvitation(session: Session, key: string): Promise<AcceptResult> {
  const invitation = await findInvitationRow(session, key)
  if (!invitation) return { success: false, error: 'No encontramos esa invitación.' }

  const { enabled, disabledReason } = disabledState(
    invitation.invitationsEnabled,
    invitation.archivedAt,
  )

  // reason_for_disabled_invitations
  if (!enabled) return { success: false, error: disabledReason ?? INVITATIONS_DISABLED }

  const [row] = await db
    .insert(inviteStatuses)
    .values({
      assignmentInvitationId: invitation.id,
      userId: Number(session.user.id),
      status: 'accepted',
    })
    // Accepting twice is one double-click away, and the second one must not
    // walk the status backwards: once the repository job exists, a student
    // sitting on `creating_repo` who reloads would be sent back to `accepted`
    // and get a second repository. Only an `unaccepted` row moves.
    .onConflictDoUpdate({
      target: [inviteStatuses.assignmentInvitationId, inviteStatuses.userId],
      set: { status: 'accepted', updatedAt: new Date() },
      setWhere: eq(inviteStatuses.status, 'unaccepted'),
    })
    .returning({ status: inviteStatuses.status })

  // `setWhere` filtering the row out returns nothing: the student had already
  // accepted, and the state they were already in is the one to report.
  return { success: true, status: row?.status ?? invitation.status ?? 'accepted' }
}

/** `current_invitation.status(current_user).status`, for the progress endpoint */
export async function currentStatus(session: Session, key: string): Promise<InviteStatusValue> {
  const invitation = await findInvitationRow(session, key)
  return invitation?.status ?? 'unaccepted'
}

/**
 * Port of InvitationsControllerMethods#join_roster:
 *
 *   entry = organization.roster.roster_entries.find(params[:roster_entry_id])
 *   entry.update_attributes!(user: current_user) unless user_on_roster?
 *
 * Two divergences, both in the guard:
 *
 *  - The original's `unless user_on_roster?` only asks whether *the student*
 *    already claimed an entry, never whether *the entry* is already claimed.
 *    A student who picks somebody else's padrón takes it over and the rightful
 *    owner is silently unlinked. Here that case is refused and says so.
 *  - The no-op branch is kept: a student who already holds an entry and picks
 *    another one is not moved, and the message names the entry they hold, the
 *    same as the original's flash.
 */
export async function joinRoster(
  session: Session,
  key: string,
  entryId: number,
): Promise<JoinRosterResult> {
  const invitation = await findInvitation(session, key)
  if (!invitation) return { success: false, error: 'No encontramos esa invitación.' }

  return linkRosterEntry(session, invitation.roster, invitation.rosterEntry, entryId)
}

/**
 * The body of #join_roster, for a roster already resolved.
 *
 * Shared with the group flow: `InvitationsControllerMethods#join_roster` is a
 * concern in the original precisely because both invitation controllers
 * include it, and the only thing that differs is which invitation was used to
 * find the classroom.
 */
export async function linkRosterEntry(
  session: Session,
  roster: { id: number } | null,
  currentEntry: { identifier: string } | null,
  entryId: number,
): Promise<JoinRosterResult> {
  if (!roster) {
    return { success: false, error: 'Este classroom no tiene un roster.' }
  }

  // user_on_roster? — already linked, nothing to do
  if (currentEntry) {
    return { success: true, identifier: currentEntry.identifier }
  }

  // `roster_entries.find(...)` raising RecordNotFound, which the original's
  // rescue turns into "An error occurred, please try again!"
  const [entry] = await db
    .select({
      id: rosterEntries.id,
      identifier: rosterEntries.identifier,
      userId: rosterEntries.userId,
    })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.id, entryId), eq(rosterEntries.rosterId, roster.id)))

  if (!entry) {
    return { success: false, error: 'No encontramos ese identificador en el roster.' }
  }

  if (entry.userId !== null) {
    return { success: false, error: takenMessage(entry.identifier) }
  }

  try {
    // `WHERE user_id IS NULL` makes the read above decisive instead of
    // advisory: two students submitting the same padrón at the same moment
    // both pass the check, and only one of these updates matches a row.
    const updated = await db
      .update(rosterEntries)
      .set({ userId: Number(session.user.id), updatedAt: new Date() })
      .where(and(eq(rosterEntries.id, entry.id), isNull(rosterEntries.userId)))
      .returning({ identifier: rosterEntries.identifier })

    if (updated.length === 0) {
      return { success: false, error: takenMessage(entry.identifier) }
    }

    return { success: true, identifier: updated[0].identifier }
  } catch (error) {
    // index_roster_entries_on_roster_id_and_user_id: the student raced with
    // themselves — two tabs, two padrones — and already holds another entry.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: 'Ya estás vinculado a otro identificador de este roster.',
      }
    }

    throw error
  }
}

/** Which state a roster entry is in for one assignment, in the original's order */
export type AcceptanceState =
  /** orgs/roster_entries/assignment_repos/_linked_accepted */
  | 'accepted'
  /** _linked_not_accepted: the account is linked, the assignment is not accepted */
  | 'linked_not_accepted'
  /** _not_in_classroom: nobody claimed this identifier yet */
  | 'not_joined'

export type AcceptanceRow = {
  entryId: number
  identifier: string
  githubLogin: string | null
  state: AcceptanceState
  /**
   * The student's repository on GitHub, null while none exists — accepted but
   * still being created, or never accepted at all. DA-2: the id is all that is
   * stored, the dashboard resolves it at render time.
   */
  repoId: number | null
}

/** A student who accepted without claiming an identifier on the roster */
export type UnlinkedAcceptance = {
  userId: number
  githubLogin: string | null
  repoId: number | null
}

export type AssignmentAcceptances = {
  /** The roster's column header, null when the classroom has no roster */
  identifierName: string | null
  /** One row per roster entry, accepted first. Empty when there is no roster */
  entries: AcceptanceRow[]
  /**
   * The live site's "Unlinked GitHub accounts" tab: students who accepted but
   * hold no entry, because they skipped `join_roster` or because the classroom
   * has no roster at all — in which case this is simply everyone who accepted.
   */
  unlinkedAccounts: UnlinkedAcceptance[]
  /** How many students accepted, roster entry or not */
  acceptedCount: number
}

/**
 * Port of the `@roster_entries` / `@assignment_repos` / `@unlinked_user_repos`
 * of AssignmentsController#show, with `RosterEntry.order_for_view`.
 *
 * Teacher-facing, so the boundary is the one every other module uses: the join
 * against `organizations_users`. Returns null when the classroom or the
 * assignment is not this teacher's, and the page 404s.
 *
 * The original keyed all of this off `assignment_repos`, the table that only
 * exists once a repository does. Here it is `invite_statuses`, which is where
 * the acceptance is recorded — that is the whole point of the split, and it is
 * why the teacher can see an acceptance before any repo exists.
 */
export async function listAssignmentAcceptances(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<AssignmentAcceptances | null> {
  const [classroom] = await db
    .select({
      id: organizations.id,
      rosterId: organizations.rosterId,
      identifierName: rosters.identifierName,
    })
    .from(organizations)
    .innerJoin(organizationsUsers, eq(organizationsUsers.organizationId, organizations.id))
    .leftJoin(rosters, eq(rosters.id, organizations.rosterId))
    .where(
      and(
        eq(organizations.slug, classroomSlug),
        eq(organizationsUsers.userId, Number(session.user.id)),
        isNull(organizations.deletedAt),
      ),
    )

  if (!classroom) return null

  const [invitation] = await db
    .select({ id: assignmentInvitations.id, assignmentId: assignments.id })
    .from(assignmentInvitations)
    .innerJoin(
      assignments,
      and(eq(assignments.id, assignmentInvitations.assignmentId), isNull(assignments.deletedAt)),
    )
    .where(
      and(
        eq(assignments.organizationId, classroom.id),
        eq(assignments.slug, assignmentSlug),
        isNull(assignmentInvitations.deletedAt),
      ),
    )

  if (!invitation) return null

  // Everyone who accepted, whatever they did about the roster
  const accepted = await db
    .select({
      userId: inviteStatuses.userId,
      githubLogin: users.githubLogin,
      repoId: assignmentRepos.githubRepoId,
    })
    .from(inviteStatuses)
    .innerJoin(users, eq(users.id, inviteStatuses.userId))
    // Null until the student's browser finishes creating it — the whole point
    // of keying this list off invite_statuses instead of assignment_repos
    .leftJoin(
      assignmentRepos,
      and(
        eq(assignmentRepos.assignmentId, invitation.assignmentId),
        eq(assignmentRepos.userId, inviteStatuses.userId),
      ),
    )
    .where(
      and(
        eq(inviteStatuses.assignmentInvitationId, invitation.id),
        // A row that is still `unaccepted` cannot exist today, and will once
        // the repository job writes one before the student accepts
        sql`${inviteStatuses.status} <> 'unaccepted'`,
      ),
    )

  if (classroom.rosterId === null) {
    return {
      identifierName: null,
      entries: [],
      unlinkedAccounts: accepted,
      acceptedCount: accepted.length,
    }
  }

  const entries = await db
    .select({
      entryId: rosterEntries.id,
      identifier: rosterEntries.identifier,
      userId: rosterEntries.userId,
      githubLogin: users.githubLogin,
      statusId: inviteStatuses.id,
      repoId: assignmentRepos.githubRepoId,
    })
    .from(rosterEntries)
    .leftJoin(users, eq(users.id, rosterEntries.userId))
    .leftJoin(
      assignmentRepos,
      and(
        eq(assignmentRepos.assignmentId, invitation.assignmentId),
        eq(assignmentRepos.userId, rosterEntries.userId),
      ),
    )
    // The LEFT JOIN of `order_for_view`, against invite_statuses instead of
    // assignment_repos: a match means this entry's account accepted *this*
    // assignment.
    .leftJoin(
      inviteStatuses,
      and(
        eq(inviteStatuses.userId, rosterEntries.userId),
        eq(inviteStatuses.assignmentInvitationId, invitation.id),
        sql`${inviteStatuses.status} <> 'unaccepted'`,
      ),
    )
    .where(eq(rosterEntries.rosterId, classroom.rosterId))
    // RosterEntry.order_for_view: accepted, then linked but not accepted, then
    // unlinked. Identifier breaks the tie, where the original used the id —
    // a roster of padrones reads better in padrón order.
    .orderBy(
      sql`case
        when ${rosterEntries.userId} is null then 2
        when ${inviteStatuses.id} is not null then 0
        else 1
      end`,
      asc(rosterEntries.identifier),
    )

  // Keyed on the user id, not the login: a student who renames their GitHub
  // account keeps the id, and DA-2 says never to key anything on a name.
  const onRoster = new Set(entries.map((entry) => entry.userId))

  return {
    identifierName: classroom.identifierName,
    entries: entries.map((entry) => ({
      entryId: entry.entryId,
      identifier: entry.identifier,
      githubLogin: entry.githubLogin,
      state: acceptanceState(entry.userId, entry.statusId),
      repoId: entry.repoId,
    })),
    unlinkedAccounts: accepted.filter((account) => !onRoster.has(account.userId)),
    acceptedCount: accepted.length,
  }
}

/** The three branches of Orgs::RosterEntriesController#show, in its order */
function acceptanceState(userId: number | null, statusId: number | null): AcceptanceState {
  if (userId === null) return 'not_joined'
  return statusId === null ? 'linked_not_accepted' : 'accepted'
}

function takenMessage(identifier: string): string {
  return (
    `El identificador "${identifier}" ya está vinculado a otra cuenta de GitHub. ` +
    'Si es tuyo, escribile al docente.'
  )
}

/** AssignmentInvitation#enabled? and #reason_for_disabled_invitations */
export function disabledState(
  invitationsEnabled: boolean,
  archivedAt: Date | null,
): { enabled: boolean; disabledReason: string | null } {
  if (!invitationsEnabled) {
    return { enabled: false, disabledReason: INVITATIONS_DISABLED }
  }

  if (archivedAt) {
    return { enabled: false, disabledReason: INVITATIONS_DISABLED_ARCHIVED }
  }

  return { enabled: true, disabledReason: null }
}
