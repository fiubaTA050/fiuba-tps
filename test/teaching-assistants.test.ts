import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  groupAssignments,
  groupings,
  groups,
  groupsUsers,
  inviteStatuses,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  teachingAssistantAllocations,
  teachingAssistants,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * The schema and the authorization boundary of docs/teaching-assistants.md.
 * Nothing to port: the original has no teaching-assistant role.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

vi.mock('@/lib/github/organizations', () => ({
  listUserOrganizations: vi.fn(),
  setDefaultRepositoryPermissionToNone: vi.fn(),
  findOrganizationByInstallation: vi.fn(),
  findInstallationAccount: vi.fn(),
}))

const findGitHubUserByLogin = vi.fn()

vi.mock('@/lib/github/users', () => ({
  findGitHubUserByLogin: (...args: unknown[]) => findGitHubUserByLogin(...args),
}))

const { classroomCounters, findClassroomRole, findTeachingClassroom } = await import(
  '@/lib/data/organizations'
)
const {
  addTeachingAssistant,
  listAllocations,
  listClassroomStaff,
  removeTeachingAssistant,
  setAllocation,
} = await import('@/lib/data/teaching-assistants')
const { createApiKey, sessionFromApiKey } = await import('@/lib/data/api-keys')

let nextUid = 1

async function user(login: string): Promise<Session> {
  const uid = nextUid++
  const [row] = await db
    .insert(users)
    .values({ uid, githubLogin: login })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    // What the `session` callback of auth.ts sets on every browser login
    via: 'browser',
    user: { id: String(row.id), uid, githubLogin: login },
  } as Session
}

/**
 * The name of the constraint a write was refused by. Asserting it, rather than
 * just that the write threw, keeps each test on the rule it claims to cover:
 * a fixture mistake would throw too. Drizzle wraps the driver error, so walk
 * the cause chain — the same walk as `hasPostgresCode` in lib/data/postgres.ts.
 */
async function refusedBy(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write
  } catch (error) {
    for (let current = error; current; current = (current as { cause?: unknown }).cause) {
      const constraint = (current as { constraint?: string }).constraint
      if (constraint) return constraint
    }
    throw error
  }
  throw new Error('the write went through')
}

const idOf = (session: Session) => Number(session.user.id)

async function classroom(slug: string, teacher: Session): Promise<number> {
  const [row] = await db
    .insert(organizations)
    .values({ githubId: 4321, installationId: 99, title: slug, slug })
    .returning({ id: organizations.id })
  await db.insert(organizationsUsers).values({ organizationId: row.id, userId: idOf(teacher) })
  return row.id
}

async function assistant(organizationId: number, ta: Session, teacher: Session): Promise<number> {
  const [row] = await db
    .insert(teachingAssistants)
    .values({ organizationId, userId: idOf(ta), createdByUserId: idOf(teacher) })
    .returning({ id: teachingAssistants.id })
  return row.id
}

async function assignment(organizationId: number, teacher: Session, slug: string) {
  const [row] = await db
    .insert(assignments)
    .values({ organizationId, creatorId: idOf(teacher), title: slug, slug })
    .returning({ id: assignments.id })
  return row.id
}

async function rosterEntry(identifier: string): Promise<number> {
  const [roster] = await db
    .insert(rosters)
    .values({ identifierName: 'Padrón' })
    .returning({ id: rosters.id })
  const [entry] = await db
    .insert(rosterEntries)
    .values({ rosterId: roster.id, identifier })
    .returning({ id: rosterEntries.id })
  return entry.id
}

async function grouping(organizationId: number, title: string): Promise<number> {
  const [row] = await db
    .insert(groupings)
    .values({ organizationId, title, slug: title })
    .returning({ id: groupings.id })
  return row.id
}

async function team(groupingId: number, organizationId: number, title: string) {
  const [row] = await db
    .insert(groups)
    .values({ groupingId, organizationId, title, slug: title })
    .returning({ id: groups.id })
  return row.id
}

async function groupAssignment(
  organizationId: number,
  groupingId: number,
  teacher: Session,
  slug: string,
) {
  const [row] = await db
    .insert(groupAssignments)
    .values({ organizationId, groupingId, creatorId: idOf(teacher), title: slug, slug })
    .returning({ id: groupAssignments.id })
  return row.id
}

