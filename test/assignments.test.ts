import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  groupAssignments,
  groupings,
  organizations,
  organizationsUsers,
  users,
} from '@/db/schema'

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

const findRepositoryByFullName = vi.fn()
const isRepositoryEmpty = vi.fn()

vi.mock('@/lib/github/repositories', async (importOriginal) => ({
  // REPOSITORY_FULL_NAME is a plain regex; stubbing it would test the stub
  ...(await importOriginal<typeof import('@/lib/github/repositories')>()),
  findRepositoryByFullName: (...args: unknown[]) => findRepositoryByFullName(...args),
  isRepositoryEmpty: (...args: unknown[]) => isRepositoryEmpty(...args),
}))

/** A template repository as `findRepositoryByFullName` returns it */
const TEMPLATE = {
  id: 987654,
  fullName: 'fiubaTA050-labs/raft-starter',
  htmlUrl: 'https://github.com/fiubaTA050-labs/raft-starter',
  private: true,
  isTemplate: true,
}

const {
  createAssignment,
  deleteAssignment,
  findAssignment,
  listAssignments,
  updateAssignment,
} = await import('@/lib/data/assignments')

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
let nextSlug = 1

/** The classroom_org of the original's factories, with its teacher linked */
async function classroomOrg(
  session: Session,
  options: { slug?: string; archivedAt?: Date; githubId?: number } = {},
) {
  const githubId = options.githubId ?? nextGithubId++
  const slug = options.slug ?? `${githubId}-${nextSlug++}-classroom`

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

const VALID = {
  title: 'Trabajo Practico 1',
  slug: 'tp1',
  publicRepo: false,
  invitationsEnabled: true,
  studentsAreRepoAdmins: false,
  starterCodeRepo: '',
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
  nextSlug = 1
  // clearAllMocks only clears calls, not implementations, so the defaults have
  // to be restored here or one test's stub leaks into the next
  findRepositoryByFullName.mockResolvedValue(TEMPLATE)
  isRepositoryEmpty.mockResolvedValue(false)
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

  // Divergence, widening `uniqueness_of_slug_across_organization`: the slug is
  // a repository prefix, and repository names belong to the GitHub org. The
  // cátedra runs one classroom per term on a single org, so `tp1` in 2026a and
  // `tp1` in 2026b would fight over the same repositories.
  it('rejects a slug already used by another classroom of the same GitHub org', async () => {
    const session = await classroomTeacher()
    const first = await classroomOrg(session, { githubId: 7777 })
    const second = await classroomOrg(session, { githubId: 7777 })

    await createAssignment(session, first.slug, VALID)
    const result = await createAssignment(session, second.slug, { ...VALID, title: 'otro' })

    expect(result).toMatchObject({ success: false, field: 'slug' })
    // The message names the classroom holding it, or the teacher cannot act on it
    expect((result as { error: string }).error).toContain(first.title)
  })

  it('lets the two kinds of assignment share a title, but not a prefix', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session, { githubId: 8888 })

    await db.insert(groupAssignments).values({
      organizationId: classroom.id,
      groupingId: (
        await db
          .insert(groupings)
          .values({ organizationId: classroom.id, title: 'Equipos', slug: 'equipos' })
          .returning({ id: groupings.id })
      )[0].id,
      creatorId: Number(session.user.id),
      title: VALID.title,
      slug: VALID.slug,
    })

    // `Assignment.where(slug:, organization:)` in the original's
    // uniqueness_of_slug_across_organization, in the other direction
    expect(await createAssignment(session, classroom.slug, VALID)).toMatchObject({
      success: false,
      field: 'slug',
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

/**
 * Port of the `#starter_code_repository_not_empty` and
 * `#starter_code_repository_is_template` describes of assignment_spec.rb, plus
 * the StarterCode concern's format and resolution cases.
 */
describe('createAssignment — starter code', () => {
  const withStarterCode = { ...VALID, starterCodeRepo: TEMPLATE.fullName }

  it('stores only the repo id, never the name', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createAssignment(session, classroom.slug, withStarterCode)
    expect(result).toMatchObject({ success: true })

    const [row] = await db.select().from(assignments)
    expect(row.starterCodeRepoId).toBe(TEMPLATE.id)
    // DA-2: the full name is resolved from GitHub at render time
    expect(JSON.stringify(row)).not.toContain('raft-starter')
  })

  // Starter code is optional in the original too
  it('leaves it null when the field is blank', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, { ...VALID, starterCodeRepo: '   ' })

    const [row] = await db.select().from(assignments)
    expect(row.starterCodeRepoId).toBeNull()
    expect(findRepositoryByFullName).not.toHaveBeenCalled()
  })

  it('resolves the name against the classroom installation', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createAssignment(session, classroom.slug, withStarterCode)

    const [installationId, fullName] = findRepositoryByFullName.mock.calls[0]
    expect(fullName).toBe(TEMPLATE.fullName)
    expect(typeof installationId).toBe('number')
  })

  // StarterCode::WRONG_FORMAT
  it('rejects a name that is not owner/nombre', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    for (const name of ['raft-starter', 'a/b/c', 'https://github.com/org/repo', 'org/']) {
      const result = await createAssignment(session, classroom.slug, {
        ...VALID,
        starterCodeRepo: name,
      })
      expect(result).toMatchObject({ success: false, field: 'starterCode' })
    }

    // The format check is local: it must not cost an API call
    expect(findRepositoryByFullName).not.toHaveBeenCalled()
  })

  // StarterCode::INVALID_SELECTION. A 404 covers both "does not exist" and
  // "exists but the App cannot see it", so the message has to offer both.
  it('rejects a repo the App cannot reach, naming both readings', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    findRepositoryByFullName.mockResolvedValue(null)

    const result = await createAssignment(session, classroom.slug, withStarterCode)

    expect(result).toMatchObject({ success: false, field: 'starterCode' })
    expect(result).toHaveProperty('error', expect.stringContaining('instalá'))
    expect(await db.select().from(assignments)).toHaveLength(0)
  })

  // "#starter_code_repository_is_template"
  it('rejects a repo that is not a template', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    findRepositoryByFullName.mockResolvedValue({ ...TEMPLATE, isTemplate: false })

    const result = await createAssignment(session, classroom.slug, withStarterCode)

    expect(result).toMatchObject({ success: false, field: 'starterCode' })
    expect(result).toHaveProperty('error', expect.stringContaining('template repository'))
  })

  // "#starter_code_repository_not_empty"
  it('rejects an empty repo', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    isRepositoryEmpty.mockResolvedValue(true)

    const result = await createAssignment(session, classroom.slug, withStarterCode)

    expect(result).toMatchObject({ success: false, field: 'starterCode' })
    expect(result).toHaveProperty('error', expect.stringContaining('vacío'))
  })

  // The GitHub calls are the expensive part, so they come last
  it('does not touch GitHub when the title already exists', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, withStarterCode)
    findRepositoryByFullName.mockClear()

    const result = await createAssignment(session, classroom.slug, withStarterCode)

    expect(result).toMatchObject({ success: false, field: 'title' })
    expect(findRepositoryByFullName).not.toHaveBeenCalled()
  })

  it('exposes the id through findAssignment and listAssignments', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, withStarterCode)

    expect(await findAssignment(session, classroom.slug, VALID.slug)).toMatchObject({
      starterCodeRepoId: TEMPLATE.id,
    })
    expect(await listAssignments(session, classroom.slug)).toMatchObject([
      { starterCodeRepoId: TEMPLATE.id },
    ])
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

