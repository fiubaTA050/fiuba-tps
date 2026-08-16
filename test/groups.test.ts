import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  groupAssignmentInvitations,
  groupAssignmentRepos,
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
 * The invariants of the group tables, exercised against the real migration.
 *
 * These are the cases the original leaves to a query and a race can walk
 * through — `Group.joins(:repo_accesses).find_by(grouping:)` in
 * `GroupAssignmentInvitation#group`, `validates :slug, uniqueness: { scope:
 * :grouping }` in Group — plus the two composite foreign keys that keep the
 * denormalised columns from disagreeing with their parents. The first half of
 * the file goes straight to the database on purpose: the point is that it
 * refuses these on its own, whatever the code above it does.
 *
 * The second half is the teacher's side — port of GroupsController#add_membership
 * and #remove_membership, and of the `@students_not_on_team` of
 * GroupAssignmentsController#show.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

/** What the teacher's move did to GitHub, recorded per test */
const github = {
  added: [] as { fullName: string; login: string; permission: string }[],
  removed: [] as { fullName: string; login: string }[],
  /** github_repo_id → full name, for the repositories the fixtures create */
  names: new Map<number, string>(),
}

vi.mock('@/lib/github/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/repositories')>()),
  findRepositoryById: async (_installationId: number, id: number) => {
    const fullName = github.names.get(id)
    return fullName
      ? { id, fullName, htmlUrl: `https://github.com/${fullName}`, private: true, isTemplate: false }
      : null
  },
  addCollaborator: async (
    _installationId: number,
    fullName: string,
    login: string,
    permission: string,
  ) => {
    github.added.push({ fullName, login, permission })
    return 1
  },
  removeCollaborator: async (_installationId: number, fullName: string, login: string) => {
    github.removed.push({ fullName, login })
  },
}))

const { findGroupingForTeacher, listGroupAssignmentAcceptances, moveMember } = await import(
  '@/lib/data/groups'
)

let nextUid = 1
let nextGithubId = 1000

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
  github.added = []
  github.removed = []
  github.names = new Map()
})

async function student(login = 'alumno-fiuba'): Promise<number> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: `${login}-${uid}` })
    .returning({ id: users.id })

  return user.id
}

/** A classroom, with no teacher linked: nothing here goes through the data layer */
async function classroom(title = 'TA050 2026a'): Promise<number> {
  const githubId = nextGithubId++
  const [row] = await db
    .insert(organizations)
    .values({
      githubId,
      title: `${title} ${githubId}`,
      slug: `ta050-${githubId}`,
      installationId: githubId,
    })
    .returning({ id: organizations.id })

  return row.id
}

async function grouping(organizationId: number, title = 'Equipos del TP1'): Promise<number> {
  const [row] = await db
    .insert(groupings)
    .values({ organizationId, title, slug: title.toLowerCase().replaceAll(' ', '-') })
    .returning({ id: groupings.id })

  return row.id
}

async function group(groupingId: number, organizationId: number, title: string): Promise<number> {
  const [row] = await db
    .insert(groups)
    .values({ groupingId, organizationId, title, slug: title.toLowerCase() })
    .returning({ id: groups.id })

  return row.id
}

/** A group assignment with its invitation, the pair the model treats as one */
async function groupAssignment(organizationId: number, groupingId: number, creatorId: number) {
  const [assignment] = await db
    .insert(groupAssignments)
    .values({
      organizationId,
      groupingId,
      creatorId,
      title: 'TP1 MapReduce',
      slug: '2026a-tp1-mapreduce',
    })
    .returning({ id: groupAssignments.id })

  const [invitation] = await db
    .insert(groupAssignmentInvitations)
    .values({ groupAssignmentId: assignment.id, key: `key-${assignment.id}` })
    .returning({ id: groupAssignmentInvitations.id })

  return { assignmentId: assignment.id, invitationId: invitation.id }
}