let profe: Session
let ta: Session

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  findGitHubUserByLogin.mockReset()
  profe = await user('profe')
  ta = await user('ayudante')
})

describe('teaching_assistant_allocations', () => {
  it('allocates a roster entry in an individual assignment, once', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    const tp = await assignment(org, profe, 'tp0')
    const entry = await rosterEntry('100000')
    const row = {
      teachingAssistantId: taId,
      organizationId: org,
      assignmentId: tp,
      rosterEntryId: entry,
      createdByUserId: idOf(profe),
    }

    await db.insert(teachingAssistantAllocations).values(row)

    expect(await refusedBy(db.insert(teachingAssistantAllocations).values(row))).toBe(
      'index_ta_allocations_on_ta_and_roster_entry',
    )
  })

  it('refuses a row that names both kinds, or neither', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    const tp = await assignment(org, profe, 'tp0')
    const entry = await rosterEntry('100000')
    const set = await grouping(org, 'equipos')
    const tp1 = await groupAssignment(org, set, profe, 'tp1')
    const los = await team(set, org, 'los-raft')
    const base = { teachingAssistantId: taId, organizationId: org, createdByUserId: idOf(profe) }

    const insert = (values: Partial<typeof teachingAssistantAllocations.$inferInsert>) =>
      refusedBy(db.insert(teachingAssistantAllocations).values({ ...base, ...values }))

    for (const values of [
      // both kinds
      {
        assignmentId: tp,
        rosterEntryId: entry,
        groupAssignmentId: tp1,
        groupingId: set,
        groupId: los,
      },
      // neither
      {},
      // half a pair is not a target either
      { assignmentId: tp },
      { groupAssignmentId: tp1, groupingId: set },
    ]) {
      expect(await insert(values)).toBe('teaching_assistant_allocations_one_target')
    }
  })

  it('refuses an assignment of another classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', profe)
    const taId = await assistant(org, ta, profe)
    const foreign = await assignment(other, profe, 'tp0-viejo')
    const entry = await rosterEntry('100000')

    expect(
      await refusedBy(
        db.insert(teachingAssistantAllocations).values({
          teachingAssistantId: taId,
          organizationId: org,
          assignmentId: foreign,
          rosterEntryId: entry,
          createdByUserId: idOf(profe),
        }),
      ),
    ).toBe('ta_allocations_assignment_fkey')
  })

  it('refuses a TA of another classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', profe)
    const taOfOther = await assistant(other, ta, profe)
    const tp = await assignment(org, profe, 'tp0')
    const entry = await rosterEntry('100000')

    expect(
      await refusedBy(
        db.insert(teachingAssistantAllocations).values({
          teachingAssistantId: taOfOther,
          organizationId: org,
          assignmentId: tp,
          rosterEntryId: entry,
          createdByUserId: idOf(profe),
        }),
      ),
    ).toBe('ta_allocations_teaching_assistant_fkey')
  })

  it('refuses a team outside the grouping the assignment runs on', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    const set = await grouping(org, 'equipos')
    const otherSet = await grouping(org, 'otros-equipos')
    const tp1 = await groupAssignment(org, set, profe, 'tp1')
    const stranger = await team(otherSet, org, 'ajenos')
    const base = {
      teachingAssistantId: taId,
      organizationId: org,
      groupAssignmentId: tp1,
      groupId: stranger,
      createdByUserId: idOf(profe),
    }

    // Claiming the assignment's grouping: the team is not in it
    expect(
      await refusedBy(
        db.insert(teachingAssistantAllocations).values({ ...base, groupingId: set }),
      ),
    ).toBe('ta_allocations_group_fkey')
    // Claiming the team's grouping: the assignment does not run on it
    expect(
      await refusedBy(
        db.insert(teachingAssistantAllocations).values({ ...base, groupingId: otherSet }),
      ),
    ).toBe('ta_allocations_group_assignment_fkey')
  })

  it('lets a team have several TAs in the same assignment', async () => {
    const org = await classroom('sd-2026-1', profe)
    const otro = await user('otro-ayudante')
    const set = await grouping(org, 'equipos')
    const tp1 = await groupAssignment(org, set, profe, 'tp1')
    const los = await team(set, org, 'los-raft')

    for (const who of [ta, otro]) {
      await db.insert(teachingAssistantAllocations).values({
        teachingAssistantId: await assistant(org, who, profe),
        organizationId: org,
        groupAssignmentId: tp1,
        groupingId: set,
        groupId: los,
        createdByUserId: idOf(profe),
      })
    }

    expect(await db.select().from(teachingAssistantAllocations)).toHaveLength(2)
  })

  it('goes away with the TA, the roster entry or the team', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    const tp = await assignment(org, profe, 'tp0')
    const entry = await rosterEntry('100000')
    const set = await grouping(org, 'equipos')
    const tp1 = await groupAssignment(org, set, profe, 'tp1')
    const los = await team(set, org, 'los-raft')
    const allocate = () =>
      db.insert(teachingAssistantAllocations).values([
        {
          teachingAssistantId: taId,
          organizationId: org,
          assignmentId: tp,
          rosterEntryId: entry,
          createdByUserId: idOf(profe),
        },
        {
          teachingAssistantId: taId,
          organizationId: org,
          groupAssignmentId: tp1,
          groupingId: set,
          groupId: los,
          createdByUserId: idOf(profe),
        },
      ])

    await allocate()
    await db.delete(rosterEntries).where(eq(rosterEntries.id, entry))
    await db.delete(groups).where(eq(groups.id, los))
    expect(await db.select().from(teachingAssistantAllocations)).toHaveLength(0)

    const entry2 = await rosterEntry('100001')
    const los2 = await team(set, org, 'los-paxos')
    await db.insert(teachingAssistantAllocations).values({
      teachingAssistantId: taId,
      organizationId: org,
      assignmentId: tp,
      rosterEntryId: entry2,
      createdByUserId: idOf(profe),
    })
    await db.insert(teachingAssistantAllocations).values({
      teachingAssistantId: taId,
      organizationId: org,
      groupAssignmentId: tp1,
      groupingId: set,
      groupId: los2,
      createdByUserId: idOf(profe),
    })
    await db.delete(teachingAssistants).where(eq(teachingAssistants.id, taId))
    expect(await db.select().from(teachingAssistantAllocations)).toHaveLength(0)
  })

  it('refuses the same user twice as TA of one classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)

    expect(await refusedBy(assistant(org, ta, profe))).toBe(
      'index_teaching_assistants_on_organization_id_and_user_id',
    )
  })
})

