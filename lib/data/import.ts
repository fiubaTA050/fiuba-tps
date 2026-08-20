import 'server-only'

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  groupAssignmentInvitations,
  groupAssignmentRepos,
  groupAssignments,
  groupInviteStatuses,
  groupings,
  groups,
  groupsUsers,
  inviteStatuses,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  users,
} from '@/db/schema'
import { invitationKey, invitationShortKey } from '@/lib/data/assignment-fields'
import { isUniqueViolation } from '@/lib/data/postgres'
import { DEFAULT_IDENTIFIER_NAME } from '@/lib/data/rosters'
import { parameterize } from '@/lib/data/slug'
import { db } from '@/lib/db'
import type { ClassroomPlan, PlanUser } from '@/lib/import/classroom-export'

/**
 * Writes a classroom exported from GitHub Classroom.
 *
 * Deliberate divergence from DA-4, and the only one: every other function in
 * this directory takes the session and filters by user, because it serves a
 * request. This one has no session to take — it runs from
 * `scripts/import-classroom-export.ts`, by hand, by whoever holds the database
 * credentials, and the teachers it grants the classroom to are named on the
 * command line. It still lives here rather than in the script because the rule
 * that keeps queries in one directory is what makes that directory auditable.
 *
 * Everything the export cannot answer arrives in `ImportInput`: the GitHub App
 * installation, the teachers, and the GitHub id of every user — see the header
 * of lib/import/classroom-export.ts for why the export's own `students[].id`
 * is not it.
 *
 * The whole classroom goes in one transaction: a half-imported classroom holds
 * the title and the slug while showing a term with some of its assignments
 * missing, which is worse than not having imported it.
 */

/** A user whose GitHub id the caller already resolved */
export type ResolvedUser = PlanUser & { uid: number }

/** The handle drizzle hands to a transaction callback */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ImportInput = {
  /** The GitHub App installation on the org. Not a Classroom concept; resolved by the caller */
  installationId: number
  /** Every user of the plan, plus the teachers */
  users: ResolvedUser[]
  /** Logins of the classroom's teachers. The first one is the creator of every assignment */
  teachers: string[]
  /** The set of teams the group assignments run on. One per classroom */
  groupingTitle?: string
}

export type ImportCounts = {
  users: number
  rosterEntries: number
  assignments: number
  groupAssignments: number
  teams: number
  repositories: number
}

export type ImportResult =
  | { success: true; slug: string; counts: ImportCounts }
  | { success: false; error: string }

/** What the set of teams is called when the command line does not say */
export const DEFAULT_GROUPING_TITLE = 'Equipos'

