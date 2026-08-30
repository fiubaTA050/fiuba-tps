import 'server-only'

import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  groupAssignmentInvitations,
  groupAssignments,
  groupInviteStatuses,
  groupings,
  groups,
  groupsUsers,
  organizations,
  rosterEntries,
  rosters,
  type InviteStatusValue,
} from '@/db/schema'
import { teamsOf, validateTeamTitle, type Team } from '@/lib/data/groups'
import {
  disabledState,
  linkRosterEntry,
  unlinkedEntriesOf,
  type JoinRosterResult,
} from '@/lib/data/invitations'
import { isUniqueViolation } from '@/lib/data/postgres'
import { parameterize } from '@/lib/data/slug'
import { db } from '@/lib/db'

/**
 * The student's side of a group assignment. Port of
 * GroupAssignmentInvitationsController and of
 * GroupAssignmentInvitation#redeem_for.
 *
 * The authorization is the one lib/data/invitations.ts explains at length: the
 * invitation key selects the assignment, and the session selects the rows
 * inside it that belong to the caller. The difference here is that a student
 * also reaches rows that belong to their *team*, which is the point of a team —
 * and never to another team's, apart from the roster of names and avatars the
 * picker has to show, which is the same list the original's `show` renders.
 */

/** Everything the student's screens render, for one invitation and one student */
export type StudentGroupInvitation = {
  assignmentTitle: string
  /** Prefixes the repo that will be created: `<slug>-<team-slug>` */
  assignmentSlug: string
  enabled: boolean
  disabledReason: string | null
  /**
   * The status of *the student's team*, or `unaccepted` while they have none.
   * GroupAssignmentInvitationsController#group_invite_status returns nothing
   * without a group, and `route_based_on_status` sends that case to the picker.
   */
  status: InviteStatusValue
  classroom: { title: string; installationId: number }
  roster: { id: number; identifierName: string } | null
  rosterEntry: { id: number; identifier: string } | null
  /** The set of teams this assignment runs on */
  groupingId: number
  maxMembers: number | null
  maxTeams: number | null
  /** The team this student is already on, null while they are on none */
  team: { id: number; title: string; slug: string } | null
}

export type AcceptGroupResult =
  | { success: true; status: InviteStatusValue; teamSlug: string }
  | { success: false; error: string }

/** What the picker offers: every team of the set, plus whether it is full */
export type TeamOption = Team & { full: boolean }

export type TeamPicker = {
  teams: TeamOption[]
  /** `grouping.groups.count >= max_teams` — no new team can be created */
  teamLimitReached: boolean
}

/** How the student picked: an existing team, or a name for a new one */
export type TeamSelection = { groupId: number } | { title: string }

export async function findGroupInvitation(
  session: Session,
  key: string,
): Promise<StudentGroupInvitation | null> {
  const row = await findGroupInvitationRow(session, key)
  return row && toStudentInvitation(row)
}

/**
 * The long key behind a `/g/<short_key>` link. Sessionless for the same reason
 * as its individual twin — see `findKeyByShortKey` in lib/data/invitations.ts.
 */
export async function findKeyByShortKey(shortKey: string): Promise<string | null> {
  const [row] = await db
    .select({ key: groupAssignmentInvitations.key })
    .from(groupAssignmentInvitations)
    .where(
      and(
        eq(groupAssignmentInvitations.shortKey, shortKey),
        isNull(groupAssignmentInvitations.deletedAt),
      ),
    )

  return row?.key ?? null
}

/** The same read keeping the ids the writers need. Private, as in the individual flow */
async function findGroupInvitationRow(session: Session, key: string) {
  const userId = Number(session.user.id)

  const [row] = await db
    .select({
      id: groupAssignmentInvitations.id,
      assignmentTitle: groupAssignments.title,
      assignmentSlug: groupAssignments.slug,
      invitationsEnabled: groupAssignments.invitationsEnabled,
      maxMembers: groupAssignments.maxMembers,
      maxTeams: groupAssignments.maxTeams,
      groupingId: groupings.id,
      classroomId: organizations.id,
      classroomTitle: organizations.title,
      installationId: organizations.installationId,
      archivedAt: organizations.archivedAt,
      rosterId: rosters.id,
      identifierName: rosters.identifierName,
      rosterEntryId: rosterEntries.id,
      rosterEntryIdentifier: rosterEntries.identifier,
      teamId: groups.id,
      teamTitle: groups.title,
      teamSlug: groups.slug,
      status: groupInviteStatuses.status,
    })
    .from(groupAssignmentInvitations)
    .innerJoin(
      groupAssignments,
      and(
        eq(groupAssignments.id, groupAssignmentInvitations.groupAssignmentId),
        isNull(groupAssignments.deletedAt),
      ),
    )
    .innerJoin(groupings, eq(groupings.id, groupAssignments.groupingId))
    .innerJoin(
      organizations,
      and(eq(organizations.id, groupAssignments.organizationId), isNull(organizations.deletedAt)),
    )
    .leftJoin(rosters, eq(rosters.id, organizations.rosterId))
    .leftJoin(
      rosterEntries,
      and(eq(rosterEntries.rosterId, rosters.id), eq(rosterEntries.userId, userId)),
    )
    // The caller's team in this set, and nobody else's — the unique index on
    // (grouping_id, user_id) is what makes this at most one row.
    // GroupAssignmentInvitation#group.
    .leftJoin(
      groupsUsers,
      and(eq(groupsUsers.groupingId, groupings.id), eq(groupsUsers.userId, userId)),
    )
    .leftJoin(groups, eq(groups.id, groupsUsers.groupId))
    .leftJoin(
      groupInviteStatuses,
      and(
        eq(groupInviteStatuses.groupAssignmentInvitationId, groupAssignmentInvitations.id),
        eq(groupInviteStatuses.groupId, groupsUsers.groupId),
      ),
    )
    .where(
      and(
        eq(groupAssignmentInvitations.key, key),
        isNull(groupAssignmentInvitations.deletedAt),
      ),
    )

  return row ?? null
}

