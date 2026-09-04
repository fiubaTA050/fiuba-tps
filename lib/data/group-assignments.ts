import 'server-only'

import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm'
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
  invitationShortKey,
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

export type DeleteGroupAssignmentResult = { success: true } | { success: false; error: string }

export type GroupAssignmentListItem = {
  id: number
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  invitationKey: string
  /** Null on invitations created before short keys existed */
  invitationShortKey: string | null
  starterCodeRepoId: number | null
  autograderId: string | null
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
  /** Free text id an external autograder worker reads, or null for none */
  autograderId: string | null
  /** An existing set of teams, or null to create one from `groupingTitle` */
  groupingId: number | null
  groupingTitle: string
  maxMembers: number | null
  maxTeams: number | null
}

/**
 * What editing can change. The set of teams is not in it: the original only
 * offers it inside `if @group_assignment.new_record?`, and the live site says
 * the assignment type cannot change after creation either.
 */
export type EditGroupAssignmentInput = Omit<
  NewGroupAssignmentInput,
  'groupingId' | 'groupingTitle'
>

const SELECTION = {
  id: groupAssignments.id,
  title: groupAssignments.title,
  slug: groupAssignments.slug,
  publicRepo: groupAssignments.publicRepo,
  invitationsEnabled: groupAssignments.invitationsEnabled,
  studentsAreRepoAdmins: groupAssignments.studentsAreRepoAdmins,
  invitationKey: groupAssignmentInvitations.key,
  invitationShortKey: groupAssignmentInvitations.shortKey,
  starterCodeRepoId: groupAssignments.starterCodeRepoId,
  autograderId: groupAssignments.autograderId,
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
      error: 'No se pueden crear trabajos prácticos en un classroom archivado.',
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
      error: `Ya existe un trabajo práctico llamado "${title}" en este classroom.`,
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
          autograderId: input.autograderId,
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
        shortKey: invitationShortKey(),
      })
    })
  } catch (error) {
    // Two teachers submitting at once, on either the assignment or the set of
    // teams. The indexes are the backstop; losing the race is not a stack trace.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: 'Ya existe un trabajo práctico o un conjunto de equipos con ese nombre en este classroom.',
        field: 'title',
      }
    }

    throw error
  }

  return { success: true, slug }
}

/**
 * Port of GroupAssignmentsController#update, the mirror of `updateAssignment`.
 *
 * Same three divergences as the individual one — no deadline, nothing
 * propagates to the repositories already created, and both uniqueness checks
 * exclude the row being saved — plus the one that only exists here:
 * `max_teams_less_than_group_count` is re-run against the teams the set
 * already holds. The original has two messages for it
 * (group_assignment.rb:78), one for `new_record?` and one for an edit; the
 * creation path only ever reaches the first, so this is where the second
 * finally gets used.
 */