describe('team membership', () => {
  it('refuses a student on two teams of the same set', async () => {
    const classroomId = await classroom()
    const groupingId = await grouping(classroomId)
    const first = await group(groupingId, classroomId, 'Distreet boys')
    const second = await group(groupingId, classroomId, 'GoGoBoots')
    const userId = await student()

    await db.insert(groupsUsers).values({ groupId: first, groupingId, userId })

    await expect(
      db.insert(groupsUsers).values({ groupId: second, groupingId, userId }),
    ).rejects.toThrow()
  })

  it('lets a student be on one team per set', async () => {
    const classroomId = await classroom()
    const firstSet = await grouping(classroomId, 'Equipos del TP1')
    const secondSet = await grouping(classroomId, 'Equipos del TP3')
    const firstTeam = await group(firstSet, classroomId, 'Distreet boys')
    const secondTeam = await group(secondSet, classroomId, 'threads')
    const userId = await student()

    await db.insert(groupsUsers).values({ groupId: firstTeam, groupingId: firstSet, userId })
    await db.insert(groupsUsers).values({ groupId: secondTeam, groupingId: secondSet, userId })

    const rows = await db.select().from(groupsUsers).where(eq(groupsUsers.userId, userId))
    expect(rows).toHaveLength(2)
  })

  it('refuses a membership whose set is not the team’s', async () => {
    const classroomId = await classroom()
    const firstSet = await grouping(classroomId, 'Equipos del TP1')
    const secondSet = await grouping(classroomId, 'Equipos del TP3')
    const team = await group(firstSet, classroomId, 'Distreet boys')
    const userId = await student()

    // The composite foreign key: `grouping_id` is denormalised for the
    // uniqueness above, and this is what stops it from drifting.
    await expect(
      db.insert(groupsUsers).values({ groupId: team, groupingId: secondSet, userId }),
    ).rejects.toThrow()
  })

  it('drops the memberships with the team', async () => {
    const classroomId = await classroom()
    const groupingId = await grouping(classroomId)
    const team = await group(groupingId, classroomId, 'lala')
    const userId = await student()

    await db.insert(groupsUsers).values({ groupId: team, groupingId, userId })
    await db.delete(groups).where(eq(groups.id, team))

    expect(await db.select().from(groupsUsers)).toHaveLength(0)
  })
})

describe('team names', () => {
  it('refuses two teams with the same name in one classroom, across sets', async () => {
    const classroomId = await classroom()
    const firstSet = await grouping(classroomId, 'Equipos del TP1')
    const secondSet = await grouping(classroomId, 'Equipos del TP3')

    await group(firstSet, classroomId, 'lala')

    // Divergence from the original, which scopes the slug to the grouping:
    // several classrooms share one GitHub organization, so the scope a student
    // can be told about is the classroom.
    await expect(group(secondSet, classroomId, 'lala')).rejects.toThrow()
  })

  it('lets two classrooms have a team with the same name', async () => {
    const first = await classroom('TA050 2026a')
    const second = await classroom('TA050 2026b')

    await group(await grouping(first), first, 'lala')
    await group(await grouping(second), second, 'lala')

    expect(await db.select().from(groups)).toHaveLength(2)
  })

  it('refuses a team whose classroom is not its set’s', async () => {
    const first = await classroom('TA050 2026a')
    const second = await classroom('TA050 2026b')
    const groupingId = await grouping(first)

    await expect(group(groupingId, second, 'lala')).rejects.toThrow()
  })
})

describe('team repositories', () => {
  it('refuses a second repository for the same team and assignment', async () => {
    const classroomId = await classroom()
    const groupingId = await grouping(classroomId)
    const team = await group(groupingId, classroomId, 'Distreet boys')
    const creatorId = await student('docente-fiuba')
    const { assignmentId } = await groupAssignment(classroomId, groupingId, creatorId)

    await db
      .insert(groupAssignmentRepos)
      .values({ groupAssignmentId: assignmentId, groupId: team, githubRepoId: 1 })

    // `validates :group, uniqueness: { scope: :group_assignment }`: the whole
    // team races the same button.
    await expect(
      db
        .insert(groupAssignmentRepos)
        .values({ groupAssignmentId: assignmentId, groupId: team, githubRepoId: 2 }),
    ).rejects.toThrow()
  })

  it('refuses one invite status per team and invitation', async () => {
    const classroomId = await classroom()
    const groupingId = await grouping(classroomId)
    const team = await group(groupingId, classroomId, 'Distreet boys')
    const creatorId = await student('docente-fiuba')
    const { invitationId } = await groupAssignment(classroomId, groupingId, creatorId)

    await db
      .insert(groupInviteStatuses)
      .values({ groupAssignmentInvitationId: invitationId, groupId: team, status: 'accepted' })

    // "should only have 1 invitation per group", GroupInviteStatus
    await expect(
      db
        .insert(groupInviteStatuses)
        .values({ groupAssignmentInvitationId: invitationId, groupId: team }),
    ).rejects.toThrow()
  })
})

/** A teacher of `organizationId`, which is what findTeachingClassroom asks for */
async function teacherOf(organizationId: number): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: `docente-${uid}` })
    .returning({ id: users.id })

  await db.insert(organizationsUsers).values({ organizationId, userId: user.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: `docente-${uid}` },
  } as Session
}

/** The classroom's slug, which the teacher-facing functions take */
async function slugOf(organizationId: number): Promise<string> {
  const [row] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))

  return row.slug
}

