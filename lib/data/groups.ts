import 'server-only'

import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  groupAssignmentInvitations,
  groupAssignmentRepos,
  groupAssignments,
  groupInviteStatuses,
  groupings,
  groups,
  groupsUsers,
  organizations,
  rosterEntries,
  rosters,
  users,
  type InviteStatusValue,
} from '@/db/schema'
import { findTeachingClassroom } from '@/lib/data/organizations'
import { parameterize } from '@/lib/data/slug'
import { db } from '@/lib/db'
import {
  addCollaborator,
  findRepositoryById,
  removeCollaborator,
} from '@/lib/github/repositories'

/**
 * Teams. Port of the Group model and of what `groupings/show.html.erb` and the
 * team picker of `group_assignment_invitations/show.html.erb` both need.
 *
 * The original backs every team with a GitHub team, and everything it does to
 * GitHub follows from that: create the team, add and remove memberships, give
 * the team the repository. None of it is here — see db/schema.ts on `groups`
 * for why, and lib/data/repositories.ts for what grants access instead. The one
 * exception is `moveMember`, which without a team has to reconcile the
 * collaborators of every repository the two teams hold.
 */

/** validates :title, length: { maximum: 39 } — GitHub's limit on a team name */
export const TEAM_TITLE_MAX_LENGTH = 39

export type TeamMember = {
  userId: number
  githubLogin: string | null
  githubAvatarUrl: string | null
}

export type Team = {
  id: number
  title: string
  /** What the repository name carries: `<assignment-slug>-<slug>` */
  slug: string
  members: TeamMember[]
}

/**
 * The teams of a set, with their members, ordered by title like
 * `invitation.groups.order(:title)`.
 *
 * Takes a grouping id and no session, unlike the rest of the data layer,
 * because its two callers authorize by different routes and both have already
 * done it: the teacher through `findTeachingClassroom`, the student through the
 * invitation key that selects the assignment. No page reaches this directly.
 */
export async function teamsOf(groupingId: number): Promise<Team[]> {
  const rows = await db
    .select({
      id: groups.id,
      title: groups.title,
      slug: groups.slug,
      userId: groupsUsers.userId,
      githubLogin: users.githubLogin,
      githubAvatarUrl: users.githubAvatarUrl,
    })
    .from(groups)
    .leftJoin(groupsUsers, eq(groupsUsers.groupId, groups.id))
    .leftJoin(users, eq(users.id, groupsUsers.userId))
    .where(eq(groups.groupingId, groupingId))
    .orderBy(asc(groups.title), asc(groupsUsers.createdAt))

  const teams = new Map<number, Team>()

  for (const row of rows) {
    const team = teams.get(row.id) ?? { id: row.id, title: row.title, slug: row.slug, members: [] }

    // The LEFT JOIN keeps a team with no members, which is what a team looks
    // like for the moment between the teacher deleting its last member and
    // somebody joining it
    if (row.userId !== null) {
      team.members.push({
        userId: row.userId,
        githubLogin: row.githubLogin,
        githubAvatarUrl: row.githubAvatarUrl,
      })
    }

    teams.set(row.id, team)
  }

  return [...teams.values()]
}

/**
 * The Group model's validations on the name the student types.
 *
 * `validates :title, no_emoji: true, on: :create` is not among them. It exists
 * because the title became a GitHub team name and GitHub refused emoji there;
 * with no team to create, an emoji in the title is only ever displayed, and the
 * slug — which is what reaches a repository name — drops it anyway. What the
 * original could not express, and this checks instead, is that the slug has to
 * survive `parameterize` with something left in it.
 */
export function validateTeamTitle(title: string): { error: string } | null {
  // validates :title, presence: true
  if (title.length === 0) {
    return { error: 'Ponele un nombre al equipo.' }
  }

  if (title.length > TEAM_TITLE_MAX_LENGTH) {
    return { error: `El nombre del equipo no puede superar los ${TEAM_TITLE_MAX_LENGTH} caracteres.` }
  }

  if (parameterize(title).length === 0) {
    return { error: 'El nombre del equipo tiene que tener letras o números.' }
  }

  return null
}

/** One team on the teacher's assignment page */
export type TeamAcceptance = Team & {
  /** GroupInviteStatus, `unaccepted` when the team never accepted this one */
  status: InviteStatusValue
  /** The team's repository on GitHub, null while none exists (DA-2: only the id) */
  repoId: number | null
}

export type GroupAssignmentAcceptances = {
  teams: TeamAcceptance[]
  /** The roster's column header, null when the classroom has no roster */
  identifierName: string | null
  /** RosterEntry.students_not_on_team */
  studentsNotOnTeam: { identifier: string; githubLogin: string | null }[]
}

