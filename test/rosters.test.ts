import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignments,
  groupings,
  groups,
  groupsUsers,
  inviteStatuses,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of spec/models/roster_spec.rb, of the `create_entries` cases of
 * spec/models/roster_entry_spec.rb, and of the RostersController cases of
 * spec/controllers/orgs/rosters_controller_spec.rb (#create, #add_students,
 * #edit_entry, #delete_entry, #remove_organization, the CSV of #show).
 *
 * #link and #unlink are ported too, and their cases below start from the
 * original's — `creates link`, `does not create a link` for a user id that is
 * not an unlinked one, and the two of #unlink. The LMS/Google import cases have
 * no counterpart: none of that is ported, see lib/data/rosters.ts.
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
  linkAccountToEntry,
  listUnlinkedEntries,
  parseIdentifiers,
  renameEntry,
  rosterCsv,
  rosterSummary,
  unlinkAccountFromEntry,
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

/**
 * A student who accepted an assignment of this classroom — the original's
 * "unlinked user" once they hold no roster identifier. Keyed off
 * `invite_statuses` rather than `assignment_repos`, which is the divergence
 * `unlinkedUserIdsOf` documents.
 */
async function acceptedStudent(
  teacher: Session,
  classroomId: number,
  login: string,
): Promise<number> {
  const uid = nextUid++

  const [student] = await db
    .insert(users)
    .values({ uid, githubLogin: login })
    .returning({ id: users.id })

  const [assignment] = await db
    .insert(assignments)
    .values({
      organizationId: classroomId,
      creatorId: Number(teacher.user.id),
      title: `TP${uid}`,
      slug: `tp${uid}`,
    })
    .returning({ id: assignments.id })

  const [invitation] = await db
    .insert(assignmentInvitations)
    .values({ assignmentId: assignment.id, key: `key-${uid}` })
    .returning({ id: assignmentInvitations.id })

  await db
    .insert(inviteStatuses)
    .values({ assignmentInvitationId: invitation.id, userId: student.id, status: 'accepted' })

  return student.id
}

/** A GitHub account that has nothing to do with the classroom */
async function outsider(login: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ uid: nextUid++, githubLogin: login })
    .returning({ id: users.id })

  return row.id
}

/** The `id` of an entry by identifier, for the cases that need one */
async function entryId(session: Session, slug: string, identifier: string): Promise<number> {
  const roster = await findRoster(session, slug)
  return roster!.entries.find((entry) => entry.identifier === identifier)!.id
}

describe('linkAccountToEntry', () => {
  // "creates link"
  it('links an account that accepted an assignment of the classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102')
    const student = await acceptedStudent(session, classroom.id, 'alumna')

    const result = await linkAccountToEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '101'),
      student,
    )

    expect(result).toEqual({ success: true })

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries.find((entry) => entry.identifier === '101')?.githubLogin).toBe('alumna')
  })

  /**
   * The original's `user/link does not exist` case, which posts `user_id: 3`.
   * This is the whole of `raise unless unlinked_user_ids.include?(user_id)`:
   * without it a teacher could point an entry at any user id in the database.
   */
  it('refuses an account that never took part in the classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const stranger = await outsider('desconocida')

    const result = await linkAccountToEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '101'),
      stranger,
    )

    expect(result.success).toBe(false)

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries[0].githubLogin).toBeNull()
  })

  // Participation is the classroom's, not the assignment's: unlinked_user_ids
  // is built from every assignment of the organization
  it('links an account that accepted a different assignment of the same classroom', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const student = await acceptedStudent(session, classroom.id, 'alumna')
    await acceptedStudent(session, classroom.id, 'otro')

    const result = await linkAccountToEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '101'),
      student,
    )

    expect(result).toEqual({ success: true })
  })

  // The group half of unlinked_user_ids, which the original read off
  // repo_accesses and this port reads off groups_users
  it('links an account that is only on a team', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')

    const [student] = await db
      .insert(users)
      .values({ uid: nextUid++, githubLogin: 'agrupada' })
      .returning({ id: users.id })

    const [grouping] = await db
      .insert(groupings)
      .values({ organizationId: classroom.id, title: 'Equipos', slug: 'equipos' })
      .returning({ id: groupings.id })

    const [group] = await db
      .insert(groups)
      .values({
        groupingId: grouping.id,
        organizationId: classroom.id,
        title: 'Equipo 1',
        slug: 'equipo-1',
      })
      .returning({ id: groups.id })

    await db
      .insert(groupsUsers)
      .values({ groupId: group.id, groupingId: grouping.id, userId: student.id })

    const result = await linkAccountToEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '101'),
      student.id,
    )

    expect(result).toEqual({ success: true })
  })

  // Not the original's: its #link overwrites whatever the entry held
  it('refuses an entry that is already linked', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const first = await acceptedStudent(session, classroom.id, 'primera')
    const second = await acceptedStudent(session, classroom.id, 'segunda')
    const entry = await entryId(session, classroom.slug, '101')

    expect(await linkAccountToEntry(session, classroom.slug, entry, first)).toEqual({
      success: true,
    })

    const result = await linkAccountToEntry(session, classroom.slug, entry, second)

    expect(result.success).toBe(false)

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries[0].githubLogin).toBe('primera')
  })

  // An account already on the roster is out of unlinked_user_ids by definition
  it('refuses an account that already holds another identifier', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101\n102')
    const student = await acceptedStudent(session, classroom.id, 'alumna')

    await linkAccountToEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '101'),
      student,
    )

    const result = await linkAccountToEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '102'),
      student,
    )

    expect(result.success).toBe(false)

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries.find((entry) => entry.identifier === '102')?.githubLogin).toBeNull()
  })

  it('refuses an entry that belongs to another classroom’s roster', async () => {
    const session = await classroomTeacher()
    const mine = await classroomWithRoster(session, '101')
    const other = await classroomWithRoster(session, '201')
    const student = await acceptedStudent(session, mine.id, 'alumna')

    const result = await linkAccountToEntry(
      session,
      mine.slug,
      await entryId(session, other.slug, '201'),
      student,
    )

    expect(result).toEqual({ success: false, error: 'No encontramos a ese alumno en el roster.' })
  })

  // DA-4: the boundary is organizations_users, as in every other function here
  it('refuses a teacher who is not in the classroom', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomWithRoster(owner, '101')
    const student = await acceptedStudent(owner, classroom.id, 'alumna')
    const entry = await entryId(owner, classroom.slug, '101')

    const result = await linkAccountToEntry(stranger, classroom.slug, entry, student)

    expect(result).toEqual({ success: false, error: 'Este classroom no tiene un roster.' })

    const roster = await findRoster(owner, classroom.slug)
    expect(roster?.entries[0].githubLogin).toBeNull()
  })
})

