import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignments,
  groupAssignmentInvitations,
  groupAssignments,
  groupings,
  groups,
  organizations,
  organizationsUsers,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of spec/models/group_assignment_spec.rb, of spec/models/grouping_spec.rb
 * and of the GroupAssignmentsController#create cases in
 * spec/controllers/group_assignments_controller_spec.rb.
 *
 * The original's `.search` and `#flipper_id` cases have no counterpart: neither
 * stafftools nor Flipper is ported.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const findRepositoryByFullName = vi.fn()
const isRepositoryEmpty = vi.fn()

vi.mock('@/lib/github/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/repositories')>()),
  findRepositoryByFullName: (...args: unknown[]) => findRepositoryByFullName(...args),
  isRepositoryEmpty: (...args: unknown[]) => isRepositoryEmpty(...args),
}))

const TEMPLATE = {
  id: 987654,
  fullName: 'fiubaTA050-labs/raft-starter',
  htmlUrl: 'https://github.com/fiubaTA050-labs/raft-starter',
  private: true,
  isTemplate: true,
}

const { createGroupAssignment, findGroupAssignment, listGroupAssignments, listGroupings } =
  await import('@/lib/data/group-assignments')

let nextUid = 1
let nextGithubId = 1000
let nextSlug = 1

async function classroomTeacher(login = 'eespina-fiuba'): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: `${login}-${uid}` })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: login },
  } as Session
}

async function classroomOrg(
  session: Session,
  options: { archivedAt?: Date; githubId?: number } = {},
) {
  const githubId = options.githubId ?? nextGithubId++
  const slug = `${githubId}-${nextSlug++}-classroom`

  const [row] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: slug,
      slug,
      archivedAt: options.archivedAt ?? null,
    })
    .returning({ id: organizations.id, slug: organizations.slug, title: organizations.title })

  await db
    .insert(organizationsUsers)
    .values({ organizationId: row.id, userId: Number(session.user.id) })

  return row
}

async function existingGrouping(organizationId: number, title = 'Equipos del TP1') {
  const [row] = await db
    .insert(groupings)
    .values({ organizationId, title, slug: title.toLowerCase().replaceAll(' ', '-') })
    .returning({ id: groupings.id, slug: groupings.slug })

  return row
}

async function existingTeam(groupingId: number, organizationId: number, title: string) {
  await db
    .insert(groups)
    .values({ groupingId, organizationId, title, slug: title.toLowerCase() })
}

const VALID = {
  title: 'TP1 MapReduce',
  slug: '2026a-tp1-mapreduce',
  publicRepo: false,
  invitationsEnabled: true,
  studentsAreRepoAdmins: false,
  starterCodeRepo: '',
  groupingId: null,
  groupingTitle: 'Equipos formados en agosto',
  maxMembers: null,
  maxTeams: null,
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
  nextSlug = 1
  findRepositoryByFullName.mockResolvedValue(TEMPLATE)
  isRepositoryEmpty.mockResolvedValue(false)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('createGroupAssignment — successful creation', () => {
  it('creates the assignment, its invitation and a new set of teams', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    expect(await createGroupAssignment(session, classroom.slug, VALID)).toEqual({
      success: true,
      slug: '2026a-tp1-mapreduce',
    })

    const [grouping] = await db.select().from(groupings)
    expect(grouping.title).toBe('Equipos formados en agosto')
    expect(grouping.slug).toBe('equipos-formados-en-agosto')
    expect(grouping.organizationId).toBe(classroom.id)

    const [assignment] = await db.select().from(groupAssignments)
    expect(assignment.groupingId).toBe(grouping.id)
    expect(assignment.creatorId).toBe(Number(session.user.id))

    const invitations = await db
      .select()
      .from(groupAssignmentInvitations)
      .where(eq(groupAssignmentInvitations.groupAssignmentId, assignment.id))

    expect(invitations).toHaveLength(1)
    // SecureRandom.hex(16)
    expect(invitations[0].key).toMatch(/^[0-9a-f]{32}$/)
  })

  // GroupAssignmentService: `Grouping.where(id:).first_or_initialize(title:)`
  it('reuses the set of teams the teacher chose', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    const grouping = await existingGrouping(classroom.id)

    await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      groupingId: grouping.id,
      // Ignored when an id came in, exactly as first_or_initialize does
      groupingTitle: 'Otro nombre',
    })

    expect(await db.select().from(groupings)).toHaveLength(1)

    const [assignment] = await db.select().from(groupAssignments)
    expect(assignment.groupingId).toBe(grouping.id)
  })

  it('stores the two limits', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      maxMembers: 4,
      maxTeams: 20,
    })

    const [assignment] = await db.select().from(groupAssignments)
    expect(assignment.maxMembers).toBe(4)
    expect(assignment.maxTeams).toBe(20)
  })

  // "sets invitations_enabled to true by default" / "#public?" / "#private?"
  it('honours the flags and the visibility', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      publicRepo: true,
      invitationsEnabled: false,
      studentsAreRepoAdmins: true,
    })

    const [assignment] = await db.select().from(groupAssignments)
    expect(assignment.publicRepo).toBe(true)
    expect(assignment.invitationsEnabled).toBe(false)
    expect(assignment.studentsAreRepoAdmins).toBe(true)
  })
})

