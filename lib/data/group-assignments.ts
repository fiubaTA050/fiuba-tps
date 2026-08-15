import 'server-only'

import { and, asc, count, eq, isNull, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'

import {
  groupAssignmentInvitations,
  groupAssignments,
  groupings,
  groups,
} from '@/db/schema'
import {
  findSlugClash,
  invitationKey,
  resolveStarterCode,
  slugClashMessage,
  validateTitleAndSlug,
  type AssignmentField,
} from '@/lib/data/assignment-fields'
import { findTeachingClassroom } from '@/lib/data/organizations'
import { isUniqueViolation } from '@/lib/data/postgres'
import { parameterize } from '@/lib/data/slug'
import { db } from '@/lib/db'

/**
 * Group assignments data layer. Port of GroupAssignmentsController#new/#create,
 * the GroupAssignment model and GroupAssignmentService.
 *
 * DA-4 as everywhere else: the boundary is `findTeachingClassroom`. The teams
 * themselves — who is on which one, and the two limits at accept time — are in
 * lib/data/groups.ts, because the student reaches those through an invitation
 * key and never through a classroom they teach.
 */

/** validates :title, length: { maximum: 39 } on Group, kept for the repo name */
const TEAM_TITLE_MAX_LENGTH = 39

export type GroupAssignmentField = AssignmentField | 'grouping' | 'maxMembers' | 'maxTeams'

export type CreateGroupAssignmentResult =
  | { success: true; slug: string }
  | { success: false; error: string; field: GroupAssignmentField }

export type GroupAssignmentListItem = {
  id: number
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  invitationKey: string
  starterCodeRepoId: number | null
  maxMembers: number | null
  maxTeams: number | null
  grouping: { id: number; title: string; slug: string }
}

/** A set of teams as the new-assignment form lists it */
export type GroupingOption = {
  id: number
  title: string
  slug: string
  /** How many teams it already holds, which is what `max_teams` is measured against */
  teamCount: number
}

export type NewGroupAssignmentInput = {
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  starterCodeRepo: string
  /** An existing set of teams, or null to create one from `groupingTitle` */
  groupingId: number | null
  groupingTitle: string
  maxMembers: number | null
  maxTeams: number | null
}

const SELECTION = {
  id: groupAssignments.id,
  title: groupAssignments.title,
  slug: groupAssignments.slug,
  publicRepo: groupAssignments.publicRepo,
  invitationsEnabled: groupAssignments.invitationsEnabled,
  studentsAreRepoAdmins: groupAssignments.studentsAreRepoAdmins,
  invitationKey: groupAssignmentInvitations.key,
  starterCodeRepoId: groupAssignments.starterCodeRepoId,
  maxMembers: groupAssignments.maxMembers,
  maxTeams: groupAssignments.maxTeams,
  groupingId: groupings.id,
  groupingTitle: groupings.title,
  groupingSlug: groupings.slug,
}

/** What `SELECTION` comes back as: the list item with the grouping still flat */
type Row = Omit<GroupAssignmentListItem, 'grouping'> & {
  groupingId: number
  groupingTitle: string
  groupingSlug: string
}

function toListItem(row: Row): GroupAssignmentListItem {
  const { groupingId, groupingTitle, groupingSlug, ...assignment } = row
  return {
    ...assignment,
    grouping: { id: groupingId, title: groupingTitle, slug: groupingSlug },
  }
}

/** The `@group_assignments` of OrganizationsController#show */
export async function listGroupAssignments(
  session: Session,
  classroomSlug: string,
): Promise<GroupAssignmentListItem[]> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return []

  const rows = await db
    .select(SELECTION)
    .from(groupAssignments)
    // Inner, same reasoning as the individual one: `validates
    // :group_assignment_invitation, presence: true` makes a group assignment
    // without a link impossible, and listing one would only mislead.
    .innerJoin(
      groupAssignmentInvitations,
      and(
        eq(groupAssignmentInvitations.groupAssignmentId, groupAssignments.id),
        isNull(groupAssignmentInvitations.deletedAt),
      ),
    )
    .innerJoin(groupings, eq(groupings.id, groupAssignments.groupingId))
    .where(
      and(eq(groupAssignments.organizationId, classroom.id), isNull(groupAssignments.deletedAt)),
    )
    .orderBy(asc(groupAssignments.id))

  return rows.map(toListItem)
}

