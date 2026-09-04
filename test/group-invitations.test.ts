import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  groupAssignmentInvitations,
  groupAssignments,
  groupInviteStatuses,
  groupings,
  groups,
  groupsUsers,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of the `#redeem_for` and `#status` cases of
 * spec/models/group_assignment_invitation_spec.rb, and of the
 * `#accept_invitation` cases of
 * spec/controllers/group_assignment_invitations_controller_spec.rb.
 *
 * The original's `:vcr` cases that assert on a GitHub team — `Group::Creator`
 * creating one, `add_member_to_github_team` — have no counterpart: no team is
 * created, see db/schema.ts on `groups`. What they were really testing, that
 * the student ends up on exactly one team of the set, is here against the
 * database instead.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const {
  acceptGroupInvitation,
  currentGroupStatus,
  findGroupInvitation,
  listInvitationTeams,
  listUnlinkedEntriesForGroup,
} = await import('@/lib/data/group-invitations')

// The teacher's side: what the edit screen writes
const { deleteGroupAssignment, updateGroupAssignment } = await import(
  '@/lib/data/group-assignments'
)

let nextUid = 1
let nextGithubId = 1000

/** The `classroom_student` of the original's factories */
async function student(login = 'alumno-fiuba'): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: `${login}-${uid}`, githubAvatarUrl: 'https://avatar' })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: `${login}-${uid}` },
  } as Session
}

type Fixture = {
  classroomId: number
  classroomSlug: string
  groupingId: number
  assignmentId: number
  key: string
  /** The creator, linked in organizations_users so the teacher paths accept it */
  teacher: Session
}

/**
 * The `group_assignment` + `group_assignment_invitation` of the original's
 * factories: a classroom, a set of teams, one group assignment, one invitation.
 */
async function groupAssignment(
  options: {
    maxMembers?: number
    maxTeams?: number
    invitationsEnabled?: boolean
    archived?: boolean
  } = {},
): Promise<Fixture> {
  const githubId = nextGithubId++
  const creator = await student('docente-fiuba')

  const [classroom] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: `classroom-${githubId}`,
      slug: `classroom-${githubId}`,
      archivedAt: options.archived ? new Date() : null,
    })
    .returning({ id: organizations.id, slug: organizations.slug })

  await db
    .insert(organizationsUsers)
    .values({ organizationId: classroom.id, userId: Number(creator.user.id) })

  const [grouping] = await db
    .insert(groupings)
    .values({ organizationId: classroom.id, title: 'Equipos', slug: 'equipos' })
    .returning({ id: groupings.id })

  const [assignment] = await db
    .insert(groupAssignments)
    .values({
      organizationId: classroom.id,
      groupingId: grouping.id,
      creatorId: Number(creator.user.id),
      title: 'TP1 MapReduce',
      slug: '2026a-tp1-mapreduce',
      maxMembers: options.maxMembers ?? null,
      maxTeams: options.maxTeams ?? null,
      invitationsEnabled: options.invitationsEnabled ?? true,
    })
    .returning({ id: groupAssignments.id })

  const key = `key-${assignment.id}`
  await db
    .insert(groupAssignmentInvitations)
    .values({ groupAssignmentId: assignment.id, key })

  return {
    classroomId: classroom.id,
    classroomSlug: classroom.slug,
    groupingId: grouping.id,
    assignmentId: assignment.id,
    key,
    teacher: creator,
  }
}

async function team(fixture: Fixture, title: string): Promise<number> {
  const [row] = await db
    .insert(groups)
    .values({
      groupingId: fixture.groupingId,
      organizationId: fixture.classroomId,
      title,
      slug: title.toLowerCase().replaceAll(' ', '-'),
    })
    .returning({ id: groups.id })

  return row.id
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
})

