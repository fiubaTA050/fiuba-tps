import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assignmentInvitations, assignments, organizations, organizationsUsers, users } from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of spec/models/assignment_spec.rb and of the AssignmentsController#create
 * cases in spec/controllers/assignments_controller_spec.rb.
 *
 * The original's specs around starter code (`#starter_code_repository_not_empty`,
 * `#starter_code_repository_is_template`) and deadlines are absent because
 * neither is ported; see db/schema.ts.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const { createAssignment, findAssignment, listAssignments } = await import(
  '@/lib/data/assignments'
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

let nextGithubId = 1000

/** The classroom_org of the original's factories, with its teacher linked */
async function classroomOrg(
  session: Session,
  options: { slug?: string; archivedAt?: Date } = {},
) {
  const githubId = nextGithubId++
  const slug = options.slug ?? `${githubId}-classroom`

  const [row] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: slug,
      slug,
      archivedAt: options.archivedAt ?? null,
    })
    .returning({ id: organizations.id, slug: organizations.slug })

  await db
    .insert(organizationsUsers)
    .values({ organizationId: row.id, userId: Number(session.user.id) })

  return row
}

const VALID = {
  title: 'Trabajo Practico 1',
  slug: 'tp1',
  publicRepo: false,
  invitationsEnabled: true,
  studentsAreRepoAdmins: false,
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('createAssignment — successful creation', () => {
  it('creates the assignment with its creator and classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createAssignment(session, classroom.slug, VALID)

    expect(result).toEqual({ success: true, slug: 'tp1' })

    const [row] = await db.select().from(assignments)
    expect(row.title).toBe('Trabajo Practico 1')
    expect(row.slug).toBe('tp1')
    expect(row.organizationId).toBe(classroom.id)
    expect(row.creatorId).toBe(Number(session.user.id))
  })

  // "is invalid without an invitation" — inverted: the invitation is built for you
  it('builds the assignment invitation with a key', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, VALID)

    const [assignment] = await db.select().from(assignments)
    const invitations = await db
      .select()
      .from(assignmentInvitations)
      .where(eq(assignmentInvitations.assignmentId, assignment.id))

    expect(invitations).toHaveLength(1)
    // SecureRandom.hex(16)
    expect(invitations[0].key).toMatch(/^[0-9a-f]{32}$/)
  })

  it('gives every assignment a different invitation key', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, VALID)
    await createAssignment(session, classroom.slug, { ...VALID, title: 'TP 2', slug: 'tp2' })

    const rows = await db.select().from(assignmentInvitations)
    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })

  // "sets invitations_enabled to true by default"
  it('honours the invitation and admin flags', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, {
      ...VALID,
      invitationsEnabled: false,
      studentsAreRepoAdmins: true,
    })

    const [row] = await db.select().from(assignments)
    expect(row.invitationsEnabled).toBe(false)
    expect(row.studentsAreRepoAdmins).toBe(true)
  })

  // "#public?" / "#private?" — `visibility=` writes public_repo
  it('stores the visibility on public_repo', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, { ...VALID, publicRepo: true })

    const [row] = await db.select().from(assignments)
    expect(row.publicRepo).toBe(true)
  })
})