describe('findClassroomRole', () => {
  it('is teacher for a row of organizations_users', async () => {
    const org = await classroom('sd-2026-1', profe)

    expect(await findClassroomRole(profe, 'sd-2026-1')).toMatchObject({
      role: 'teacher',
      classroom: { id: org },
    })
  })

  it('is assistant for a row of teaching_assistants', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)

    expect(await findClassroomRole(ta, 'sd-2026-1')).toEqual({
      role: 'assistant',
      classroom: { id: org, githubId: 4321, installationId: 99, archivedAt: null },
      teachingAssistantId: taId,
    })
  })

  it('is null for anybody else, and for a classroom that does not exist', async () => {
    await classroom('sd-2026-1', profe)
    const alumno = await user('alumno')

    expect(await findClassroomRole(alumno, 'sd-2026-1')).toBeNull()
    expect(await findClassroomRole(profe, 'no-existe')).toBeNull()
  })

  it('is null in a classroom where the user is TA of another one', async () => {
    await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', profe)
    await assistant(other, ta, profe)

    expect(await findClassroomRole(ta, 'sd-2026-1')).toBeNull()
  })

  it('is null for a soft-deleted classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)
    await db.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, org))

    expect(await findClassroomRole(profe, 'sd-2026-1')).toBeNull()
    expect(await findClassroomRole(ta, 'sd-2026-1')).toBeNull()
  })

  it('makes a teacher win over a stale TA row', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)
    await db.insert(organizationsUsers).values({ organizationId: org, userId: idOf(ta) })

    expect(await findClassroomRole(ta, 'sd-2026-1')).toMatchObject({ role: 'teacher' })
  })

  it('never grants the TA role to a session not marked as a browser login', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)
    // A session built by hand somewhere, with no `via` at all
    const unmarked = { ...ta, via: undefined }

    expect(await findClassroomRole(unmarked, 'sd-2026-1')).toBeNull()
  })

  it('never grants the TA role through an API key, and still grants teacher', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)
    const taKey = await createApiKey(ta, 'mia', ['classroom:read'])
    const profeKey = await createApiKey(profe, 'mia', ['classroom:read'])

    const taSession = (await sessionFromApiKey(taKey.rawKey))!.session
    const profeSession = (await sessionFromApiKey(profeKey.rawKey))!.session

    expect(taSession.via).toBe('api-key')
    expect(await findClassroomRole(taSession, 'sd-2026-1')).toBeNull()
    expect(await findClassroomRole(profeSession, 'sd-2026-1')).toMatchObject({ role: 'teacher' })
  })
})

