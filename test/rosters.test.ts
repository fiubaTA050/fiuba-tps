import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { organizations, organizationsUsers, rosterEntries, rosters, users } from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of spec/models/roster_spec.rb, of the `create_entries` cases of
 * spec/models/roster_entry_spec.rb, and of the RostersController cases of
 * spec/controllers/orgs/rosters_controller_spec.rb (#create, #add_students,
 * #edit_entry, #delete_entry, #remove_organization, the CSV of #show).
 *
 * The original's #link, #unlink and the LMS/Google import cases have no
 * counterpart: none of that is ported, see lib/data/rosters.ts.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const {
  addStudents,
  addSuffixToDuplicates,
  createRoster,
  deleteEntry,
  deleteRoster,
  findRoster,
  parseIdentifiers,
  renameEntry,
  rosterCsv,
  rosterSummary,
} = await import('@/lib/data/rosters')

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
async function classroomOrg(session: Session, options: { slug?: string } = {}) {
  const githubId = nextGithubId++
  const slug = options.slug ?? `${githubId}-classroom`

  const [row] = await db
    .insert(organizations)
    .values({ githubId, installationId: githubId, title: slug, slug })
    .returning({ id: organizations.id, slug: organizations.slug })

  await db
    .insert(organizationsUsers)
    .values({ organizationId: row.id, userId: Number(session.user.id) })

  return row
}

/** A classroom that already has a roster, which most of the cases start from */
async function classroomWithRoster(
  session: Session,
  identifiers = '101\n102\n103',
): Promise<{ id: number; slug: string }> {
  const classroom = await classroomOrg(session)
  const result = await createRoster(session, classroom.slug, {
    identifierName: 'Padrón',
    identifiers,
  })

  expect(result).toEqual({ success: true })
  return classroom
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
})

/** Port of the DuplicateRosterEntries cases of spec/models/roster_entry_spec.rb */
describe('addSuffixToDuplicates', () => {
  it('leaves distinct identifiers alone', () => {
    expect(addSuffixToDuplicates({ identifiers: ['1', '2'] })).toEqual(['1', '2'])
  })

  // "creates adds suffix to duplicate entries"
  it('suffixes an identifier already on the roster', () => {
    expect(addSuffixToDuplicates({ identifiers: ['John', 'Bob'], existing: ['John'] })).toEqual([
      'John-1',
      'Bob',
    ])
  })

  it('suffixes repetitions inside the same list', () => {
    expect(addSuffixToDuplicates({ identifiers: ['John', 'John', 'John'] })).toEqual([
      'John',
      'John-1',
      'John-2',
    ])
  })

  // The `entry.start_with?("#{identifier}-")` half of the original's count:
  // re-pasting the same list keeps climbing instead of colliding
  it('counts the suffixes already handed out', () => {
    expect(
      addSuffixToDuplicates({ identifiers: ['John'], existing: ['John', 'John-1'] }),
    ).toEqual(['John-2'])
  })
})

describe('parseIdentifiers', () => {
  it('drops blank lines and trims', () => {
    expect(parseIdentifiers('101\r\n\r\n  102  \r\n')).toEqual(['101', '102'])
  })

  // Divergence: the original split on "\r\n" only, and a file pasted from a
  // Unix editor became a single entry
  it('splits on bare newlines too', () => {
    expect(parseIdentifiers('101\n102')).toEqual(['101', '102'])
  })
})

describe('createRoster', () => {
  // "with valid identifiers … creates two roster_entries" / "with correct identifier"
  it('creates the roster with its entries and links the classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createRoster(session, classroom.slug, {
      identifierName: 'Padrón',
      identifiers: '101\r\n102',
    })

    expect(result).toEqual({ success: true })

    const [roster] = await db.select().from(rosters)
    expect(roster.identifierName).toBe('Padrón')

    const entries = await db.select().from(rosterEntries)
    expect(entries.map((entry) => entry.identifier).sort()).toEqual(['101', '102'])
    expect(entries.every((entry) => entry.rosterId === roster.id)).toBe(true)
    // Unlinked until the student claims the identifier
    expect(entries.every((entry) => entry.userId === null)).toBe(true)

    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, classroom.id))
    expect(row.rosterId).toBe(roster.id)
  })

  it('suffixes duplicates instead of rejecting them', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    await createRoster(session, classroom.slug, {
      identifierName: 'Padrón',
      identifiers: '101\n101',
    })

    const entries = await db.select().from(rosterEntries)
    expect(entries.map((entry) => entry.identifier).sort()).toEqual(['101', '101-1'])
  })

  // "with an empty set of identifiers … does not create a roster"
  it('refuses an empty list, and creates nothing', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createRoster(session, classroom.slug, {
      identifierName: 'Padrón',
      identifiers: '   \n\n',
    })

    expect(result).toEqual({ success: false, error: 'Agregá al menos un alumno.' })
    expect(await db.select().from(rosters)).toHaveLength(0)
  })

  // validates :identifier_name, presence: true
  it('refuses an empty identifier name', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    const result = await createRoster(session, classroom.slug, {
      identifierName: ' ',
      identifiers: '101',
    })

    expect(result.success).toBe(false)
    expect(await db.select().from(rosters)).toHaveLength(0)
  })

  // Roster::Creator#ensure_organization_does_not_have_roster!
  it('refuses a classroom that already has a roster', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session)

    const result = await createRoster(session, classroom.slug, {
      identifierName: 'Padrón',
      identifiers: '999',
    })

    expect(result).toEqual({ success: false, error: 'Este classroom ya tiene un roster.' })
    expect(await db.select().from(rosters)).toHaveLength(1)
  })

  // "sends not found if the user doesn't belong to the organization"
  it('refuses a classroom that is not the teacher’s', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomOrg(owner)

    const result = await createRoster(stranger, classroom.slug, {
      identifierName: 'Padrón',
      identifiers: '101',
    })

    expect(result).toEqual({ success: false, error: 'No encontramos ese classroom.' })
    expect(await db.select().from(rosters)).toHaveLength(0)
  })
})