/** A student already on `groupId`, with a GitHub login to reconcile */
async function memberOf(groupId: number, groupingId: number, login: string): Promise<number> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: login })
    .returning({ id: users.id })

  await db.insert(groupsUsers).values({ groupId, groupingId, userId: user.id })

  return user.id
}

/** A repository for a team, both in the database and in the fake GitHub */
async function repositoryFor(
  assignmentId: number,
  groupId: number,
  fullName: string,
): Promise<void> {
  const githubRepoId = github.names.size + 6000
  github.names.set(githubRepoId, fullName)

  await db
    .insert(groupAssignmentRepos)
    .values({ groupAssignmentId: assignmentId, groupId, githubRepoId })
}

describe('moveMember', () => {
  it('moves the student and swaps their access between the two repositories', async () => {
    const classroomId = await classroom()
    const session = await teacherOf(classroomId)
    const groupingId = await grouping(classroomId)
    const from = await group(groupingId, classroomId, 'Distreet boys')
    const to = await group(groupingId, classroomId, 'threads')
    const userId = await memberOf(from, groupingId, 'lazcanoluca')

    const { assignmentId } = await groupAssignment(classroomId, groupingId, Number(session.user.id))
    await repositoryFor(assignmentId, from, 'fiubaTA050-labs/2026a-tp1-mapreduce-distreet-boys')
    await repositoryFor(assignmentId, to, 'fiubaTA050-labs/2026a-tp1-mapreduce-threads')

    const result = await moveMember(
      session,
      await slugOf(classroomId),
      'equipos-del-tp1',
      userId,
      to,
    )

    expect(result).toEqual({ success: true })

    const [membership] = await db.select().from(groupsUsers)
    expect(membership.groupId).toBe(to)

    // What the original got for free from the GitHub team, and this has to do
    // by hand: one repository loses them, the other gains them
    expect(github.removed).toEqual([
      { fullName: 'fiubaTA050-labs/2026a-tp1-mapreduce-distreet-boys', login: 'lazcanoluca' },
    ])
    expect(github.added).toEqual([
      {
        fullName: 'fiubaTA050-labs/2026a-tp1-mapreduce-threads',
        login: 'lazcanoluca',
        permission: 'push',
      },
    ])
  })

  it('takes the student off every repository when there is no destination', async () => {
    const classroomId = await classroom()
    const session = await teacherOf(classroomId)
    const groupingId = await grouping(classroomId)
    const from = await group(groupingId, classroomId, 'lala')
    const userId = await memberOf(from, groupingId, 'lazcanoluca')

    const { assignmentId } = await groupAssignment(classroomId, groupingId, Number(session.user.id))
    await repositoryFor(assignmentId, from, 'fiubaTA050-labs/2026a-tp1-mapreduce-lala')

    expect(
      await moveMember(session, await slugOf(classroomId), 'equipos-del-tp1', userId, null),
    ).toEqual({ success: true })

    expect(await db.select().from(groupsUsers)).toHaveLength(0)
    expect(github.removed).toHaveLength(1)
    expect(github.added).toHaveLength(0)
  })

  it('refuses a destination team from another set', async () => {
    const classroomId = await classroom()
    const session = await teacherOf(classroomId)
    const first = await grouping(classroomId, 'Equipos del TP1')
    const second = await grouping(classroomId, 'Equipos del TP3')
    const from = await group(first, classroomId, 'lala')
    const foreign = await group(second, classroomId, 'threads')
    const userId = await memberOf(from, first, 'lazcanoluca')

    const result = await moveMember(
      session,
      await slugOf(classroomId),
      'equipos-del-tp1',
      userId,
      foreign,
    )

    expect(result).toMatchObject({ success: false })
    expect(github.removed).toHaveLength(0)
  })

  it('refuses a classroom the caller does not teach', async () => {
    const classroomId = await classroom()
    const groupingId = await grouping(classroomId)
    const from = await group(groupingId, classroomId, 'lala')
    const userId = await memberOf(from, groupingId, 'lazcanoluca')

    // A teacher of some other classroom
    const other = await teacherOf(await classroom('TA050 2026b'))

    const result = await moveMember(
      other,
      await slugOf(classroomId),
      'equipos-del-tp1',
      userId,
      null,
    )

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(groupsUsers)).toHaveLength(1)
  })

  it('does nothing when the student is already on the destination', async () => {
    const classroomId = await classroom()
    const session = await teacherOf(classroomId)
    const groupingId = await grouping(classroomId)
    const team = await group(groupingId, classroomId, 'lala')
    const userId = await memberOf(team, groupingId, 'lazcanoluca')

    expect(
      await moveMember(session, await slugOf(classroomId), 'equipos-del-tp1', userId, team),
    ).toEqual({ success: true })

    expect(github.added).toHaveLength(0)
    expect(github.removed).toHaveLength(0)
  })
})