describe('the boundary every existing function uses', () => {
  it('keeps a TA out of findTeachingClassroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)

    expect(await findTeachingClassroom(ta, 'sd-2026-1')).toBeNull()
    expect(await findTeachingClassroom(profe, 'sd-2026-1')).toMatchObject({ id: org })
  })
})

/** What `GET /users/{login}` answers for an account that exists */
function githubAccount(id: number, login: string) {
  return {
    id,
    login,
    name: null,
    avatarUrl: `https://avatars.githubusercontent.com/u/${id}`,
    htmlUrl: `https://github.com/${login}`,
  }
}

describe('addTeachingAssistant', () => {
  it('adds an account that never signed in, creating its users row by GitHub id', async () => {
    const org = await classroom('sd-2026-1', profe)
    findGitHubUserByLogin.mockResolvedValue(githubAccount(517713, 'eespina-hu'))

    const result = await addTeachingAssistant(profe, 'sd-2026-1', '  @eespina-hu ')

    expect(result).toEqual({ success: true, login: 'eespina-hu' })
    expect(findGitHubUserByLogin).toHaveBeenCalledWith(profe, 'eespina-hu')
    const [row] = await db
      .select({ uid: users.uid, organizationId: teachingAssistants.organizationId })
      .from(teachingAssistants)
      .innerJoin(users, eq(users.id, teachingAssistants.userId))
    expect(row).toEqual({ uid: 517713, organizationId: org })
  })

  it('reuses the users row of an account that already signed in, and catches a rename', async () => {
    await classroom('sd-2026-1', profe)
    findGitHubUserByLogin.mockResolvedValue(githubAccount(ta.user.uid, 'ayudante-renombrado'))

    await addTeachingAssistant(profe, 'sd-2026-1', 'ayudante-renombrado')

    const all = await db.select().from(users)
    expect(all).toHaveLength(2)
    expect(all.find((u) => u.id === idOf(ta))?.githubLogin).toBe('ayudante-renombrado')
    expect(await findClassroomRole(ta, 'sd-2026-1')).toMatchObject({ role: 'assistant' })
  })

  it('refuses a malformed login without asking GitHub', async () => {
    await classroom('sd-2026-1', profe)

    for (const login of ['', 'con espacio', '-guion', 'con_guion_bajo', 'a'.repeat(40)]) {
      expect(await addTeachingAssistant(profe, 'sd-2026-1', login)).toMatchObject({
        success: false,
      })
    }
    expect(findGitHubUserByLogin).not.toHaveBeenCalled()
  })

  it('refuses an account GitHub does not know', async () => {
    await classroom('sd-2026-1', profe)
    findGitHubUserByLogin.mockResolvedValue(null)

    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'nadie')).toEqual({
      success: false,
      error: 'No existe la cuenta @nadie en GitHub.',
    })
    expect(await db.select().from(teachingAssistants)).toHaveLength(0)
  })

  it('refuses an account that is already a TA or a teacher of the classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)

    findGitHubUserByLogin.mockResolvedValue(githubAccount(ta.user.uid, 'ayudante'))
    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'ayudante')).toEqual({
      success: false,
      error: '@ayudante ya es ayudante de este classroom.',
    })

    findGitHubUserByLogin.mockResolvedValue(githubAccount(profe.user.uid, 'profe'))
    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'profe')).toEqual({
      success: false,
      error: '@profe ya es profesor de este classroom.',
    })
  })

  it('refuses a student of the classroom, however they are one', async () => {
    const org = await classroom('sd-2026-1', profe)
    const porPadron = await user('por-padron')
    const porRepo = await user('por-repo')
    const porEquipo = await user('por-equipo')

    const [roster] = await db
      .insert(rosters)
      .values({ identifierName: 'Padrón' })
      .returning({ id: rosters.id })
    await db.update(organizations).set({ rosterId: roster.id }).where(eq(organizations.id, org))
    await db
      .insert(rosterEntries)
      .values({ rosterId: roster.id, identifier: '100000', userId: idOf(porPadron) })

    const tp0 = await assignment(org, profe, 'tp0')
    await db
      .insert(assignmentRepos)
      .values({ githubRepoId: 1, assignmentId: tp0, userId: idOf(porRepo) })

    const set = await grouping(org, 'equipos')
    const los = await team(set, org, 'los-raft')
    await db
      .insert(groupsUsers)
      .values({ groupId: los, groupingId: set, userId: idOf(porEquipo) })

    // Accepted, and the repository not created yet
    const porInvitacion = await user('por-invitacion')
    await acceptedWithoutRepo(tp0, porInvitacion)

    for (const student of [porPadron, porRepo, porEquipo, porInvitacion]) {
      const login = student.user.githubLogin
      findGitHubUserByLogin.mockResolvedValue(githubAccount(student.user.uid, login))
      expect(await addTeachingAssistant(profe, 'sd-2026-1', login)).toEqual({
        success: false,
        error: `@${login} es alumno de este classroom: no puede ser ayudante.`,
      })
    }
    expect(await db.select().from(teachingAssistants)).toHaveLength(0)
  })

  it('accepts a student of another classroom', async () => {
    await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', profe)
    const exAlumno = await user('ex-alumno')
    const tp0 = await assignment(other, profe, 'tp0-viejo')
    await db
      .insert(assignmentRepos)
      .values({ githubRepoId: 1, assignmentId: tp0, userId: idOf(exAlumno) })
    findGitHubUserByLogin.mockResolvedValue(githubAccount(exAlumno.user.uid, 'ex-alumno'))

    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'ex-alumno')).toMatchObject({
      success: true,
    })
  })

  it('refuses on an archived classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    await db.update(organizations).set({ archivedAt: new Date() }).where(eq(organizations.id, org))

    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'ayudante')).toMatchObject({
      success: false,
    })
    expect(findGitHubUserByLogin).not.toHaveBeenCalled()
  })

  it('is closed to a TA of the classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)
    const otro = await user('otro')
    findGitHubUserByLogin.mockResolvedValue(githubAccount(otro.user.uid, 'otro'))

    expect(await addTeachingAssistant(ta, 'sd-2026-1', 'otro')).toEqual({
      success: false,
      error: 'No se encontró el classroom.',
    })
  })
})