/** Port of GroupAssignmentsController#set_group_assignment */
export async function findGroupAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<GroupAssignmentListItem | null> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return null

  const [row] = await db
    .select(SELECTION)
    .from(groupAssignments)
    .innerJoin(
      groupAssignmentInvitations,
      and(
        eq(groupAssignmentInvitations.groupAssignmentId, groupAssignments.id),
        isNull(groupAssignmentInvitations.deletedAt),
      ),
    )
    .innerJoin(groupings, eq(groupings.id, groupAssignments.groupingId))
    .where(
      and(
        eq(groupAssignments.organizationId, classroom.id),
        eq(groupAssignments.slug, assignmentSlug),
        isNull(groupAssignments.deletedAt),
      ),
    )

  return row ? toListItem(row) : null
}

/**
 * Port of GroupAssignmentsController#set_groupings, which fills the
 * "Choose an existing set of teams" select.
 *
 * The team count comes along because `max_teams_less_than_group_count` is
 * measured against it, and because a set with no teams reads differently to a
 * teacher than one with sixteen.
 */
export async function listGroupings(
  session: Session,
  classroomSlug: string,
): Promise<GroupingOption[]> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return []

  return db
    .select({
      id: groupings.id,
      title: groupings.title,
      slug: groupings.slug,
      teamCount: count(groups.id),
    })
    .from(groupings)
    .leftJoin(groups, eq(groups.groupingId, groupings.id))
    .where(eq(groupings.organizationId, classroom.id))
    .groupBy(groupings.id)
    .orderBy(asc(groupings.id))
}

/**
 * Port of GroupAssignmentsController#create together with
 * GroupAssignmentService#build_group_assignment.
 *
 * The service is one line of Rails —
 * `Grouping.where(id:).first_or_initialize(title:)` — carrying two cases: an
 * existing set of teams chosen from the select, or a new one named in the
 * input beside it. Both end up saved in the same transaction as the assignment
 * and its invitation, which is what `validates_associated :grouping` plus
 * autosave buy the original for free.
 */
export async function createGroupAssignment(
  session: Session,
  classroomSlug: string,
  input: NewGroupAssignmentInput,
): Promise<CreateGroupAssignmentResult> {
  const title = input.title.trim()
  const slug = input.slug.trim()
  const groupingTitle = input.groupingTitle.trim()

  const classroom = await findTeachingClassroom(session, classroomSlug)

  if (!classroom) {
    return { success: false, error: 'No encontramos ese classroom.', field: 'base' }
  }

  // validate :organization_is_not_archived
  if (classroom.archivedAt) {
    return {
      success: false,
      error: 'No se pueden crear assignments en un classroom archivado.',
      field: 'base',
    }
  }

  const invalid = validateTitleAndSlug(title, slug)
  if (invalid) return { success: false, ...invalid }

  const limits = validateLimits(input.maxMembers, input.maxTeams)
  if (limits) return { success: false, ...limits }

  // `Assignment.where(title:, organization:)` — scoped to the classroom, like
  // the individual one. Only the slug widens to the whole GitHub org.
  if (await isTitleTaken(classroom.id, title)) {
    return {
      success: false,
      error: `Ya existe un assignment llamado "${title}" en este classroom.`,
      field: 'title',
    }
  }

  const clash = await findSlugClash(classroom.githubId, slug)
  if (clash) {
    return { success: false, error: slugClashMessage(slug, clash, classroom.id), field: 'slug' }
  }

  // GroupAssignmentService#grouping_info_valid? — one of the two has to be there
  const grouping = await resolveGrouping(classroom.id, input.groupingId, groupingTitle)
  if ('error' in grouping) return { success: false, ...grouping.error }

  // validate :max_teams_less_than_group_count, which only bites on an existing
  // set: a set created here has no teams yet.
  if (input.maxTeams !== null && grouping.existing) {
    const teamCount = await countTeams(grouping.id)

    if (input.maxTeams < teamCount) {
      return {
        success: false,
        error: `El conjunto de equipos que elegiste ya tiene ${teamCount} equipos, así que el máximo no puede ser ${input.maxTeams}.`,
        field: 'maxTeams',
      }
    }
  }

  // Last, because it is the only step that costs GitHub API calls
  const starterCode = await resolveStarterCode(classroom.installationId, input.starterCodeRepo)
  if (starterCode.error) return { success: false, ...starterCode.error }

  try {
    await db.transaction(async (tx) => {
      const groupingId = grouping.existing
        ? grouping.id
        : (
            await tx
              .insert(groupings)
              .values({
                organizationId: classroom.id,
                title: grouping.title,
                slug: grouping.slug,
              })
              .returning({ id: groupings.id })
          )[0].id

      const [row] = await tx
        .insert(groupAssignments)
        .values({
          organizationId: classroom.id,
          groupingId,
          creatorId: Number(session.user.id),
          title,
          slug,
          starterCodeRepoId: starterCode.repositoryId,
          publicRepo: input.publicRepo,
          invitationsEnabled: input.invitationsEnabled,
          studentsAreRepoAdmins: input.studentsAreRepoAdmins,
          maxMembers: input.maxMembers,
          maxTeams: input.maxTeams,
        })
        .returning({ id: groupAssignments.id })

      await tx.insert(groupAssignmentInvitations).values({
        groupAssignmentId: row.id,
        key: invitationKey(),
      })
    })
  } catch (error) {
    // Two teachers submitting at once, on either the assignment or the set of
    // teams. The indexes are the backstop; losing the race is not a stack trace.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: 'Ya existe un assignment o un conjunto de equipos con ese nombre en este classroom.',
        field: 'title',
      }
    }

    throw error
  }

  return { success: true, slug }
}

