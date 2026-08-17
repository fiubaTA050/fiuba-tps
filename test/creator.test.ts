import { eq, sql } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignments,
  groupAssignments,
  groupings,
  organizations,
  organizationsUsers,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of spec/models/organization/creator_spec.rb.
 *
 * The original's cases around `ensure_organization_webhook_exists!` are gone:
 * the GitHub App installation replaced the org webhook, and it already exists
 * by the time we get here. Everything else carries over.
 */

const ORG = {
  githubId: 4321,
  login: 'fiubaTA050-labs',
  name: 'TA050',
  avatarUrl: 'https://avatars.githubusercontent.com/u/4321',
  installationId: 99,
  admin: true,
}

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

const listUserOrganizations = vi.fn()
const setDefaultRepositoryPermissionToNone = vi.fn()
const findOrganizationByInstallation = vi.fn()

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

vi.mock('@/lib/github/organizations', () => ({
  listUserOrganizations: (...args: unknown[]) => listUserOrganizations(...args),
  setDefaultRepositoryPermissionToNone: (...args: unknown[]) =>
    setDefaultRepositoryPermissionToNone(...args),
  findOrganizationByInstallation: (...args: unknown[]) => findOrganizationByInstallation(...args),
}))

const { createClassroom, findClassroom, listClassrooms, setClassroomArchived } = await import(
  '@/lib/data/organizations',
)

let nextUid = 1

/** The classroom_teacher of the original's factories */
async function classroomTeacher(login = 'eespina-fiuba'): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: login })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: login },
  } as Session
}

async function organizationCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(organizations)
  return row.count
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  listUserOrganizations.mockResolvedValue([ORG])
  setDefaultRepositoryPermissionToNone.mockResolvedValue(undefined)
  // clearAllMocks only clears calls, not implementations, so every mock needs
  // its default restored here or one test's stub leaks into the next
  findOrganizationByInstallation.mockResolvedValue(ORG)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('createClassroom — successful creation', () => {
  it('creates the classroom and links the teacher', async () => {
    const session = await classroomTeacher()
    const result = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos 2026 2C',
    })

    expect(result).toEqual({ success: true, slug: '4321-algoritmos-2026-2c' })

    const [row] = await db.select().from(organizations)
    expect(row.title).toBe('Algoritmos 2026 2C')
    expect(row.githubId).toBe(ORG.githubId)
    expect(row.installationId).toBe(ORG.installationId)

    const links = await db
      .select()
      .from(organizationsUsers)
      .where(eq(organizationsUsers.organizationId, row.id))
    expect(links).toHaveLength(1)
  })

  it('sets the org default repository permission to none', async () => {
    const session = await classroomTeacher()
    await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })

    expect(setDefaultRepositoryPermissionToNone).toHaveBeenCalledWith(
      ORG.installationId,
      ORG.login,
    )
  })

  // "multiple classrooms on same organization"
  it('allows several classrooms on the same organization', async () => {
    const session = await classroomTeacher()
    const first = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos 2026 1C',
    })
    const second = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos 2026 2C',
    })

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(await organizationCount()).toBe(2)
  })
})

describe('createClassroom — unsuccessful creation', () => {
  // "does not allow non admins to be added"
  it('fails when the user is not an admin of the organization', async () => {
    listUserOrganizations.mockResolvedValue([{ ...ORG, admin: false }])
    const session = await classroomTeacher()

    const result = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })

    expect(result.success).toBe(false)
    expect(await organizationCount()).toBe(0)
  })

  it('fails when the organization is not one the user can see', async () => {
    listUserOrganizations.mockResolvedValue([])
    const session = await classroomTeacher()

    const result = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })

    expect(result.success).toBe(false)
    expect(await organizationCount()).toBe(0)
  })

  // "deletes the organization if the repository permissions cannot be set to none"
  it('deletes the classroom if the repository permissions cannot be set to none', async () => {
    setDefaultRepositoryPermissionToNone.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )
    const session = await classroomTeacher()

    const result = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })

    expect(result.success).toBe(false)
    expect(await organizationCount()).toBe(0)
  })

  // validates :title, presence: true, length: { maximum: 255 }
  it('rejects a blank title', async () => {
    const session = await classroomTeacher()
    const result = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: '   ',
    })

    expect(result.success).toBe(false)
    expect(await organizationCount()).toBe(0)
  })

  it('rejects a title over 255 characters', async () => {
    const session = await classroomTeacher()
    const result = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'a'.repeat(256),
    })

    expect(result.success).toBe(false)
    expect(await organizationCount()).toBe(0)
  })

  // validates :title, uniqueness: { scope: :github_id }
  it('rejects a duplicate title in the same organization', async () => {
    const session = await classroomTeacher()
    const input = {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    }

    await createClassroom(session, input)
    const result = await createClassroom(session, input)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Ya existe un classroom')
    expect(await organizationCount()).toBe(1)
  })

  it('allows the same title in a different organization', async () => {
    const other = { ...ORG, githubId: 8765, login: 'otra-catedra', installationId: 100 }
    listUserOrganizations.mockResolvedValue([ORG, other])
    const session = await classroomTeacher()

    await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })
    const result = await createClassroom(session, {
      githubId: other.githubId,
      installationId: other.installationId,
      title: 'Algoritmos',
    })

    expect(result.success).toBe(true)
  })

  // validates :slug, uniqueness: true — two distinct titles, one slug
  it('reports a slug clash as a slug clash, not as a duplicate title', async () => {
    const session = await classroomTeacher()

    await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algo 2026',
    })
    const result = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algo/2026',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('misma URL')
      expect(result.error).not.toContain('Ya existe un classroom')
    }
  })
})