export async function updateGroupAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
  input: EditGroupAssignmentInput,
): Promise<CreateGroupAssignmentResult> {
  const title = input.title.trim()
  const slug = input.slug.trim()

  const classroom = await findTeachingClassroom(session, classroomSlug)

  if (!classroom) {
    return { success: false, error: 'No encontramos ese classroom.', field: 'base' }
  }

  // validate :organization_is_not_archived — "create or modify"
  if (classroom.archivedAt) {
    return {
      success: false,
      error: 'No se pueden modificar trabajos prácticos en un classroom archivado.',
      field: 'base',
    }
  }

  const [existing] = await db
    .select({ id: groupAssignments.id, groupingId: groupAssignments.groupingId })
    .from(groupAssignments)
    .where(
      and(
        eq(groupAssignments.organizationId, classroom.id),
        eq(groupAssignments.slug, assignmentSlug),
        isNull(groupAssignments.deletedAt),
      ),
    )

  if (!existing) {
    return { success: false, error: 'No encontramos ese trabajo práctico.', field: 'base' }
  }

  const invalid = validateTitleAndSlug(title, slug)
  if (invalid) return { success: false, ...invalid }

  const limits = validateLimits(input.maxMembers, input.maxTeams)
  if (limits) return { success: false, ...limits }

  if (await isTitleTaken(classroom.id, title, existing.id)) {
    return {
      success: false,
      error: `Ya existe un trabajo práctico llamado "${title}" en este classroom.`,
      field: 'title',
    }
  }

  const clash = await findSlugClash(classroom.githubId, slug, { kind: 'group', id: existing.id })
  if (clash) {
    return { success: false, error: slugClashMessage(slug, clash, classroom.id), field: 'slug' }
  }

  // The edit branch of `max_teams_less_than_group_count`: the set is fixed, so
  // unlike at creation it can already be full.
  if (input.maxTeams !== null) {
    const teamCount = await countTeams(existing.groupingId)

    if (input.maxTeams < teamCount) {
      return {
        success: false,
        error: `Este trabajo práctico ya tiene ${teamCount} equipos, así que el máximo no puede ser ${input.maxTeams}.`,
        field: 'maxTeams',
      }
    }
  }

  const starterCode = await resolveStarterCode(classroom.installationId, input.starterCodeRepo)
  if (starterCode.error) return { success: false, ...starterCode.error }

  try {
    await db
      .update(groupAssignments)
      .set({
        title,
        slug,
        starterCodeRepoId: starterCode.repositoryId,
        autograderId: input.autograderId,
        publicRepo: input.publicRepo,
        invitationsEnabled: input.invitationsEnabled,
        studentsAreRepoAdmins: input.studentsAreRepoAdmins,
        maxMembers: input.maxMembers,
        maxTeams: input.maxTeams,
      })
      .where(eq(groupAssignments.id, existing.id))
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: 'Ya existe un trabajo práctico con ese nombre o prefijo en este classroom.',
        field: 'title',
      }
    }

    throw error
  }

  return { success: true, slug }
}

/**
 * Port of GroupAssignmentsController#destroy, soft delete only — see
 * `deleteAssignment` for why the repositories stay.
 *
 * The set of teams is left alone: it belongs to the classroom, not to this
 * assignment, and another one may well be sharing it. The original's
 * `DestroyResourceJob` did not touch it either.
 */
export async function deleteGroupAssignment(
  session: Session,
  classroomSlug: string,
  assignmentSlug: string,
): Promise<DeleteGroupAssignmentResult> {
  const classroom = await findTeachingClassroom(session, classroomSlug)
  if (!classroom) return { success: false, error: 'No encontramos ese classroom.' }

  const deletedAt = new Date()

  const deleted = await db
    .update(groupAssignments)
    .set({ deletedAt })
    .where(
      and(
        eq(groupAssignments.organizationId, classroom.id),
        eq(groupAssignments.slug, assignmentSlug),
        isNull(groupAssignments.deletedAt),
      ),
    )
    .returning({ id: groupAssignments.id })

  if (deleted.length === 0) return { success: false, error: 'No encontramos ese trabajo práctico.' }

  await db
    .update(groupAssignmentInvitations)
    .set({ deletedAt })
    .where(
      and(
        eq(groupAssignmentInvitations.groupAssignmentId, deleted[0].id),
        isNull(groupAssignmentInvitations.deletedAt),
      ),
    )

  return { success: true }
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

/** `exclude` is the assignment being edited, which must not find itself */
async function isTitleTaken(
  organizationId: number,
  title: string,
  exclude?: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: groupAssignments.id })
    .from(groupAssignments)
    .where(
      and(
        eq(groupAssignments.organizationId, organizationId),
        eq(groupAssignments.title, title),
        isNull(groupAssignments.deletedAt),
        exclude === undefined ? undefined : ne(groupAssignments.id, exclude),
      ),
    )
    .limit(1)

  return rows.length > 0
}

export { TEAM_TITLE_MAX_LENGTH }