describe('findRoster', () => {
  // `current_roster.roster_entries.includes(:user).order(:identifier)`
  it('returns the entries ordered by identifier', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '103\n101\n102')

    const roster = await findRoster(session, classroom.slug)

    expect(roster?.identifierName).toBe('Padrón')
    expect(roster?.entries.map((entry) => entry.identifier)).toEqual(['101', '102', '103'])
    expect(roster?.entries.every((entry) => entry.githubLogin === null)).toBe(true)
  })

  it('reads the login of a linked entry', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const [student] = await db
      .insert(users)
      .values({ uid: 5150, githubLogin: 'alumna', githubName: 'Ada L' })
      .returning({ id: users.id })

    await db.update(rosterEntries).set({ userId: student.id })

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries[0].githubLogin).toBe('alumna')
  })

  // ensure_current_roster redirects to #new
  it('returns null when the classroom has no roster', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    expect(await findRoster(session, classroom.slug)).toBeNull()
    expect(await rosterSummary(session, classroom.slug)).toBeNull()
  })

  it('returns null for a classroom that is not the teacher’s', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomWithRoster(owner)

    expect(await findRoster(stranger, classroom.slug)).toBeNull()
  })
})

describe('rosterSummary', () => {
  it('counts the entries', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102\n103')

    expect(await rosterSummary(session, classroom.slug)).toEqual({
      identifierName: 'Padrón',
      count: 3,
    })
  })
})

describe('addStudents', () => {
  // "when all identifiers are valid … creates the student on the roster"
  it('adds the students', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')

    const result = await addStudents(session, classroom.slug, '102\r\n103')

    expect(result).toEqual({ success: true, created: 2, requested: 2 })

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries.map((entry) => entry.identifier)).toEqual(['101', '102', '103'])
  })

  // "when there are duplicate identifiers … creates roster entries"
  it('suffixes an identifier that is already on the roster', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')

    const result = await addStudents(session, classroom.slug, '101')

    expect(result).toEqual({ success: true, created: 1, requested: 1 })

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries.map((entry) => entry.identifier)).toEqual(['101', '101-1'])
  })

  // flash[:warning] = "No students created."
  it('creates nothing from a blank list', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')

    expect(await addStudents(session, classroom.slug, '  \n\n')).toEqual({
      success: true,
      created: 0,
      requested: 0,
    })
  })

  it('refuses a classroom that is not the teacher’s', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomWithRoster(owner, '101')

    const result = await addStudents(stranger, classroom.slug, '102')

    expect(result.success).toBe(false)
    expect(await db.select().from(rosterEntries)).toHaveLength(1)
  })
})