describe('soft delete', () => {
  it('frees the title and the slug, thanks to the partial unique indexes', async () => {
    const session = await classroomTeacher()
    const input = {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    }

    await createClassroom(session, input)
    await db.update(organizations).set({ deletedAt: new Date() })

    const result = await createClassroom(session, input)
    expect(result.success).toBe(true)
  })
})

describe('listClassrooms', () => {
  it('returns only the classrooms the session user teaches', async () => {
    const session = await classroomTeacher()
    await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })

    const other = await classroomTeacher()
    listUserOrganizations.mockResolvedValue([{ ...ORG, admin: false }])

    expect(await listClassrooms(session)).toHaveLength(1)
    expect(await listClassrooms(other)).toHaveLength(0)
  })

  // add_current_user_to_organizations
  it('links an admin to classrooms of that org created by someone else', async () => {
    const owner = await classroomTeacher()
    await createClassroom(owner, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })

    const newAdmin = await classroomTeacher()
    const classrooms = await listClassrooms(newAdmin)

    expect(classrooms).toHaveLength(1)
    expect(classrooms[0].title).toBe('Algoritmos')
  })

  it('excludes soft-deleted classrooms', async () => {
    const session = await classroomTeacher()
    await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })
    await db.update(organizations).set({ deletedAt: new Date() })

    expect(await listClassrooms(session)).toHaveLength(0)
  })
})

/**
 * `organization.all_assignments.sort_by(&:created_at).reverse.take(5)` of
 * _organization_card_layout.html.erb, which is what a card lists.
 */
describe('listClassrooms — the assignments on a card', () => {
  /** Both kinds, one per call, `createdAt` explicit so the order is testable */
  async function addAssignment(
    organizationId: number,
    creatorId: number,
    title: string,
    options: { group?: boolean; createdAt?: Date; deleted?: boolean } = {},
  ) {
    const slug = title.toLowerCase().replaceAll(' ', '-')
    const row = {
      organizationId,
      creatorId,
      title,
      slug,
      createdAt: options.createdAt ?? new Date(),
      deletedAt: options.deleted ? new Date() : null,
    }

    if (!options.group) {
      await db.insert(assignments).values(row)
      return
    }

    const [grouping] = await db
      .insert(groupings)
      .values({ organizationId, title: `Equipos de ${title}`, slug: `equipos-${slug}` })
      .returning({ id: groupings.id })

    await db.insert(groupAssignments).values({ ...row, groupingId: grouping.id })
  }

  async function classroomWith(session: Session, title: string) {
    const created = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title,
    })
    if (!created.success) throw new Error(created.error)

    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, created.slug))

    return row.id
  }

  it('lists both kinds, newest first, and marks which is which', async () => {
    const session = await classroomTeacher()
    const id = await classroomWith(session, 'Algoritmos')
    const creatorId = Number(session.user.id)

    await addAssignment(id, creatorId, 'TP1', { createdAt: new Date('2026-03-01') })
    await addAssignment(id, creatorId, 'TP2', { group: true, createdAt: new Date('2026-04-01') })

    const [classroom] = await listClassrooms(session)

    expect(classroom.assignments.map((assignment) => assignment.title)).toEqual(['TP2', 'TP1'])
    expect(classroom.assignments.map((assignment) => assignment.group)).toEqual([true, false])
  })

  it('takes only the five most recent', async () => {
    const session = await classroomTeacher()
    const id = await classroomWith(session, 'Algoritmos')
    const creatorId = Number(session.user.id)

    for (let day = 1; day <= 7; day++) {
      await addAssignment(id, creatorId, `TP${day}`, {
        createdAt: new Date(`2026-03-0${day}`),
      })
    }

    const [classroom] = await listClassrooms(session)

    expect(classroom.assignments.map((assignment) => assignment.title)).toEqual([
      'TP7',
      'TP6',
      'TP5',
      'TP4',
      'TP3',
    ])
  })

  it('excludes soft-deleted assignments and never mixes two classrooms', async () => {
    const session = await classroomTeacher()
    const creatorId = Number(session.user.id)
    const algoritmos = await classroomWith(session, 'Algoritmos')
    const distribuidos = await classroomWith(session, 'Distribuidos')

    await addAssignment(algoritmos, creatorId, 'TP1')
    await addAssignment(algoritmos, creatorId, 'TP borrado', { deleted: true })
    await addAssignment(distribuidos, creatorId, 'TP1 de la otra', { group: true })

    const byTitle = new Map(
      (await listClassrooms(session)).map((classroom) => [classroom.title, classroom.assignments]),
    )

    expect(byTitle.get('Algoritmos')?.map((assignment) => assignment.title)).toEqual(['TP1'])
    expect(byTitle.get('Distribuidos')?.map((assignment) => assignment.title)).toEqual([
      'TP1 de la otra',
    ])
  })
})