/**
 * Port of spec/models/assignment/editor_spec.rb and of the
 * AssignmentsController#update cases of the controller spec. The deadline half
 * of the editor spec is absent because deadlines are not ported.
 */
describe('updateAssignment', () => {
  /** A classroom with `VALID` already created in it */
  async function withAssignment(session: Session) {
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)
    return classroom
  }

  // "can update attributes"
  it('updates the attributes', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)

    const result = await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      title: 'New Title',
    })

    expect(result).toEqual({ success: true, slug: 'tp1' })

    const [row] = await db.select().from(assignments)
    expect(row.title).toBe('New Title')
  })

  it('renames the repository prefix', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)

    const result = await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      slug: 'tp1-2026a',
    })

    expect(result).toEqual({ success: true, slug: 'tp1-2026a' })
    expect((await db.select().from(assignments))[0].slug).toBe('tp1-2026a')
  })

  /**
   * `context "public_repo is changed"`, inverted. The original enqueued
   * AssignmentRepositoryVisibilityJob from
   * Editor#update_attribute_for_all_assignment_repos; here nothing propagates,
   * so the repositories already created keep the visibility they were made
   * with. See docs/edicion-y-borrado-de-assignments.md.
   */
  it('changes public_repo without touching the repositories already created', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)

    const [assignment] = await db.select().from(assignments)
    const [user] = await db
      .insert(users)
      .values({ uid: 9001, githubLogin: 'alumna' })
      .returning({ id: users.id })

    await db.insert(assignmentRepos).values({
      assignmentId: assignment.id,
      userId: user.id,
      githubRepoId: 424242,
    })

    await updateAssignment(session, classroom.slug, 'tp1', { ...VALID, publicRepo: true })

    expect((await db.select().from(assignments))[0].publicRepo).toBe(true)
    // The repository still points at the same GitHub repo, still owned by the
    // same student: no job was enqueued and no call was made. DA-2 means the
    // name is not stored, so the repo on GitHub keeps whatever it was made with.
    const repos = await db.select().from(assignmentRepos)
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({ githubRepoId: 424242, userId: user.id })
  })

  // The live site's "Assignment status" dropdown, which is where the archived
  // `toggle_invitations` went
  it('closes submissions by setting the assignment inactive', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)

    await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      invitationsEnabled: false,
    })

    expect((await db.select().from(assignments))[0].invitationsEnabled).toBe(false)
  })

  /**
   * Not in the original: `validates :slug, uniqueness:` excluded the record
   * being saved for free, and the hand-written query here has to be told to.
   */
  it('does not clash with itself when the prefix is left alone', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)

    const result = await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      title: 'Otro título',
    })

    expect(result).toEqual({ success: true, slug: 'tp1' })
  })

  it('does not clash with itself when the title is left alone', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)

    const result = await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      slug: 'tp1-bis',
    })

    expect(result).toEqual({ success: true, slug: 'tp1-bis' })
  })

  it('rejects a prefix that another assignment of the classroom already uses', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)
    await createAssignment(session, classroom.slug, { ...VALID, title: 'TP 2', slug: 'tp2' })

    const result = await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      slug: 'tp2',
    })

    expect(result).toEqual({
      success: false,
      error: 'Ya existe un assignment con el prefijo "tp2" en este classroom.',
      field: 'slug',
    })
  })

  /**
   * Not in the original either: its uniqueness check was scoped to one
   * classroom, and the prefix is a repository name, which belongs to the whole
   * GitHub organization. The message has to name the other classroom, because
   * the teacher cannot see it from here.
   */
  it('rejects a prefix used by another classroom of the same GitHub organization', async () => {
    const session = await classroomTeacher()
    const first = await classroomOrg(session, { githubId: 5000 })
    const second = await classroomOrg(session, { githubId: 5000 })

    await createAssignment(session, first.slug, VALID)
    await createAssignment(session, second.slug, { ...VALID, title: 'TP 1 bis', slug: 'tp1-bis' })

    const result = await updateAssignment(session, second.slug, 'tp1-bis', {
      ...VALID,
      title: 'TP 1 bis',
      slug: 'tp1',
    })

    expect(result.success).toBe(false)
    expect(result.success === false && result.field).toBe('slug')
    expect(result.success === false && result.error).toContain(first.title)
  })

  it('rejects a title that another assignment of the classroom already uses', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)
    await createAssignment(session, classroom.slug, { ...VALID, title: 'TP 2', slug: 'tp2' })

    const result = await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      title: 'TP 2',
    })

    expect(result).toEqual({
      success: false,
      error: 'Ya existe un assignment llamado "TP 2" en este classroom.',
      field: 'title',
    })
  })

  /**
   * `context "slug is empty"`. The original reloaded the record so the form
   * would not render with a blank prefix; here nothing was written in the first
   * place, which is the same guarantee stated on the database.
   */
  it('leaves the assignment intact when the prefix is empty', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)

    const result = await updateAssignment(session, classroom.slug, 'tp1', { ...VALID, slug: '' })

    expect(result).toEqual({
      success: false,
      error: 'El prefijo no puede estar vacío.',
      field: 'slug',
    })
    expect((await db.select().from(assignments))[0].slug).toBe('tp1')
  })

  // validate :organization_is_not_archived — "create or modify"
  it('refuses to modify an assignment of an archived classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await withAssignment(session)
    await db.update(organizations).set({ archivedAt: new Date() })

    const result = await updateAssignment(session, classroom.slug, 'tp1', {
      ...VALID,
      title: 'New Title',
    })

    expect(result).toEqual({
      success: false,
      error: 'No se pueden modificar assignments en un classroom archivado.',
      field: 'base',
    })
  })

  // DA-4: the boundary is findTeachingClassroom, not the caller
  it('refuses a teacher who is not a member of the classroom', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await withAssignment(owner)

    const result = await updateAssignment(stranger, classroom.slug, 'tp1', {
      ...VALID,
      title: 'New Title',
    })

    expect(result).toEqual({
      success: false,
      error: 'No encontramos ese classroom.',
      field: 'base',
    })
    expect((await db.select().from(assignments))[0].title).toBe('Trabajo Practico 1')
  })

  it('returns not found for an unknown assignment', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await updateAssignment(session, classroom.slug, 'tp1', VALID)

    expect(result).toEqual({
      success: false,
      error: 'No encontramos ese assignment.',
      field: 'base',
    })
  })
})