describe('findGroupInvitation', () => {
  it('returns null for a key that matches nothing', async () => {
    const session = await student()
    expect(await findGroupInvitation(session, 'nope')).toBeNull()
  })

  it('returns the assignment with no team while the student has none', async () => {
    const fixture = await groupAssignment({ maxMembers: 4, maxTeams: 20 })
    const session = await student()

    const invitation = await findGroupInvitation(session, fixture.key)

    expect(invitation).toMatchObject({
      assignmentTitle: 'TP1 MapReduce',
      assignmentSlug: '2026a-tp1-mapreduce',
      enabled: true,
      status: 'unaccepted',
      maxMembers: 4,
      maxTeams: 20,
      team: null,
    })
  })

  it('hides an assignment that was soft-deleted', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    await db
      .update(groupAssignments)
      .set({ deletedAt: new Date() })
      .where(eq(groupAssignments.id, fixture.assignmentId))

    expect(await findGroupInvitation(session, fixture.key)).toBeNull()
  })

  it('names the student’s own team and its status, never a teammate’s', async () => {
    const fixture = await groupAssignment()
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'Distreet boys' })

    // The second student is on no team yet, so they see none — even though one
    // exists and is already accepted
    expect(await findGroupInvitation(second, fixture.key)).toMatchObject({
      status: 'unaccepted',
      team: null,
    })

    expect(await findGroupInvitation(first, fixture.key)).toMatchObject({
      status: 'accepted',
      team: { title: 'Distreet boys', slug: 'distreet-boys' },
    })
  })
})

describe('acceptGroupInvitation — creating a team', () => {
  // "changes the invite status to accepted"
  it('creates the team, joins it and marks the invitation accepted', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    const result = await acceptGroupInvitation(session, fixture.key, { title: 'Distreet boys' })

    expect(result).toEqual({ success: true, status: 'accepted', teamSlug: 'distreet-boys' })

    const [created] = await db.select().from(groups)
    expect(created.title).toBe('Distreet boys')
    expect(created.slug).toBe('distreet-boys')
    expect(created.groupingId).toBe(fixture.groupingId)
    expect(created.organizationId).toBe(fixture.classroomId)

    const memberships = await db.select().from(groupsUsers)
    expect(memberships).toHaveLength(1)
    expect(memberships[0]).toMatchObject({
      groupId: created.id,
      groupingId: fixture.groupingId,
      userId: Number(session.user.id),
    })

    const [status] = await db.select().from(groupInviteStatuses)
    expect(status).toMatchObject({ groupId: created.id, status: 'accepted' })
  })

  it('refuses a name with nothing to slug, and an empty one', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    expect(await acceptGroupInvitation(session, fixture.key, { title: '  ' })).toMatchObject({
      success: false,
    })
    expect(await acceptGroupInvitation(session, fixture.key, { title: '¿?' })).toMatchObject({
      success: false,
    })
    expect(await db.select().from(groups)).toHaveLength(0)
  })

  // validates :title, length: { maximum: 39 }
  it('refuses a name longer than 39 characters', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    const result = await acceptGroupInvitation(session, fixture.key, { title: 'a'.repeat(40) })

    expect(result).toMatchObject({ success: false })
  })

  it('refuses a name another team of the classroom already has', async () => {
    const fixture = await groupAssignment()
    await team(fixture, 'lala')
    const session = await student()

    const result = await acceptGroupInvitation(session, fixture.key, { title: 'LALA' })

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(groups)).toHaveLength(1)
  })
})