function toStudentInvitation(
  row: NonNullable<Awaited<ReturnType<typeof findGroupInvitationRow>>>,
): StudentGroupInvitation {
  return {
    assignmentTitle: row.assignmentTitle,
    assignmentSlug: row.assignmentSlug,
    ...disabledState(row.invitationsEnabled, row.archivedAt),
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
    groupingId: row.groupingId,
    maxMembers: row.maxMembers,
    maxTeams: row.maxTeams,
    team:
      row.teamId === null || row.teamTitle === null || row.teamSlug === null
        ? null
        : { id: row.teamId, title: row.teamTitle, slug: row.teamSlug },
  }
}

/** The `@groups` of GroupAssignmentInvitationsController#show, with the two limits applied */
export async function listInvitationTeams(session: Session, key: string): Promise<TeamPicker> {
  const invitation = await findGroupInvitation(session, key)
  if (!invitation) return { teams: [], teamLimitReached: false }

  const teams = await teamsOf(invitation.groupingId)

  return {
    teams: teams.map((team) => ({
      ...team,
      // `group.repo_accesses.count >= group_assignment.max_members` — the
      // "Full" button of _group_assignment_team.erb
      full: invitation.maxMembers !== null && team.members.length >= invitation.maxMembers,
    })),
    teamLimitReached: invitation.maxTeams !== null && teams.length >= invitation.maxTeams,
  }
}

/** The roster list of `join_roster`, which the group flow shares with the individual one */
export async function listUnlinkedEntriesForGroup(
  session: Session,
  key: string,
): Promise<{ id: number; identifier: string }[]> {
  const invitation = await findGroupInvitation(session, key)
  if (!invitation?.roster) return []

  return unlinkedEntriesOf(invitation.roster.id)
}

/** Port of #join_roster, the concern both invitation controllers include */
export async function joinRosterForGroup(
  session: Session,
  key: string,
  entryId: number,
): Promise<JoinRosterResult> {
  const invitation = await findGroupInvitation(session, key)
  if (!invitation) return { success: false, error: 'No encontramos esa invitación.' }

  return linkRosterEntry(session, invitation.roster, invitation.rosterEntry, entryId)
}

/**
 * Port of GroupAssignmentInvitation#redeem_for, minus the `RepoAccess` that
 * put the student in the GitHub organization.
 *
 * The original's shape survives intact:
 *
 *   1. the student's existing team in this set wins over anything they picked
 *      (`GroupAssignmentInvitation#group` looks it up first);
 *   2. otherwise the team they chose, or a new one with the title they typed;
 *   3. join it, and mark the team's invitation accepted.
 *
 * What the original leaves to Ruby and this does not: both limits are counted
 * **inside a transaction that holds the set of teams**. `max_members` and
 * `max_teams` are checked in `before_action`s there, so two students clicking
 * at the same second both read a count of four and both get in, and a cohort
 * that all accepts at once is exactly when that happens. Locking the grouping
 * row serialises every join and creation of the set, which at this size costs
 * nothing.
 */