/**
 * Port of the `@group_assignment_repos` and `@students_not_on_team` of
 * GroupAssignmentsController#show.
 *
 * Keyed on `group_invite_statuses` rather than on `group_assignment_repos`, for
 * the reason listed in lib/data/invitations.ts: the acceptance is recorded
 * before any repository exists, and the teacher wants to see it then.
 *
 * Returns the repository ids, not the repositories. DA-2 means the names and
 * the URLs are read from GitHub at render time, and doing that one team at a
 * time would be one call per row; the page resolves the whole set at once with
 * `listRepositorySnapshots` instead.
 */
export async function listGroupAssignmentAcceptances(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<GroupAssignmentAcceptances | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [assignment] = await db
    .select({
      id: groupAssignments.id,
      groupingId: groupAssignments.groupingId,
      invitationId: groupAssignmentInvitations.id,
    })
    .from(groupAssignments)
    .innerJoin(
      groupAssignmentInvitations,
      and(
        eq(groupAssignmentInvitations.groupAssignmentId, groupAssignments.id),
        isNull(groupAssignmentInvitations.deletedAt),
      ),
    )
    .where(
      and(
        eq(groupAssignments.organizationId, classroom.id),
        eq(groupAssignments.slug, assignmentSlug),
        isNull(groupAssignments.deletedAt),
      ),
    )

  if (!assignment) return null

  const [roster] = await db
    .select({ id: rosters.id, identifierName: rosters.identifierName })
    .from(organizations)
    .innerJoin(rosters, eq(rosters.id, organizations.rosterId))
    .where(eq(organizations.id, classroom.id))

  const teams = await teamsOf(assignment.groupingId)

  const statuses = await db
    .select({ groupId: groupInviteStatuses.groupId, status: groupInviteStatuses.status })
    .from(groupInviteStatuses)
    .where(eq(groupInviteStatuses.groupAssignmentInvitationId, assignment.invitationId))

  const byTeam = new Map(statuses.map((row) => [row.groupId, row.status]))

  const repos = await db
    .select({ groupId: groupAssignmentRepos.groupId, repoId: groupAssignmentRepos.githubRepoId })
    .from(groupAssignmentRepos)
    .where(eq(groupAssignmentRepos.groupAssignmentId, assignment.id))

  const repoByTeam = new Map(repos.map((row) => [row.groupId, row.repoId]))

  return {
    teams: teams.map((team) => ({
      ...team,
      status: byTeam.get(team.id) ?? 'unaccepted',
      repoId: repoByTeam.get(team.id) ?? null,
    })),
    identifierName: roster?.identifierName ?? null,
    studentsNotOnTeam: roster ? await studentsNotOnTeam(roster.id, assignment.groupingId) : [],
  }
}

/**
 * Port of RosterEntry.students_not_on_team, which the original computes in Ruby
 * by flat-mapping every repo's members.
 *
 * Divergence: the original asks whether the student is on a team that has a
 * **repository** for this assignment, so a student who joined a team that never
 * accepted still shows up as "not on a team". Here the question is the one the
 * teacher is actually asking — is anybody left without a team — so it is the
 * set of teams that decides, not the repositories.
 */
async function studentsNotOnTeam(rosterId: number, groupingId: number) {
  const members = await db
    .select({ userId: groupsUsers.userId })
    .from(groupsUsers)
    .where(eq(groupsUsers.groupingId, groupingId))

  const onATeam = members.map((row) => row.userId)

  return db
    .select({ identifier: rosterEntries.identifier, githubLogin: users.githubLogin })
    .from(rosterEntries)
    .leftJoin(users, eq(users.id, rosterEntries.userId))
    .where(
      and(
        eq(rosterEntries.rosterId, rosterId),
        // An unlinked entry is nobody's, so it is on no team by definition
        onATeam.length === 0
          ? sql`true`
          : sql`(${rosterEntries.userId} is null or ${notInArray(rosterEntries.userId, onATeam)})`,
      ),
    )
    .orderBy(asc(rosterEntries.identifier))
}

/** The set of teams and its teams, for the teacher's screen */
export type TeacherGrouping = {
  id: number
  title: string
  slug: string
  teams: Team[]
}

export async function findGroupingForTeacher(
  session: Session,
  classroomSlug: string,
  groupingSlug: string,
): Promise<TeacherGrouping | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [grouping] = await db
    .select({ id: groupings.id, title: groupings.title, slug: groupings.slug })
    .from(groupings)
    .where(
      and(eq(groupings.organizationId, classroom.id), eq(groupings.slug, groupingSlug)),
    )

  if (!grouping) return null

  return { ...grouping, teams: await teamsOf(grouping.id) }
}

export type MoveMemberResult = { success: true } | { success: false; error: string }