describe('acceptGroupInvitation — joining a team', () => {
  it('joins the team the student picked', async () => {
    const fixture = await groupAssignment()
    const existing = await team(fixture, 'threads')
    const session = await student()

    const result = await acceptGroupInvitation(session, fixture.key, { groupId: existing })

    expect(result).toEqual({ success: true, status: 'accepted', teamSlug: 'threads' })

    const memberships = await db.select().from(groupsUsers)
    expect(memberships).toHaveLength(1)
    expect(memberships[0].groupId).toBe(existing)
  })

  // "You are not permitted to select this team"
  it('refuses a team from another set', async () => {
    const fixture = await groupAssignment()
    const other = await groupAssignment()
    const foreign = await team(other, 'ajeno')
    const session = await student()

    expect(await acceptGroupInvitation(session, fixture.key, { groupId: foreign })).toMatchObject({
      success: false,
    })
    expect(await db.select().from(groupsUsers)).toHaveLength(0)
  })

  // check_user_not_group_member: once on a team of the set, the pick is over
  it('keeps the team the student is already on, whatever they pick', async () => {
    const fixture = await groupAssignment()
    const other = await team(fixture, 'threads')
    const session = await student()

    await acceptGroupInvitation(session, fixture.key, { title: 'Distreet boys' })
    const result = await acceptGroupInvitation(session, fixture.key, { groupId: other })

    expect(result).toMatchObject({ success: true, teamSlug: 'distreet-boys' })
    expect(await db.select().from(groupsUsers)).toHaveLength(1)
  })

  it('lets a teammate join a team that is already past accepted', async () => {
    const fixture = await groupAssignment()
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'Distreet boys' })
    const [created] = await db.select().from(groups)

    // The first member's request is mid-flight: the team is building its repo
    await db
      .update(groupInviteStatuses)
      .set({ status: 'creating_repo' })
      .where(eq(groupInviteStatuses.groupId, created.id))

    const result = await acceptGroupInvitation(second, fixture.key, { groupId: created.id })

    // Reported as it is, never walked back to `accepted` — that is what would
    // hand the team a second repository
    expect(result).toEqual({
      success: true,
      status: 'creating_repo',
      teamSlug: 'distreet-boys',
    })
    expect(await db.select().from(groupsUsers)).toHaveLength(2)
    expect(await db.select().from(groupInviteStatuses)).toHaveLength(1)
  })

  it('is idempotent when the same student accepts twice', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })
    const result = await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    expect(result).toMatchObject({ success: true, status: 'accepted' })
    expect(await db.select().from(groups)).toHaveLength(1)
    expect(await db.select().from(groupsUsers)).toHaveLength(1)
  })
})

describe('acceptGroupInvitation — limits', () => {
  // "when the group is full" — validate_max_members_not_exceeded!
  it('refuses to join a team that reached max_members', async () => {
    const fixture = await groupAssignment({ maxMembers: 1 })
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'lala' })
    const [created] = await db.select().from(groups)

    const result = await acceptGroupInvitation(second, fixture.key, { groupId: created.id })

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(groupsUsers)).toHaveLength(1)
  })

  // validate_max_teams_not_exceeded!
  it('refuses to create a team past max_teams, but still lets the student join one', async () => {
    const fixture = await groupAssignment({ maxTeams: 1 })
    const first = await student('primero')
    const second = await student('segundo')

    await acceptGroupInvitation(first, fixture.key, { title: 'lala' })
    const [created] = await db.select().from(groups)

    expect(await acceptGroupInvitation(second, fixture.key, { title: 'otro' })).toMatchObject({
      success: false,
    })
    expect(await acceptGroupInvitation(second, fixture.key, { groupId: created.id })).toMatchObject(
      { success: true },
    )
  })
})

describe('acceptGroupInvitation — disabled invitations', () => {
  // "fails when the invitation is not enabled?"
  it('fails when the teacher turned the link off', async () => {
    const fixture = await groupAssignment({ invitationsEnabled: false })
    const session = await student()

    const result = await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(groups)).toHaveLength(0)
  })

  // "fails with proper error message" when the classroom is archived
  it('fails when the classroom is archived', async () => {
    const fixture = await groupAssignment({ archived: true })
    const session = await student()

    expect(await acceptGroupInvitation(session, fixture.key, { title: 'lala' })).toMatchObject({
      success: false,
    })
  })
})