describe('createGroupAssignment — the set of teams', () => {
  // GroupAssignmentService#grouping_info_valid?, then `validates :grouping, presence: true`
  it('refuses to create without a set of teams', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      groupingId: null,
      groupingTitle: '   ',
    })

    expect(result).toMatchObject({ success: false, field: 'grouping' })
    expect(await db.select().from(groupAssignments)).toHaveLength(0)
  })

  // "You are not permitted to select this set of teams"
  it('refuses a set of teams from another classroom', async () => {
    const session = await classroomTeacher()
    const mine = await classroomOrg(session)
    const other = await classroomOrg(await classroomTeacher('otro-docente'))
    const grouping = await existingGrouping(other.id)

    const result = await createGroupAssignment(session, mine.slug, {
      ...VALID,
      groupingId: grouping.id,
    })

    expect(result).toMatchObject({ success: false, field: 'grouping' })
  })

  // grouping_spec.rb "verifies that the slug is unique even if the titles are unique"
  it('refuses a new set whose slug is taken in the classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await existingGrouping(classroom.id, 'Equipos del TP1')

    const result = await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      groupingTitle: 'equipos del tp1',
    })

    expect(result).toMatchObject({ success: false, field: 'grouping' })
  })

  it('refuses a set of teams whose name has nothing to slug', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      groupingTitle: '¡!¿?',
    })

    expect(result).toMatchObject({ success: false, field: 'grouping' })
  })
})

describe('createGroupAssignment — limits', () => {
  // "raises exception when creating new assignment with grouping group count
  // greater than max_teams"
  it('refuses max_teams below the number of teams already in the set', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    const grouping = await existingGrouping(classroom.id)
    await existingTeam(grouping.id, classroom.id, 'lala')
    await existingTeam(grouping.id, classroom.id, 'threads')

    const result = await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      groupingId: grouping.id,
      maxTeams: 1,
    })

    expect(result).toMatchObject({ success: false, field: 'maxTeams' })
  })

  // "does not raise an exception when existing group count is less than or
  // equal to max_teams limit"
  it('allows max_teams equal to the number of teams already in the set', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    const grouping = await existingGrouping(classroom.id)
    await existingTeam(grouping.id, classroom.id, 'lala')
    await existingTeam(grouping.id, classroom.id, 'threads')

    const result = await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      groupingId: grouping.id,
      maxTeams: 2,
    })

    expect(result).toMatchObject({ success: true })
  })

  // Divergence: the original stores a 0 happily and then tells every student
  // "This team has reached its maximum member limit of 0"
  it('refuses limits below one', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    expect(await createGroupAssignment(session, classroom.slug, { ...VALID, maxMembers: 0 })).toMatchObject(
      { success: false, field: 'maxMembers' },
    )
    expect(await createGroupAssignment(session, classroom.slug, { ...VALID, maxTeams: 0 })).toMatchObject(
      { success: false, field: 'maxTeams' },
    )
  })
})