export async function acceptGroupInvitation(
  session: Session,
  key: string,
  selection: TeamSelection,
): Promise<AcceptGroupResult> {
  const invitation = await findGroupInvitationRow(session, key)
  if (!invitation) return { success: false, error: 'No encontramos esa invitación.' }

  const { enabled, disabledReason } = disabledState(
    invitation.invitationsEnabled,
    invitation.archivedAt,
  )

  // reason_for_disabled_invitations
  if (!enabled) return { success: false, error: disabledReason ?? '' }

  const userId = Number(session.user.id)

  try {
    return await db.transaction(async (tx) => {
      // The lock. Everything below counts rows that another accept could be
      // adding at the same moment.
      await tx.execute(sql`select id from groupings where id = ${invitation.groupingId} for update`)

      const team = await resolveTeam(tx, invitation, userId, selection)
      if ('error' in team) return { success: false as const, error: team.error }

      // `invitees_group.repo_accesses << repo_access unless … include?`
      await tx
        .insert(groupsUsers)
        .values({ groupId: team.id, groupingId: invitation.groupingId, userId })
        .onConflictDoNothing()

      // `invite_status.accepted! if invite_status.unaccepted?`. The guard is
      // the same as the individual flow's: a teammate may already have driven
      // this team to `creating_repo`, and walking it back would build a second
      // repository.
      const [status] = await tx
        .insert(groupInviteStatuses)
        .values({
          groupAssignmentInvitationId: invitation.id,
          groupId: team.id,
          status: 'accepted',
        })
        .onConflictDoUpdate({
          target: [groupInviteStatuses.groupAssignmentInvitationId, groupInviteStatuses.groupId],
          set: { status: 'accepted', updatedAt: new Date() },
          setWhere: eq(groupInviteStatuses.status, 'unaccepted'),
        })
        .returning({ status: groupInviteStatuses.status })

      if (status) {
        return { success: true as const, status: status.status, teamSlug: team.slug }
      }

      // `setWhere` filtered the row out: the team is already past `accepted`
      const [current] = await tx
        .select({ status: groupInviteStatuses.status })
        .from(groupInviteStatuses)
        .where(
          and(
            eq(groupInviteStatuses.groupAssignmentInvitationId, invitation.id),
            eq(groupInviteStatuses.groupId, team.id),
          ),
        )

      return {
        success: true as const,
        status: current?.status ?? 'accepted',
        teamSlug: team.slug,
      }
    })
  } catch (error) {
    // Two students typed the same team name at the same moment, and the unique
    // index on (organization_id, slug) picked a winner
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: 'Alguien acaba de crear un equipo con ese nombre. Probá con otro, o sumate a ése.',
      }
    }

    throw error
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** GroupAssignmentInvitation#group plus the two before_actions that guard it */
async function resolveTeam(
  tx: Transaction,
  invitation: NonNullable<Awaited<ReturnType<typeof findGroupInvitationRow>>>,
  userId: number,
  selection: TeamSelection,
): Promise<{ id: number; slug: string } | { error: string }> {
  // Already on a team of this set: it wins, whatever came in the form. This is
  // `check_user_not_group_member` redirecting to #accept, enforced again here
  // because the redirect is advisory and this is the boundary.
  if (invitation.teamId !== null && invitation.teamSlug !== null) {
    return { id: invitation.teamId, slug: invitation.teamSlug }
  }

  if ('groupId' in selection) {
    const [team] = await tx
      .select({ id: groups.id, slug: groups.slug })
      .from(groups)
      .where(and(eq(groups.id, selection.groupId), eq(groups.groupingId, invitation.groupingId)))

    // `raise NotAuthorized, "You are not permitted to select this team"` — a
    // team id that is not offered by this assignment's set
    if (!team) return { error: 'No encontramos ese equipo.' }

    // validate_max_members_not_exceeded!
    if (invitation.maxMembers !== null) {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(groupsUsers)
        .where(eq(groupsUsers.groupId, team.id))

      if (count >= invitation.maxMembers) {
        return {
          error: `Ese equipo ya llegó al máximo de ${invitation.maxMembers} integrantes.`,
        }
      }
    }

    return team
  }

  const title = selection.title.trim()

  const invalid = validateTeamTitle(title)
  if (invalid) return invalid

  // validate_max_teams_not_exceeded!
  if (invitation.maxTeams !== null) {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(groups)
      .where(eq(groups.groupingId, invitation.groupingId))

    if (count >= invitation.maxTeams) {
      return {
        error: `Este trabajo práctico llegó al máximo de ${invitation.maxTeams} equipos. Sumate a uno que ya exista.`,
      }
    }
  }

  // Group::Creator.perform, without the GitHub team it also created
  const [created] = await tx
    .insert(groups)
    .values({
      groupingId: invitation.groupingId,
      organizationId: invitation.classroomId,
      title,
      slug: parameterize(title),
    })
    .returning({ id: groups.id, slug: groups.slug })

  return created
}

/** `invitation.status(group).status`, for the progress endpoint */
export async function currentGroupStatus(
  session: Session,
  key: string,
): Promise<InviteStatusValue> {
  const invitation = await findGroupInvitationRow(session, key)
  return invitation?.status ?? 'unaccepted'
}