/**
 * Port of `describe "DELETE #destroy"`. Its second and third cases —
 * DestroyResourceJob and the statsd event — have no equivalent: the job is
 * exactly what this port does not do, see `deleteAssignment`.
 */
describe('deleteAssignment', () => {
  // "sets the `deleted_at` column for the assignment"
  it('sets deleted_at and hides the assignment', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    expect(await deleteAssignment(session, classroom.slug, 'tp1')).toEqual({ success: true })

    const [row] = await db.select().from(assignments)
    expect(row.deletedAt).not.toBeNull()
    expect(await listAssignments(session, classroom.slug)).toEqual([])
    expect(await findAssignment(session, classroom.slug, 'tp1')).toBeNull()
  })

  it('soft-deletes the invitation along with it', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    await deleteAssignment(session, classroom.slug, 'tp1')

    expect((await db.select().from(assignmentInvitations))[0].deletedAt).not.toBeNull()
  })

  /**
   * The partial unique indexes are `where deleted_at is null`, so this works
   * without any extra bookkeeping — and it is the reason a soft delete is
   * enough to call the assignment gone.
   */
  it('frees the title and the prefix for a new assignment', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    await deleteAssignment(session, classroom.slug, 'tp1')

    expect(await createAssignment(session, classroom.slug, VALID)).toEqual({
      success: true,
      slug: 'tp1',
    })
  })

  /**
   * The divergence, asserted. The original's `dependent: :destroy` plus
   * `AssignmentRepoable#silently_destroy_github_repository` deleted every
   * student repository from GitHub; here the rows — and the repositories they
   * name — are left alone.
   */
  it('leaves the students´ repositories alone', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)

    const [assignment] = await db.select().from(assignments)
    const [user] = await db
      .insert(users)
      .values({ uid: 9002, githubLogin: 'alumno' })
      .returning({ id: users.id })

    await db.insert(assignmentRepos).values({
      assignmentId: assignment.id,
      userId: user.id,
      githubRepoId: 515151,
    })

    await deleteAssignment(session, classroom.slug, 'tp1')

    const repos = await db.select().from(assignmentRepos)
    expect(repos).toHaveLength(1)
    expect(repos[0].githubRepoId).toBe(515151)
  })

  it('refuses a teacher who is not a member of the classroom', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomOrg(owner)
    await createAssignment(owner, classroom.slug, VALID)

    expect(await deleteAssignment(stranger, classroom.slug, 'tp1')).toEqual({
      success: false,
      error: 'No encontramos ese classroom.',
    })
    expect((await db.select().from(assignments))[0].deletedAt).toBeNull()
  })

  it('returns not found for an assignment already deleted', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)
    await createAssignment(session, classroom.slug, VALID)
    await deleteAssignment(session, classroom.slug, 'tp1')

    expect(await deleteAssignment(session, classroom.slug, 'tp1')).toEqual({
      success: false,
      error: 'No encontramos ese assignment.',
    })
  })
})