export async function importClassroom(
  plan: ClassroomPlan,
  input: ImportInput,
): Promise<ImportResult> {
  if (plan.errors.length > 0) {
    return { success: false, error: plan.errors.join(' ') }
  }

  const byLogin = new Map(input.users.map((user) => [user.login, user]))

  const unknown = [...plan.users.map((user) => user.login), ...input.teachers].filter(
    (login) => !byLogin.has(login),
  )

  if (unknown.length > 0) {
    return {
      success: false,
      error: `Faltan los ids de GitHub de ${unknown.map((login) => `@${login}`).join(', ')}.`,
    }
  }

  if (input.teachers.length === 0) {
    return { success: false, error: 'Hay que nombrar al menos un docente para el classroom.' }
  }

  // validates :title, uniqueness: { scope: :github_id }. Checked before the
  // transaction so a re-run says what happened instead of reporting a
  // constraint: the import is not idempotent on purpose, since the second run
  // would have to decide what to do with rows a teacher edited in between.
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.githubId, plan.githubId),
        eq(organizations.title, plan.title),
        isNull(organizations.deletedAt),
      ),
    )

  if (existing) {
    return {
      success: false,
      error: `Ya existe el classroom "${plan.title}" en @${plan.login}. Borralo antes de reimportar.`,
    }
  }

  const now = new Date()
  const counts: ImportCounts = {
    users: input.users.length,
    rosterEntries: plan.roster.length,
    assignments: plan.assignments.length,
    groupAssignments: plan.groupAssignments.length,
    teams: plan.teams.length,
    repositories: 0,
  }

  try {
    const slug = await db.transaction(async (tx) => {
      // The same upsert the login callback does (auth.ts), so a student who
      // already signed in keeps their row — and their id, which the repos and
      // the roster entries of an earlier classroom point at.
      const inserted = await tx
        .insert(users)
        .values(
          input.users.map((user) => ({
            uid: user.uid,
            githubLogin: user.login,
            githubName: user.name,
            githubAvatarUrl: user.avatarUrl,
            githubHtmlUrl: user.htmlUrl,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: users.uid,
          set: {
            githubLogin: sql`excluded.github_login`,
            githubName: sql`excluded.github_name`,
            githubAvatarUrl: sql`excluded.github_avatar_url`,
            githubHtmlUrl: sql`excluded.github_html_url`,
            updatedAt: now,
          },
        })
        .returning({ id: users.id, uid: users.uid })

      const byUid = new Map(inserted.map((row) => [row.uid, row.id]))
      const userId = (login: string) => byUid.get(byLogin.get(login)!.uid)!

      const rosterId =
        plan.roster.length === 0
          ? null
          : (
              await tx
                .insert(rosters)
                .values({ identifierName: DEFAULT_IDENTIFIER_NAME })
                .returning({ id: rosters.id })
            )[0].id

      if (rosterId !== null) {
        await tx.insert(rosterEntries).values(
          plan.roster.map((entry) => ({
            rosterId,
            identifier: entry.identifier,
            userId: entry.login ? userId(entry.login) : null,
          })),
        )
      }

      const [classroom] = await tx
        .insert(organizations)
        .values({
          githubId: plan.githubId,
          installationId: input.installationId,
          title: plan.title,
          slug: plan.slug,
          rosterId,
          // The export has the flag but not the date, and this is the closest
          // true thing we can say about it
          archivedAt: plan.archived ? now : null,
        })
        .returning({ id: organizations.id, slug: organizations.slug })

      await tx.insert(organizationsUsers).values(
        input.teachers.map((login) => ({
          organizationId: classroom.id,
          userId: userId(login),
        })),
      )

      const creatorId = userId(input.teachers[0])
      const shortKeys = await takenShortKeys(tx, plan)

      for (const assignment of plan.assignments) {
        const [row] = await tx
          .insert(assignments)
          .values({
            organizationId: classroom.id,
            creatorId,
            title: assignment.title,
            slug: assignment.slug,
            publicRepo: assignment.publicRepo,
            invitationsEnabled: assignment.invitationsEnabled,
            studentsAreRepoAdmins: assignment.studentsAreRepoAdmins,
            starterCodeRepoId: assignment.starterCodeRepoId,
          })
          .returning({ id: assignments.id })

        const [invitation] = await tx
          .insert(assignmentInvitations)
          .values({
            assignmentId: row.id,
            // The long key is not exported, so this one is new. The short key
            // is, and keeping it is what makes a link already handed out work
            // against our host: /a/<short_key> only looks up and redirects.
            key: invitationKey(),
            shortKey: keepOrReplace(assignment.shortKey, shortKeys.individual),
          })
          .returning({ id: assignmentInvitations.id })

        if (assignment.acceptances.length === 0) continue

        await tx.insert(inviteStatuses).values(
          assignment.acceptances.map((acceptance) => ({
            assignmentInvitationId: invitation.id,
            userId: userId(acceptance.login),
            // Everything the export knows about is already past the setup
            // screen; `accepted` is the state for the repo that never got made
            status: acceptance.repoId === null ? ('accepted' as const) : ('completed' as const),
          })),
        )

        const repositories = assignment.acceptances.filter((acceptance) => acceptance.repoId)
        counts.repositories += repositories.length

        if (repositories.length > 0) {
          await tx.insert(assignmentRepos).values(
            repositories.map((acceptance) => ({
              assignmentId: row.id,
              userId: userId(acceptance.login),
              githubRepoId: acceptance.repoId!,
            })),
          )
        }
      }

      if (plan.groupAssignments.length === 0) return classroom.slug

      // One set of teams for the whole classroom, not one per assignment:
      // the cátedra reuses the teams of the first TP in the next one, which is
      // what `groupings` is for, and the planner already refused the export
      // where a student moved between teams.
      const groupingTitle = input.groupingTitle ?? DEFAULT_GROUPING_TITLE
      const [grouping] = await tx
        .insert(groupings)
        .values({
          organizationId: classroom.id,
          title: groupingTitle,
          slug: parameterize(groupingTitle),
        })
        .returning({ id: groupings.id })

      const teams = new Map<string, number>()

      if (plan.teams.length > 0) {
        const rows = await tx
          .insert(groups)
          .values(
            plan.teams.map((team) => ({
              groupingId: grouping.id,
              organizationId: classroom.id,
              title: team.title,
              slug: team.slug,
            })),
          )
          .returning({ id: groups.id, slug: groups.slug })

        for (const row of rows) teams.set(row.slug, row.id)

        await tx.insert(groupsUsers).values(
          plan.teams.flatMap((team) =>
            team.members.map((login) => ({
              groupId: teams.get(team.slug)!,
              groupingId: grouping.id,
              userId: userId(login),
            })),
          ),
        )
      }

      for (const assignment of plan.groupAssignments) {
        const [row] = await tx
          .insert(groupAssignments)
          .values({
            organizationId: classroom.id,
            groupingId: grouping.id,
            creatorId,
            title: assignment.title,
            slug: assignment.slug,
            publicRepo: assignment.publicRepo,
            invitationsEnabled: assignment.invitationsEnabled,
            studentsAreRepoAdmins: assignment.studentsAreRepoAdmins,
            starterCodeRepoId: assignment.starterCodeRepoId,
            maxMembers: assignment.maxMembers,
            maxTeams: assignment.maxTeams,
          })
          .returning({ id: groupAssignments.id })

        const [invitation] = await tx
          .insert(groupAssignmentInvitations)
          .values({
            groupAssignmentId: row.id,
            key: invitationKey(),
            shortKey: keepOrReplace(assignment.shortKey, shortKeys.group),
          })
          .returning({ id: groupAssignmentInvitations.id })

        if (assignment.acceptances.length === 0) continue

        await tx.insert(groupInviteStatuses).values(
          assignment.acceptances.map((acceptance) => ({
            groupAssignmentInvitationId: invitation.id,
            groupId: teams.get(acceptance.teamSlug)!,
            status: acceptance.repoId === null ? ('accepted' as const) : ('completed' as const),
          })),
        )

        const repositories = assignment.acceptances.filter((acceptance) => acceptance.repoId)
        counts.repositories += repositories.length

        if (repositories.length > 0) {
          await tx.insert(groupAssignmentRepos).values(
            repositories.map((acceptance) => ({
              groupAssignmentId: row.id,
              groupId: teams.get(acceptance.teamSlug)!,
              githubRepoId: acceptance.repoId!,
            })),
          )
        }
      }

      return classroom.slug
    })

    return { success: true, slug, counts }
  } catch (error) {
    // The likely one is a repository already imported under another classroom:
    // `assignment_repos.github_repo_id` is unique across the whole database.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error:
          'Algo del export ya está en la base (un repo, un slug o un short key). ' +
          `No se importó nada de "${plan.title}". Detalle: ${message(error)}`,
      }
    }

    throw error
  }
}