describe('renameEntry', () => {
  it('renames the entry', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102')
    const roster = await findRoster(session, classroom.slug)

    const result = await renameEntry(session, classroom.slug, roster!.entries[0].id, ' 999 ')

    expect(result).toEqual({ success: true })

    const updated = await findRoster(session, classroom.slug)
    expect(updated?.entries.map((entry) => entry.identifier)).toEqual(['102', '999'])
  })

  // check_for_duplicate_entry
  it('refuses an identifier already on the roster', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102')
    const roster = await findRoster(session, classroom.slug)

    const result = await renameEntry(session, classroom.slug, roster!.entries[0].id, '102')

    expect(result).toEqual({
      success: false,
      error: 'Ya hay un alumno con el identificador "102".',
    })
  })

  it('refuses an empty identifier', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102')
    const roster = await findRoster(session, classroom.slug)

    const result = await renameEntry(session, classroom.slug, roster!.entries[0].id, '  ')

    expect(result.success).toBe(false)
  })

  // ensure_current_roster_entry: `current_roster.roster_entries.find_by(id:)`
  it('refuses an entry that belongs to another classroom’s roster', async () => {
    const session = await classroomTeacher()
    const mine = await classroomWithRoster(session, '101')
    const other = await classroomWithRoster(session, '201')
    const otherRoster = await findRoster(session, other.slug)

    const result = await renameEntry(session, mine.slug, otherRoster!.entries[0].id, '999')

    expect(result).toEqual({ success: false, error: 'No encontramos a ese alumno en el roster.' })
    const untouched = await findRoster(session, other.slug)
    expect(untouched?.entries[0].identifier).toBe('201')
  })
})

describe('deleteEntry', () => {
  it('removes the student from the roster', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102')
    const roster = await findRoster(session, classroom.slug)

    const result = await deleteEntry(session, classroom.slug, roster!.entries[0].id)

    expect(result).toEqual({ success: true })

    const updated = await findRoster(session, classroom.slug)
    expect(updated?.entries.map((entry) => entry.identifier)).toEqual(['102'])
  })

  // ensure_enough_members_in_roster: "You cannot delete the last member of your roster!"
  it('refuses to remove the last student', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const roster = await findRoster(session, classroom.slug)

    const result = await deleteEntry(session, classroom.slug, roster!.entries[0].id)

    expect(result.success).toBe(false)
    expect(await db.select().from(rosterEntries)).toHaveLength(1)
  })

  it('refuses an entry that belongs to another classroom’s roster', async () => {
    const session = await classroomTeacher()
    const mine = await classroomWithRoster(session, '101\n102')
    const other = await classroomWithRoster(session, '201\n202')
    const otherRoster = await findRoster(session, other.slug)

    const result = await deleteEntry(session, mine.slug, otherRoster!.entries[0].id)

    expect(result).toEqual({ success: false, error: 'No encontramos a ese alumno en el roster.' })
    expect(await db.select().from(rosterEntries)).toHaveLength(4)
  })
})

describe('deleteRoster', () => {
  // #remove_organization, "Roster successfully deleted!"
  it('unhooks the roster and destroys it with its entries', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102')

    expect(await deleteRoster(session, classroom.slug)).toEqual({ success: true })

    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, classroom.id))
    expect(row.rosterId).toBeNull()

    expect(await db.select().from(rosters)).toHaveLength(0)
    // dependent: :destroy, which is ON DELETE CASCADE here
    expect(await db.select().from(rosterEntries)).toHaveLength(0)
  })

  // `Organization.where(roster_id: current_roster.id).count.zero?`
  it('keeps the roster while another classroom still points at it', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const [roster] = await db.select().from(rosters)

    const shared = await classroomOrg(session)
    await db
      .update(organizations)
      .set({ rosterId: roster.id })
      .where(eq(organizations.id, shared.id))

    expect(await deleteRoster(session, classroom.slug)).toEqual({ success: true })

    expect(await db.select().from(rosters)).toHaveLength(1)
    expect(await db.select().from(rosterEntries)).toHaveLength(1)
    expect(await findRoster(session, shared.slug)).not.toBeNull()
  })

  it('refuses a classroom that is not the teacher’s', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomWithRoster(owner, '101')

    expect((await deleteRoster(stranger, classroom.slug)).success).toBe(false)
    expect(await db.select().from(rosters)).toHaveLength(1)
  })
})

/** Port of RosterEntry.to_csv, exercised through #download_roster */
describe('rosterCsv', () => {
  // "should export CSV with all entries"
  it('writes a row per entry, ordered by identifier', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '102\n101')

    expect(await rosterCsv(session, classroom.slug)).toBe(
      '"identifier","github_username","github_id","name"\n' +
        '"101","","",""\n' +
        '"102","","",""\n',
    )
  })

  it('fills in the GitHub columns of a linked entry', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const [student] = await db
      .insert(users)
      .values({ uid: 5150, githubLogin: 'alumna', githubName: 'Lovelace, Ada' })
      .returning({ id: users.id })

    await db.update(rosterEntries).set({ userId: student.id })

    // force_quotes: the name with a comma stays in one column
    expect(await rosterCsv(session, classroom.slug)).toBe(
      '"identifier","github_username","github_id","name"\n' +
        '"101","alumna","5150","Lovelace, Ada"\n',
    )
  })

  it('returns null for a classroom that is not the teacher’s', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomWithRoster(owner, '101')

    expect(await rosterCsv(stranger, classroom.slug)).toBeNull()
  })
})