describe('createGroupAssignment — names', () => {
  // "validates that an Assignment in the same organization does not have the same slug"
  it('refuses a prefix an individual assignment already holds', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await db.insert(assignments).values({
      organizationId: classroom.id,
      creatorId: Number(session.user.id),
      title: 'Otro TP',
      slug: VALID.slug,
    })

    expect(await createGroupAssignment(session, classroom.slug, VALID)).toMatchObject({
      success: false,
      field: 'slug',
    })
  })

  it('refuses a prefix used by another classroom of the same GitHub org', async () => {
    const session = await classroomTeacher()
    const first = await classroomOrg(session, { githubId: 4242 })
    const second = await classroomOrg(session, { githubId: 4242 })

    await createGroupAssignment(session, first.slug, VALID)
    const result = await createGroupAssignment(session, second.slug, {
      ...VALID,
      title: 'Otro título',
      groupingTitle: 'Otro conjunto',
    })

    expect(result).toMatchObject({ success: false, field: 'slug' })
  })

  // "allows two organizations to have the same GroupAssignment title and slug"
  it('allows two classrooms in different GitHub orgs to share a title and prefix', async () => {
    const session = await classroomTeacher()
    const first = await classroomOrg(session)
    const second = await classroomOrg(session)

    expect(await createGroupAssignment(session, first.slug, VALID)).toMatchObject({ success: true })
    expect(await createGroupAssignment(session, second.slug, VALID)).toMatchObject({ success: true })
  })

  // "uniqueness of title across organization"
  it('refuses a title already used in the same classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createGroupAssignment(session, classroom.slug, VALID)
    const result = await createGroupAssignment(session, classroom.slug, {
      ...VALID,
      slug: 'otro-prefijo',
      groupingTitle: 'Otro conjunto',
    })

    expect(result).toMatchObject({ success: false, field: 'title' })
  })

  // "title blacklist"
  it('disallows blacklisted titles', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createGroupAssignment(session, classroom.slug, { ...VALID, title: 'new' })
    expect(result).toMatchObject({ success: false, field: 'title' })
  })
})

describe('createGroupAssignment — authorization', () => {
  // "is invalid if the organization has been archived"
  it('refuses to create in an archived classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session, { archivedAt: new Date() })

    expect(await createGroupAssignment(session, classroom.slug, VALID)).toMatchObject({
      success: false,
      field: 'base',
    })
  })

  it('refuses a classroom that is not the teacher’s', async () => {
    const session = await classroomTeacher()
    const other = await classroomOrg(await classroomTeacher('otro-docente'))

    expect(await createGroupAssignment(session, other.slug, VALID)).toMatchObject({
      success: false,
      field: 'base',
    })
  })
})

describe('listGroupAssignments and listGroupings', () => {
  it('lists the assignment with its set of teams and invitation key', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createGroupAssignment(session, classroom.slug, { ...VALID, maxMembers: 3 })

    const [listed] = await listGroupAssignments(session, classroom.slug)
    expect(listed.title).toBe('TP1 MapReduce')
    expect(listed.maxMembers).toBe(3)
    expect(listed.grouping.title).toBe('Equipos formados en agosto')
    expect(listed.invitationKey).toMatch(/^[0-9a-f]{32}$/)

    const found = await findGroupAssignment(session, classroom.slug, listed.slug)
    expect(found).toEqual(listed)
  })

  it('does not list another teacher’s classroom', async () => {
    const session = await classroomTeacher()
    const other = await classroomOrg(await classroomTeacher('otro-docente'))

    expect(await listGroupAssignments(session, other.slug)).toEqual([])
    expect(await findGroupAssignment(session, other.slug, VALID.slug)).toBeNull()
  })

  // What the "Choose an existing set of teams" select renders
  it('counts the teams of each set', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    const first = await existingGrouping(classroom.id, 'Equipos del TP1')
    await existingGrouping(classroom.id, 'Equipos del TP3')
    await existingTeam(first.id, classroom.id, 'lala')
    await existingTeam(first.id, classroom.id, 'threads')

    expect(await listGroupings(session, classroom.slug)).toEqual([
      { id: first.id, title: 'Equipos del TP1', slug: 'equipos-del-tp1', teamCount: 2 },
      expect.objectContaining({ title: 'Equipos del TP3', teamCount: 0 }),
    ])
  })
})
