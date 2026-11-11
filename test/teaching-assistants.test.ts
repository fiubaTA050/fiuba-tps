import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentRepos,
  assignments,
  groupAssignments,
  groupings,
  groups,
  groupsUsers,
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

const { findClassroomRole, findTeachingClassroom } = await import('@/lib/data/organizations')
const {
  addTeachingAssistant,
  countClassroomStaff,
  listClassroomStaff,
  removeTeachingAssistant,
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

    for (const login of ['', 'con espacio', '-guion', 'doble--guion', 'a'.repeat(40)]) {
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

    for (const student of [porPadron, porRepo, porEquipo]) {
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

    expect(await removeTeachingAssistant(profe, 'sd-2026-1', taId)).toEqual({
      success: true,
      login: 'ayudante',
    })
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
    expect(await countClassroomStaff(profe, 'sd-2026-1')).toBe(3)
  })

  it('is null for a TA, who gets no tab', async () => {
    const org = await classroom('sd-2026-1', profe)
    await assistant(org, ta, profe)

    expect(await listClassroomStaff(ta, 'sd-2026-1')).toBeNull()
    expect(await countClassroomStaff(ta, 'sd-2026-1')).toBeNull()
  })
})