describe('removeTeachingAssistant', () => {
  it('removes the TA and its allocations', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    await db.insert(teachingAssistantAllocations).values({
      teachingAssistantId: taId,
      organizationId: org,
      assignmentId: await assignment(org, profe, 'tp0'),
      rosterEntryId: await rosterEntry('100000'),
      createdByUserId: idOf(profe),
    })

    expect(await removeTeachingAssistant(profe, 'sd-2026-1', taId)).toEqual({ success: true })
    expect(await db.select().from(teachingAssistantAllocations)).toHaveLength(0)
    expect(await findClassroomRole(ta, 'sd-2026-1')).toBeNull()
  })

  it('refuses the TA id of another classroom', async () => {
    await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', await user('otro-profe'))
    const taId = await assistant(other, ta, profe)

    expect(await removeTeachingAssistant(profe, 'sd-2026-1', taId)).toMatchObject({
      success: false,
    })
    expect(await db.select().from(teachingAssistants)).toHaveLength(1)
  })

  it('works on an archived classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    await db.update(organizations).set({ archivedAt: new Date() }).where(eq(organizations.id, org))

    expect(await removeTeachingAssistant(profe, 'sd-2026-1', taId)).toMatchObject({
      success: true,
    })
  })

  it('is closed to a TA, even to remove themselves', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)

    expect(await removeTeachingAssistant(ta, 'sd-2026-1', taId)).toMatchObject({
      success: false,
    })
    expect(await db.select().from(teachingAssistants)).toHaveLength(1)
  })
})