describe('listGroupAssignmentAcceptances', () => {
  it('reports each team with its status and who is on no team', async () => {
    const classroomId = await classroom()
    const session = await teacherOf(classroomId)
    const groupingId = await grouping(classroomId)
    const accepted = await group(groupingId, classroomId, 'Distreet boys')
    await group(groupingId, classroomId, 'threads')

    const { assignmentId, invitationId } = await groupAssignment(
      classroomId,
      groupingId,
      Number(session.user.id),
    )

    const onATeam = await memberOf(accepted, groupingId, 'lazcanoluca')

    await db
      .insert(groupInviteStatuses)
      .values({ groupAssignmentInvitationId: invitationId, groupId: accepted, status: 'completed' })

    const [roster] = await db
      .insert(rosters)
      .values({ identifierName: 'Padrón' })
      .returning({ id: rosters.id })

    await db
      .update(organizations)
      .set({ rosterId: roster.id })
      .where(eq(organizations.id, classroomId))

    await db.insert(rosterEntries).values([
      { rosterId: roster.id, identifier: '104001', userId: onATeam },
      { rosterId: roster.id, identifier: '104002' },
    ])

    const acceptances = await listGroupAssignmentAcceptances(
      session,
      await slugOf(classroomId),
      '2026a-tp1-mapreduce',
    )

    expect(acceptances?.teams).toEqual([
      expect.objectContaining({ title: 'Distreet boys', status: 'completed' }),
      // No row at all means unaccepted, the same split as invite_statuses
      expect.objectContaining({ title: 'threads', status: 'unaccepted' }),
    ])

    expect(acceptances?.identifierName).toBe('Padrón')
    expect(acceptances?.studentsNotOnTeam).toEqual([
      { identifier: '104002', githubLogin: null },
    ])

    // The assignment exists, which is what the id above is for
    expect(assignmentId).toBeGreaterThan(0)
  })

  /** What the dashboard resolves against GitHub, null until a repo exists */
  it('carries the repository id of the team that has one', async () => {
    const classroomId = await classroom()
    const session = await teacherOf(classroomId)
    const groupingId = await grouping(classroomId)
    const withRepo = await group(groupingId, classroomId, 'Distreet boys')
    await group(groupingId, classroomId, 'threads')

    const { assignmentId } = await groupAssignment(
      classroomId,
      groupingId,
      Number(session.user.id),
    )

    await db
      .insert(groupAssignmentRepos)
      .values({ groupAssignmentId: assignmentId, groupId: withRepo, githubRepoId: 987654 })

    const acceptances = await listGroupAssignmentAcceptances(
      session,
      await slugOf(classroomId),
      '2026a-tp1-mapreduce',
    )

    expect(acceptances?.teams.map((team) => [team.title, team.repoId])).toEqual([
      ['Distreet boys', 987654],
      ['threads', null],
    ])
  })

  it('returns null for a classroom the caller does not teach', async () => {
    const classroomId = await classroom()
    const groupingId = await grouping(classroomId)
    const creator = await teacherOf(classroomId)
    await groupAssignment(classroomId, groupingId, Number(creator.user.id))

    const other = await teacherOf(await classroom('TA050 2026b'))

    expect(
      await listGroupAssignmentAcceptances(
        other,
        await slugOf(classroomId),
        '2026a-tp1-mapreduce',
      ),
    ).toBeNull()
  })
})

describe('findGroupingForTeacher', () => {
  it('returns the set with its teams and members', async () => {
    const classroomId = await classroom()
    const session = await teacherOf(classroomId)
    const groupingId = await grouping(classroomId)
    const team = await group(groupingId, classroomId, 'lala')
    await memberOf(team, groupingId, 'lazcanoluca')

    const found = await findGroupingForTeacher(session, await slugOf(classroomId), 'equipos-del-tp1')

    expect(found).toMatchObject({ title: 'Equipos del TP1', slug: 'equipos-del-tp1' })
    expect(found?.teams[0].members[0].githubLogin).toBe('lazcanoluca')
  })

  it('returns null for another classroom’s set', async () => {
    const classroomId = await classroom()
    await grouping(classroomId)
    const other = await teacherOf(await classroom('TA050 2026b'))

    expect(
      await findGroupingForTeacher(other, await slugOf(classroomId), 'equipos-del-tp1'),
    ).toBeNull()
  })
})