describe('createAssignment — validations', () => {
  it('rejects a blank title', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createAssignment(session, classroom.slug, { ...VALID, title: '   ' })

    expect(result).toMatchObject({ success: false, field: 'title' })
  })

  // validates :title, length: { maximum: 60 }
  it('rejects a title longer than 60 characters', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createAssignment(session, classroom.slug, {
      ...VALID,
      title: 'a'.repeat(61),
    })

    expect(result).toMatchObject({ success: false, field: 'title' })
  })

  // "title blacklist" — GitHubClassroom::Blacklist::NAMES
  it('disallows blacklisted titles', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    for (const reserved of ['new', 'edit', 'New', 'EDIT']) {
      const result = await createAssignment(session, classroom.slug, {
        ...VALID,
        title: reserved,
        slug: 'ok',
      })
      expect(result).toMatchObject({ success: false, field: 'title' })
    }
  })

  // Divergence from the original, which only blacklisted the title: the slug
  // is what lands in the URL, and "new" there shadows the new-assignment route
  it('disallows a blacklisted slug even when the title is fine', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createAssignment(session, classroom.slug, {
      ...VALID,
      title: 'Trabajo Practico',
      slug: 'new',
    })

    expect(result).toMatchObject({ success: false, field: 'slug' })
  })

  it('rejects a blank slug', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createAssignment(session, classroom.slug, { ...VALID, slug: '  ' })

    expect(result).toMatchObject({ success: false, field: 'slug' })
  })

  // validates :slug, format: { with: /\A[-a-zA-Z0-9_]*\z/ }
  it('rejects a slug with characters outside the format', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    for (const slug of ['tp 1', 'tp/1', 'tp.1', 'trabajo-práctico']) {
      const result = await createAssignment(session, classroom.slug, { ...VALID, slug })
      expect(result).toMatchObject({ success: false, field: 'slug' })
    }
  })

  it('accepts dashes and underscores in the slug', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createAssignment(session, classroom.slug, {
      ...VALID,
      slug: 'tp_1-parte_2',
    })

    expect(result).toEqual({ success: true, slug: 'tp_1-parte_2' })
  })

  // "uniqueness of title across organization"
  it('rejects a title already used in the same classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, VALID)
    const result = await createAssignment(session, classroom.slug, { ...VALID, slug: 'otro' })

    expect(result).toMatchObject({ success: false, field: 'title' })
  })

  // "slug uniqueness — verifies that the slug is unique even if the titles are unique"
  it('rejects a slug already used in the same classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, { ...VALID, title: 'foo' })
    const result = await createAssignment(session, classroom.slug, { ...VALID, title: 'bar' })

    expect(result).toMatchObject({ success: false, field: 'slug' })
  })

  // "uniqueness of title across application — allows two organizations to have
  // the same Assignment title and slug"
  it('allows two classrooms to have the same title and slug', async () => {
    const session = await classroomTeacher()
    const first = await classroomOrg(session)
    const second = await classroomOrg(session)

    expect(await createAssignment(session, first.slug, VALID)).toEqual({
      success: true,
      slug: 'tp1',
    })
    expect(await createAssignment(session, second.slug, VALID)).toEqual({
      success: true,
      slug: 'tp1',
    })
  })

  // "is invalid if the organization has been archived"
  it('refuses to create in an archived classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session, { archivedAt: new Date() })

    const result = await createAssignment(session, classroom.slug, VALID)

    expect(result).toMatchObject({ success: false, field: 'base' })
    expect(await db.select().from(assignments)).toHaveLength(0)
  })

  it('leaves no orphan invitation behind when the second submission is refused', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, VALID)
    const result = await createAssignment(session, classroom.slug, VALID)

    expect(result).toMatchObject({ success: false })
    expect(await db.select().from(assignments)).toHaveLength(1)
    expect(await db.select().from(assignmentInvitations)).toHaveLength(1)
  })

  /**
   * The findClash pre-check above is what makes the message specific, but it
   * races: two teachers can submit the same name at once. These two go
   * straight at the indexes, which are the only thing standing between that
   * race and a duplicate, and which the pre-check cannot exercise.
   */
  it('has a unique index on (organization_id, title) as a backstop', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    await expect(
      db.insert(assignments).values({
        organizationId: classroom.id,
        creatorId: Number(session.user.id),
        title: VALID.title,
        slug: 'un-slug-distinto',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'index_assignments_on_organization_id_and_title' },
    })
  })

  it('has a unique index on (organization_id, slug) as a backstop', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    await expect(
      db.insert(assignments).values({
        organizationId: classroom.id,
        creatorId: Number(session.user.id),
        title: 'Un titulo distinto',
        slug: VALID.slug,
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'index_assignments_on_organization_id_and_slug' },
    })
  })

  // Both indexes are partial on `deleted_at IS NULL`, so deleting an
  // assignment gives its title and its prefix back instead of reserving them
  // forever. Same reasoning as the classroom indexes in db/schema.ts.
  it('frees the title and the slug once the assignment is soft-deleted', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    await db.update(assignments).set({ deletedAt: new Date() })

    expect(await createAssignment(session, classroom.slug, VALID)).toEqual({
      success: true,
      slug: 'tp1',
    })
  })
})

describe('createAssignment — authorization', () => {
  // OrganizationAuthorization: the teacher must belong to the classroom
  it('refuses a classroom the teacher is not a member of', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomOrg(owner)

    const result = await createAssignment(stranger, classroom.slug, VALID)

    expect(result).toMatchObject({ success: false, field: 'base' })
    expect(await db.select().from(assignments)).toHaveLength(0)
  })

  it('refuses a soft-deleted classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await db
      .update(organizations)
      .set({ deletedAt: new Date() })
      .where(eq(organizations.id, classroom.id))

    const result = await createAssignment(session, classroom.slug, VALID)

    expect(result).toMatchObject({ success: false, field: 'base' })
  })
})

describe('listAssignments', () => {
  it('lists the assignments of the classroom with their invitation key', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, VALID)
    await createAssignment(session, classroom.slug, { ...VALID, title: 'TP 2', slug: 'tp2' })

    const list = await listAssignments(session, classroom.slug)

    expect(list.map((assignment) => assignment.slug)).toEqual(['tp1', 'tp2'])
    expect(list[0].invitationKey).toMatch(/^[0-9a-f]{32}$/)
  })

  it('does not leak assignments of another classroom', async () => {
    const session = await classroomTeacher()
    const first = await classroomOrg(session)
    const second = await classroomOrg(session)

    await createAssignment(session, first.slug, VALID)

    expect(await listAssignments(session, second.slug)).toEqual([])
  })

  it('returns nothing for a teacher who is not a member', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomOrg(owner)
    await createAssignment(owner, classroom.slug, VALID)

    expect(await listAssignments(stranger, classroom.slug)).toEqual([])
  })

  // "a default scope where deleted_at is not present"
  it('hides soft-deleted assignments', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    await db.update(assignments).set({ deletedAt: new Date() })

    expect(await listAssignments(session, classroom.slug)).toEqual([])
  })
})

describe('findAssignment', () => {
  it('finds it by slug within the classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    const assignment = await findAssignment(session, classroom.slug, 'tp1')

    expect(assignment).toMatchObject({ title: 'Trabajo Practico 1', slug: 'tp1' })
  })

  it('returns null for an unknown slug', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    expect(await findAssignment(session, classroom.slug, 'tp1')).toBeNull()
  })

  // Returns null rather than raising, so the page 404s without leaking that it exists
  it('returns null for a teacher who is not a member', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomOrg(owner)
    await createAssignment(owner, classroom.slug, VALID)

    expect(await findAssignment(stranger, classroom.slug, 'tp1')).toBeNull()
  })

  it('does not find an assignment of another classroom', async () => {
    const session = await classroomTeacher()
    const first = await classroomOrg(session)
    const second = await classroomOrg(session)
    await createAssignment(session, first.slug, VALID)

    expect(await findAssignment(session, second.slug, 'tp1')).toBeNull()
  })

  it('hides a soft-deleted assignment', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    await db.update(assignments).set({ deletedAt: new Date() })

    expect(await findAssignment(session, classroom.slug, 'tp1')).toBeNull()
  })
})