/** The chosen set of teams, or the one that is about to be created for it */
type ResolvedGrouping =
  | { existing: true; id: number }
  | { existing: false; title: string; slug: string }
  | { error: { error: string; field: GroupAssignmentField } }

/**
 * Port of `Grouping.where(id: @grouping_id).first_or_initialize(@new_grouping_params)`
 * plus GroupAssignmentsController#authorize_grouping_access, which is what
 * stops a teacher from attaching a set of teams that belongs to somebody
 * else's classroom.
 */
async function resolveGrouping(
  organizationId: number,
  groupingId: number | null,
  groupingTitle: string,
): Promise<ResolvedGrouping> {
  if (groupingId !== null) {
    const rows = await db
      .select({ id: groupings.id })
      .from(groupings)
      .where(and(eq(groupings.id, groupingId), eq(groupings.organizationId, organizationId)))

    // `raise NotAuthorized, "You are not permitted to select this set of teams"`,
    // which for a select that only ever offers this classroom's sets means the
    // form was tampered with — so it reads as "not found", not as an accusation.
    if (rows.length === 0) {
      return {
        error: { error: 'No encontramos ese conjunto de equipos.', field: 'grouping' },
      }
    }

    return { existing: true, id: rows[0].id }
  }

  // validates :grouping, presence: true, reached through grouping_info_valid?
  if (groupingTitle.length === 0) {
    return {
      error: {
        error: 'Elegí un conjunto de equipos existente o ponele nombre a uno nuevo.',
        field: 'grouping',
      },
    }
  }

  const slug = parameterize(groupingTitle)

  // The slug is what the URL of the teams screen carries, and `parameterize`
  // can empty a title made only of punctuation
  if (slug.length === 0) {
    return {
      error: {
        error: 'El nombre del conjunto de equipos tiene que tener letras o números.',
        field: 'grouping',
      },
    }
  }

  const taken = await db
    .select({ id: groupings.id })
    .from(groupings)
    .where(and(eq(groupings.organizationId, organizationId), eq(groupings.slug, slug)))

  if (taken.length > 0) {
    return {
      error: {
        error: `Ya existe un conjunto de equipos llamado "${groupingTitle}" en este classroom.`,
        field: 'grouping',
      },
    }
  }

  return { existing: false, title: groupingTitle, slug }
}

/**
 * Divergence: the original takes `max_members` and `max_teams` from a
 * `number_field` and only ever compares them, so a 0 or a negative number is
 * stored happily — and a `max_members` of 0 makes every team full before
 * anybody joins, with the student told only "This team has reached its maximum
 * member limit of 0".
 */
function validateLimits(
  maxMembers: number | null,
  maxTeams: number | null,
): { error: string; field: GroupAssignmentField } | null {
  if (maxMembers !== null && maxMembers < 1) {
    return { error: 'El máximo de integrantes por equipo tiene que ser 1 o más.', field: 'maxMembers' }
  }

  if (maxTeams !== null && maxTeams < 1) {
    return { error: 'El máximo de equipos tiene que ser 1 o más.', field: 'maxTeams' }
  }

  return null
}

async function countTeams(groupingId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(groups)
    .where(eq(groups.groupingId, groupingId))

  return row.count
}

async function isTitleTaken(organizationId: number, title: string): Promise<boolean> {
  const rows = await db
    .select({ id: groupAssignments.id })
    .from(groupAssignments)
    .where(
      and(
        eq(groupAssignments.organizationId, organizationId),
        eq(groupAssignments.title, title),
        isNull(groupAssignments.deletedAt),
      ),
    )
    .limit(1)

  return rows.length > 0
}

export { TEAM_TITLE_MAX_LENGTH }