describe('unlinkAccountFromEntry', () => {
  // "unlinks entry and user"
  it('unlinks a linked entry', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')
    const student = await acceptedStudent(session, classroom.id, 'alumna')
    const entry = await entryId(session, classroom.slug, '101')

    await linkAccountToEntry(session, classroom.slug, entry, student)

    expect(await unlinkAccountFromEntry(session, classroom.slug, entry)).toEqual({ success: true })

    const roster = await findRoster(session, classroom.slug)
    expect(roster?.entries[0].githubLogin).toBeNull()
  })

  // The original's `with an unlinked entry` case, which expects the same flash
  it('succeeds on an entry that was not linked', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '101')

    const result = await unlinkAccountFromEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '101'),
    )

    expect(result).toEqual({ success: true })
  })

  it('refuses an entry that belongs to another classroom’s roster', async () => {
    const session = await classroomTeacher()
    const mine = await classroomWithRoster(session, '101')
    const other = await classroomWithRoster(session, '201')
    const student = await acceptedStudent(session, other.id, 'alumna')
    const entry = await entryId(session, other.slug, '201')

    await linkAccountToEntry(session, other.slug, entry, student)

    expect(await unlinkAccountFromEntry(session, mine.slug, entry)).toEqual({
      success: false,
      error: 'No encontramos a ese alumno en el roster.',
    })

    const roster = await findRoster(session, other.slug)
    expect(roster?.entries[0].githubLogin).toBe('alumna')
  })
})

/** Port of Roster#unlinked_entries, from the teacher's side */
describe('listUnlinkedEntries', () => {
  it('lists only the identifiers nobody claimed, by identifier', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomWithRoster(session, '103\n101\n102')
    const student = await acceptedStudent(session, classroom.id, 'alumna')

    await linkAccountToEntry(
      session,
      classroom.slug,
      await entryId(session, classroom.slug, '102'),
      student,
    )

    expect((await listUnlinkedEntries(session, classroom.slug)).map((e) => e.identifier)).toEqual([
      '101',
      '103',
    ])
  })

  it('is empty for a classroom that is not the teacher’s', async () => {
    const owner = await classroomTeacher('owner')
    const stranger = await classroomTeacher('stranger')
    const classroom = await classroomWithRoster(owner, '101')

    expect(await listUnlinkedEntries(stranger, classroom.slug)).toEqual([])
  })

  it('is empty for a classroom with no roster', async () => {
    const session = await classroomTeacher()
    const classroom = await classroomOrg(session)

    expect(await listUnlinkedEntries(session, classroom.slug)).toEqual([])
  })
})