/**
 * Move a student to another team of the same set, or off their team entirely.
 *
 * Port of GroupsController#add_membership and #remove_membership, which in the
 * original are two endpoints that nothing calls: `groupings/show.html.erb`
 * offers drag and drop, and `team-management.js:28` only updates the student
 * count in the DOM — it never posts. The whole screen sits behind a Flipper
 * feature nobody outside GitHub had, so in practice a student who picked the
 * wrong team was fixed by hand in the GitHub organization, if at all.
 *
 * It has to work here, because without GitHub teams there is no by-hand fix:
 * access is per repository, so moving somebody means taking their collaborator
 * access to their old team's repositories and giving them their new team's.
 *
 * The one thing this cannot do is accept the new invitation for them — that
 * needs their token, and this runs in the teacher's request. So the student
 * gets an email from GitHub for the new repositories, or picks it up the next
 * time they open the assignment link, whichever comes first.
 */
export async function moveMember(
  session: Session,
  classroomSlug: string,
  groupingSlug: string,
  userId: number,
  targetGroupId: number | null,
): Promise<MoveMemberResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No encontramos ese classroom.' }

  const [grouping] = await db
    .select({ id: groupings.id })
    .from(groupings)
    .where(and(eq(groupings.organizationId, classroom.id), eq(groupings.slug, groupingSlug)))

  if (!grouping) return { success: false, error: 'No encontramos ese conjunto de equipos.' }

  const [membership] = await db
    .select({ groupId: groupsUsers.groupId, githubLogin: users.githubLogin })
    .from(groupsUsers)
    .innerJoin(users, eq(users.id, groupsUsers.userId))
    .where(and(eq(groupsUsers.groupingId, grouping.id), eq(groupsUsers.userId, userId)))

  if (!membership) {
    return { success: false, error: 'Ese alumno no está en ningún equipo de este conjunto.' }
  }

  if (membership.groupId === targetGroupId) return { success: true }

  if (targetGroupId !== null) {
    const [target] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, targetGroupId), eq(groups.groupingId, grouping.id)))

    // "You are not permitted to select this team", from the other side
    if (!target) return { success: false, error: 'Ese equipo no es de este conjunto.' }
  }

  const leaving = await repositoriesOf(membership.groupId)
  const joining = targetGroupId === null ? [] : await repositoriesOf(targetGroupId)

  if (targetGroupId === null) {
    await db
      .delete(groupsUsers)
      .where(and(eq(groupsUsers.groupingId, grouping.id), eq(groupsUsers.userId, userId)))
  } else {
    // The primary key covers (group_id, user_id), so this is a delete and an
    // insert rather than an update of the key itself
    await db.transaction(async (tx) => {
      await tx
        .delete(groupsUsers)
        .where(and(eq(groupsUsers.groupingId, grouping.id), eq(groupsUsers.userId, userId)))

      await tx
        .insert(groupsUsers)
        .values({ groupId: targetGroupId, groupingId: grouping.id, userId })
    })
  }

  if (membership.githubLogin) {
    await reconcileAccess(
      classroom.installationId,
      membership.githubLogin,
      leaving,
      joining,
    )
  }

  return { success: true }
}

type TeamRepository = { githubRepoId: number; studentsAreRepoAdmins: boolean }

/** Every repository a team holds, across the assignments that run on its set */
async function repositoriesOf(groupId: number): Promise<TeamRepository[]> {
  return db
    .select({
      githubRepoId: groupAssignmentRepos.githubRepoId,
      studentsAreRepoAdmins: groupAssignments.studentsAreRepoAdmins,
    })
    .from(groupAssignmentRepos)
    .innerJoin(
      groupAssignments,
      and(
        eq(groupAssignments.id, groupAssignmentRepos.groupAssignmentId),
        isNull(groupAssignments.deletedAt),
      ),
    )
    .where(eq(groupAssignmentRepos.groupId, groupId))
}

/**
 * Take the access away on one side and grant it on the other.
 *
 * Best-effort on purpose: a repository deleted on GitHub, or an account that no
 * longer exists, must not leave the membership half-moved in the database — the
 * database is what the next render and the next accept read, and
 * `claimPendingTeamInvitation` closes any gap the moment the student comes back.
 */
async function reconcileAccess(
  installationId: number,
  githubLogin: string,
  leaving: TeamRepository[],
  joining: TeamRepository[],
) {
  for (const repository of leaving) {
    const found = await findRepositoryById(installationId, repository.githubRepoId)
    if (found) await removeCollaborator(installationId, found.fullName, githubLogin)
  }

  for (const repository of joining) {
    const found = await findRepositoryById(installationId, repository.githubRepoId)
    if (!found) continue

    await addCollaborator(
      installationId,
      found.fullName,
      githubLogin,
      repository.studentsAreRepoAdmins ? 'admin' : 'push',
    )
  }
}