describe('listClassroomStaff and countClassroomStaff', () => {
  it('lists teachers and TAs, flagging a TA who is also a teacher', async () => {
    const org = await classroom('sd-2026-1', profe)
    const ascendido = await user('ascendido')
    await assistant(org, ta, profe)
    await assistant(org, ascendido, profe)
    await db.insert(organizationsUsers).values({ organizationId: org, userId: idOf(ascendido) })

    const staff = await listClassroomStaff(profe, 'sd-2026-1')

    expect(staff?.teachers.map((t) => t.githubLogin)).toEqual(['ascendido', 'profe'])
    expect(staff?.assistants).toEqual([
      expect.objectContaining({ githubLogin: 'ascendido', alsoTeacher: true }),
      expect.objectContaining({ githubLogin: 'ayudante', alsoTeacher: false }),
    ])
    // Three people: `ascendido` is on both lists
    expect(await classroomCounters(profe, 'sd-2026-1')).toMatchObject({ staff: 3 })
  })

  it('is null for a TA, who gets no tab', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)

    expect(await listClassroomStaff(ta, 'sd-2026-1')).toBeNull()
    expect(await classroomCounters(ta, 'sd-2026-1')).toBeNull()
  })
})

/** An accepted invitation whose repository does not exist yet */
async function acceptedWithoutRepo(assignmentId: number, student: Session) {
  const [invitation] = await db
    .insert(assignmentInvitations)
    .values({ key: `key-${assignmentId}-${student.user.id}`, assignmentId })
    .returning({ id: assignmentInvitations.id })
  await db
    .insert(inviteStatuses)
    .values({ assignmentInvitationId: invitation.id, userId: idOf(student), status: 'accepted' })
}

describe('the fixes of the review of the Docentes tab', () => {
  it('takes the TA role away from a TA who becomes a student of the classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)
    expect(await findClassroomRole(ta, 'sd-2026-1')).toMatchObject({ role: 'assistant' })

    await acceptedWithoutRepo(await assignment(org, profe, 'tp0'), ta)

    expect(await findClassroomRole(ta, 'sd-2026-1')).toBeNull()
  })

  it('keeps the TA role for a student of another classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', profe)
    await assistant(org, ta, profe)
    await acceptedWithoutRepo(await assignment(other, profe, 'tp0-viejo'), ta)

    expect(await findClassroomRole(ta, 'sd-2026-1')).toMatchObject({ role: 'assistant' })
  })

  it('answers a GitHub failure with a message instead of throwing', async () => {
    await classroom('sd-2026-1', profe)
    findGitHubUserByLogin.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 }))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'ayudante')).toEqual({
      success: false,
      error: 'No pudimos consultar GitHub. Probá de nuevo en un rato.',
    })
    quiet.mockRestore()
  })

  it('accepts a legacy login GitHub no longer allows at sign-up', async () => {
    await classroom('sd-2026-1', profe)
    findGitHubUserByLogin.mockResolvedValue(githubAccount(9001, 'viejo--usuario-'))

    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'viejo--usuario-')).toEqual({
      success: true,
      login: 'viejo--usuario-',
    })
  })

  it('leaves no users row behind when the add is refused', async () => {
    await classroom('sd-2026-1', profe)
    const before = await db.select().from(users)
    // A real account that is a teacher: refused before anything is written
    findGitHubUserByLogin.mockResolvedValue(githubAccount(profe.user.uid, 'profe-renombrado'))

    expect(await addTeachingAssistant(profe, 'sd-2026-1', 'profe-renombrado')).toMatchObject({
      success: false,
    })
    expect(await db.select().from(users)).toEqual(before)
  })

  it('stores the avatar by account id and lists it', async () => {
    await classroom('sd-2026-1', profe)
    findGitHubUserByLogin.mockResolvedValue(githubAccount(517713, 'eespina-hu'))
    await addTeachingAssistant(profe, 'sd-2026-1', 'eespina-hu')

    const staff = await listClassroomStaff(profe, 'sd-2026-1')

    expect(staff?.assistants[0].githubAvatarUrl).toBe(
      'https://avatars.githubusercontent.com/u/517713',
    )
  })

  it('counts assignments of both kinds, roster entries and staff in one call', async () => {
    const org = await classroom('sd-2026-1', profe)
    expect(await classroomCounters(profe, 'sd-2026-1')).toEqual({
      assignments: 0,
      students: null,
      staff: 1,
    })

    await assignment(org, profe, 'tp0')
    await groupAssignment(org, await grouping(org, 'equipos'), profe, 'tp1')
    const [roster] = await db
      .insert(rosters)
      .values({ identifierName: 'Padrón' })
      .returning({ id: rosters.id })
    await db.update(organizations).set({ rosterId: roster.id }).where(eq(organizations.id, org))
    await db.insert(rosterEntries).values([
      { rosterId: roster.id, identifier: '100000' },
      { rosterId: roster.id, identifier: '100001' },
    ])
    await assistant(org, ta, profe)

    expect(await classroomCounters(profe, 'sd-2026-1')).toEqual({
      assignments: 2,
      students: 2,
      staff: 2,
    })
  })
})