/**
 * The exported short keys that some other invitation already holds.
 *
 * Both `short_key` columns are unique, and an import can collide with one of
 * the ~48 bits generated here or — the real case — with a second run over the
 * same export. Keeping the exported key is a nicety, so a taken one is simply
 * replaced by a fresh one and the long key still works.
 */
async function takenShortKeys(
  tx: Transaction,
  plan: ClassroomPlan,
): Promise<{ individual: Set<string>; group: Set<string> }> {
  const keysOf = (list: { shortKey: string | null }[]) =>
    list.map((item) => item.shortKey).filter((key): key is string => key !== null)

  const individual = keysOf(plan.assignments)
  const group = keysOf(plan.groupAssignments)

  const rows =
    individual.length === 0
      ? []
      : await tx
          .select({ shortKey: assignmentInvitations.shortKey })
          .from(assignmentInvitations)
          .where(inArray(assignmentInvitations.shortKey, individual))

  const groupRows =
    group.length === 0
      ? []
      : await tx
          .select({ shortKey: groupAssignmentInvitations.shortKey })
          .from(groupAssignmentInvitations)
          .where(inArray(groupAssignmentInvitations.shortKey, group))

  const set = (list: { shortKey: string | null }[]) => new Set(keysOf(list))

  return { individual: set(rows), group: set(groupRows) }
}

function keepOrReplace(shortKey: string | null, taken: Set<string>): string {
  return shortKey && !taken.has(shortKey) ? shortKey : invitationShortKey()
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