describe('listInvitationTeams', () => {
  it('lists the teams with their members, marking the full ones', async () => {
    const fixture = await groupAssignment({ maxMembers: 1, maxTeams: 2 })
    const first = await student('primero')

    await acceptGroupInvitation(first, fixture.key, { title: 'Distreet boys' })
    await team(fixture, 'threads')

    const picker = await listInvitationTeams(first, fixture.key)

    expect(picker.teams).toHaveLength(2)
    expect(picker.teams[0]).toMatchObject({ title: 'Distreet boys', full: true })
    expect(picker.teams[0].members[0]).toMatchObject({
      userId: Number(first.user.id),
      githubAvatarUrl: 'https://avatar',
    })
    expect(picker.teams[1]).toMatchObject({ title: 'threads', full: false, members: [] })
    expect(picker.teamLimitReached).toBe(true)
  })

  it('reports no limit reached when the assignment has none', async () => {
    const fixture = await groupAssignment()
    const session = await student()
    await team(fixture, 'lala')

    const picker = await listInvitationTeams(session, fixture.key)

    expect(picker.teamLimitReached).toBe(false)
    expect(picker.teams[0].full).toBe(false)
  })
})

describe('the roster, shared with the individual flow', () => {
  it('lists the unlinked entries of the classroom roster', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    const [roster] = await db
      .insert(rosters)
      .values({ identifierName: 'Padrón' })
      .returning({ id: rosters.id })

    await db
      .update(organizations)
      .set({ rosterId: roster.id })
      .where(eq(organizations.id, fixture.classroomId))

    await db.insert(rosterEntries).values([
      { rosterId: roster.id, identifier: '104001' },
      { rosterId: roster.id, identifier: '104002', userId: Number(session.user.id) },
    ])

    expect(await listUnlinkedEntriesForGroup(session, fixture.key)).toEqual([
      { id: expect.any(Number), identifier: '104001' },
    ])

    expect(await findGroupInvitation(session, fixture.key)).toMatchObject({
      roster: { identifierName: 'Padrón' },
      rosterEntry: { identifier: '104002' },
    })
  })
})

describe('currentGroupStatus', () => {
  it('is unaccepted until the student is on a team', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    expect(await currentGroupStatus(session, fixture.key)).toBe('unaccepted')

    await acceptGroupInvitation(session, fixture.key, { title: 'lala' })

    expect(await currentGroupStatus(session, fixture.key)).toBe('accepted')
  })
})

/**
 * The teacher's edit and delete screens, seen from the student's link. Mirror
 * of the same block in test/invitations.test.ts.
 */
describe('what editing the assignment does to its link', () => {
  /** Everything `updateGroupAssignment` needs, matching the fixture's row */
  const FIELDS = {
    title: 'TP1 MapReduce',
    slug: '2026a-tp1-mapreduce',
    publicRepo: false,
    invitationsEnabled: true,
    studentsAreRepoAdmins: false,
    starterCodeRepo: '',
    autograderId: null,
    maxMembers: null,
    maxTeams: null,
  }

  it('stops accepting once the teacher sets the assignment inactive', async () => {
    const fixture = await groupAssignment()
    const first = await student()

    expect(
      await acceptGroupInvitation(first, fixture.key, { title: 'Equipo 1' }),
    ).toMatchObject({ success: true })

    await updateGroupAssignment(fixture.teacher, fixture.classroomSlug, FIELDS.slug, {
      ...FIELDS,
      invitationsEnabled: false,
    })

    const second = await student('otra-alumna')
    expect(
      await acceptGroupInvitation(second, fixture.key, { title: 'Equipo 2' }),
    ).toMatchObject({ success: false })

    // The team already formed is untouched
    expect(await db.select().from(groups)).toHaveLength(1)
  })

  it('makes the invitation link unreachable once the assignment is deleted', async () => {
    const fixture = await groupAssignment()
    const session = await student()

    await deleteGroupAssignment(fixture.teacher, fixture.classroomSlug, FIELDS.slug)

    expect(await findGroupInvitation(session, fixture.key)).toBeNull()
    expect(
      await acceptGroupInvitation(session, fixture.key, { title: 'Equipo 1' }),
    ).toMatchObject({ success: false })
  })
})