/** A classroom with a roster of `identifiers`, returning the entry ids in order */
async function rosterOf(organizationId: number, identifiers: string[]): Promise<number[]> {
  const [roster] = await db
    .insert(rosters)
    .values({ identifierName: 'Padrón' })
    .returning({ id: rosters.id })
  await db
    .update(organizations)
    .set({ rosterId: roster.id })
    .where(eq(organizations.id, organizationId))
  const rows = await db
    .insert(rosterEntries)
    .values(identifiers.map((identifier) => ({ rosterId: roster.id, identifier })))
    .returning({ id: rosterEntries.id })
  return rows.map((row) => row.id)
}

describe('setAllocation and listAllocations', () => {
  it('allocates and takes off a TA over several padrones of an individual assignment', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    await assignment(org, profe, 'tp0')
    const [a, b, c] = await rosterOf(org, ['100000', '100001', '100002'])
    const allocate = (targetIds: number[], on: boolean) =>
      setAllocation(profe, 'sd-2026-1', 'tp0', 'individual', {
        teachingAssistantId: taId,
        targetIds,
        allocate: on,
      })

    expect(await allocate([a, b, b], true)).toEqual({ success: true })
    // Again, overlapping: a no-op for what was already there
    expect(await allocate([b, c], true)).toEqual({ success: true })

    let listed = await listAllocations(profe, 'sd-2026-1', 'tp0', 'individual')
    expect(listed?.assistants).toEqual([{ id: taId, githubLogin: 'ayudante' }])
    expect(Object.fromEntries(listed!.byTarget)).toEqual({ [a]: [taId], [b]: [taId], [c]: [taId] })

    expect(await allocate([a, c], false)).toEqual({ success: true })
    listed = await listAllocations(profe, 'sd-2026-1', 'tp0', 'individual')
    expect(Object.fromEntries(listed!.byTarget)).toEqual({ [b]: [taId] })
  })

  it('keeps assignments apart, and gives a row several TAs', async () => {
    const org = await classroom('sd-2026-1', profe)
    const otro = await user('otro-ayudante')
    const taId = await assistant(org, ta, profe)
    const otroId = await assistant(org, otro, profe)
    await assignment(org, profe, 'tp0')
    await assignment(org, profe, 'tp3')
    const [a] = await rosterOf(org, ['100000'])

    for (const id of [taId, otroId]) {
      await setAllocation(profe, 'sd-2026-1', 'tp0', 'individual', {
        teachingAssistantId: id,
        targetIds: [a],
        allocate: true,
      })
    }

    const tp0 = await listAllocations(profe, 'sd-2026-1', 'tp0', 'individual')
    const tp3 = await listAllocations(profe, 'sd-2026-1', 'tp3', 'individual')
    expect(tp0?.byTarget.get(a)?.sort()).toEqual([taId, otroId].sort())
    expect(tp3?.byTarget.size).toBe(0)
  })

  it('refuses a padrón of another classroom', async () => {
    const org = await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', profe)
    const taId = await assistant(org, ta, profe)
    await assignment(org, profe, 'tp0')
    await rosterOf(org, ['100000'])
    const [foreign] = await rosterOf(other, ['200000'])

    expect(
      await setAllocation(profe, 'sd-2026-1', 'tp0', 'individual', {
        teachingAssistantId: taId,
        targetIds: [foreign],
        allocate: true,
      }),
    ).toEqual({ success: false, error: 'Algún alumno ya no está en la lista. Recargá la página.' })
    expect(await db.select().from(teachingAssistantAllocations)).toHaveLength(0)
  })

  it('allocates teams of a group assignment, and refuses a team of another grouping', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    const set = await grouping(org, 'equipos')
    const otherSet = await grouping(org, 'otros')
    await groupAssignment(org, set, profe, 'tp1')
    const los = await team(set, org, 'los-raft')
    const ajenos = await team(otherSet, org, 'ajenos')
    const allocate = (targetIds: number[]) =>
      setAllocation(profe, 'sd-2026-1', 'tp1', 'group', {
        teachingAssistantId: taId,
        targetIds,
        allocate: true,
      })

    expect(await allocate([los])).toEqual({ success: true })
    expect(await allocate([ajenos])).toEqual({
      success: false,
      error: 'Algún equipo ya no existe. Recargá la página.',
    })

    const listed = await listAllocations(profe, 'sd-2026-1', 'tp1', 'group')
    expect(Object.fromEntries(listed!.byTarget)).toEqual({ [los]: [taId] })
  })

  it('refuses a TA of another classroom, an archived classroom, and anybody but a teacher', async () => {
    const org = await classroom('sd-2026-1', profe)
    const other = await classroom('sd-2025-2', profe)
    const taId = await assistant(org, ta, profe)
    const foreignTa = await assistant(other, await user('ajeno'), profe)
    await assignment(org, profe, 'tp0')
    const [a] = await rosterOf(org, ['100000'])
    const input = (teachingAssistantId: number) => ({
      teachingAssistantId,
      targetIds: [a],
      allocate: true,
    })

    expect(await setAllocation(profe, 'sd-2026-1', 'tp0', 'individual', input(foreignTa))).toEqual({
      success: false,
      error: 'Ese ayudante ya no está en el classroom.',
    })
    // The TA cannot hand themselves rows
    expect(await setAllocation(ta, 'sd-2026-1', 'tp0', 'individual', input(taId))).toMatchObject({
      success: false,
    })
    expect(await listAllocations(ta, 'sd-2026-1', 'tp0', 'individual')).toBeNull()

    await db.update(organizations).set({ archivedAt: new Date() }).where(eq(organizations.id, org))
    expect(await setAllocation(profe, 'sd-2026-1', 'tp0', 'individual', input(taId))).toMatchObject({
      success: false,
    })
    expect(await db.select().from(teachingAssistantAllocations)).toHaveLength(0)
  })
})

describe('the fixes of the review of the allocation', () => {
  it('reads no allocations on a classroom with no TAs', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assignment(org, profe, 'tp0')

    expect(await listAllocations(profe, 'sd-2026-1', 'tp0', 'individual')).toEqual({
      assistants: [],
      byTarget: new Map(),
    })
  })

  it('answers a team that no longer exists with a message to reload', async () => {
    const org = await classroom('sd-2026-1', profe)
    const taId = await assistant(org, ta, profe)
    const set = await grouping(org, 'equipos')
    await groupAssignment(org, set, profe, 'tp1')
    const los = await team(set, org, 'los-raft')
    await db.delete(groups).where(eq(groups.id, los))

    expect(
      await setAllocation(profe, 'sd-2026-1', 'tp1', 'group', {
        teachingAssistantId: taId,
        targetIds: [los],
        allocate: true,
      }),
    ).toEqual({ success: false, error: 'Algún equipo ya no existe. Recargá la página.' })
  })
})