/** Port of spec/models/organization/editor_spec.rb, "updating archive setting" */
describe('setClassroomArchived', () => {
  async function classroom(session: Session) {
    const created = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })
    if (!created.success) throw new Error(created.error)
    return created.slug
  }

  async function archivedAt(slug: string) {
    const [row] = await db
      .select({ archivedAt: organizations.archivedAt })
      .from(organizations)
      .where(eq(organizations.slug, slug))

    return row.archivedAt
  }

  it('can archive a classroom', async () => {
    const session = await classroomTeacher()
    const slug = await classroom(session)

    expect(await setClassroomArchived(session, slug, true)).toEqual({ success: true })
    expect(await archivedAt(slug)).toBeInstanceOf(Date)
  })

  it('can unarchive a classroom', async () => {
    const session = await classroomTeacher()
    const slug = await classroom(session)

    await setClassroomArchived(session, slug, true)
    await setClassroomArchived(session, slug, false)

    expect(await archivedAt(slug)).toBeNull()
  })

  // DA-4: the data layer is the authorization boundary, so a teacher of
  // another classroom cannot archive this one
  it('refuses a classroom the session user does not teach', async () => {
    const owner = await classroomTeacher()
    const slug = await classroom(owner)

    const stranger = await classroomTeacher()
    listUserOrganizations.mockResolvedValue([{ ...ORG, admin: false }])

    const result = await setClassroomArchived(stranger, slug, true)

    expect(result.success).toBe(false)
    expect(await archivedAt(slug)).toBeNull()
  })
})

describe('findClassroom — stale installation id', () => {
  // Port of the intent of OrganizationWebhook#retrieve_org_hook_id!: the
  // volatile GitHub-side id is re-derived from the stable one, and saved.
  it('re-resolves and persists the installation id after a reinstall', async () => {
    const session = await classroomTeacher()
    const created = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })
    if (!created.success) throw new Error(created.error)

    // Reinstall: the old installation 404s, GitHub hands out a new id
    const reinstalled = { ...ORG, installationId: 4242 }
    findOrganizationByInstallation.mockResolvedValue(null)
    listUserOrganizations.mockResolvedValue([reinstalled])

    const classroom = await findClassroom(session, created.slug)

    expect(classroom?.organization?.login).toBe(ORG.login)

    const [row] = await db.select().from(organizations)
    expect(row.installationId).toBe(4242)
  })

  it('reports the org as unreachable when it was not reinstalled', async () => {
    const session = await classroomTeacher()
    const created = await createClassroom(session, {
      githubId: ORG.githubId,
      installationId: ORG.installationId,
      title: 'Algoritmos',
    })
    if (!created.success) throw new Error(created.error)

    findOrganizationByInstallation.mockResolvedValue(null)
    listUserOrganizations.mockResolvedValue([])

    const classroom = await findClassroom(session, created.slug)

    // The classroom itself still resolves; only its org is null (DA-2)
    expect(classroom).not.toBeNull()
    expect(classroom?.organization).toBeNull()
  })
})
