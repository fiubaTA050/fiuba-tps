import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignments,
  inviteStatuses,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Port of spec/controllers/assignment_invitations_controller_spec.rb and of the
 * `#status` and `#redeem_for` cases of spec/models/assignment_invitation_spec.rb.
 *
 * spec/models/assignment_repo_spec.rb has no counterpart yet: every one of its
 * cases is about a row that exists alongside a GitHub repository — the
 * `<user, assignment>` uniqueness, `github_repository`, the legacy
 * `repo_access` alias — and this change deliberately creates no such rows. The
 * one case that carries over conceptually, "should only have one assignment
 * repository for each user-assignment combination", is here as the uniqueness
 * of an invite status per (invitation, student).
 *
 * The original's #create_repo and #progress cases about enqueued jobs are not
 * portable either: there is no job.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const {
  INVITATIONS_DISABLED,
  INVITATIONS_DISABLED_ARCHIVED,
  acceptInvitation,
  currentStatus,
  findInvitation,
  joinRoster,
  listAssignmentAcceptances,
  listUnlinkedRosterEntries,
} = await import('@/lib/data/invitations')

let nextUid = 1
let nextGithubId = 1000

/** The `classroom_student` of the original's factories: a user, no classroom */
async function classroomStudent(login = 'alumno-fiuba'): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: `${login}-${uid}` })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: `${login}-${uid}` },
  } as Session
}

/** A teacher, which here only means somebody in organizations_users */
async function classroomTeacher(): Promise<Session> {
  return classroomStudent('docente-fiuba')
}

/**
 * The `classroom_org` + `assignment_invitation` of the original's factories:
 * a classroom owned by `teacher`, one individual assignment, one invitation.
 */
async function classroomWithAssignment(
  teacher: Session,
  options: { invitationsEnabled?: boolean; archived?: boolean } = {},
) {
  const githubId = nextGithubId++
  const slug = `${githubId}-classroom`

  const [classroom] = await db
    .insert(organizations)
    .values({
      githubId,
      installationId: githubId,
      title: slug,
      slug,
      archivedAt: options.archived ? new Date() : null,
    })
    .returning({ id: organizations.id, slug: organizations.slug })

  await db
    .insert(organizationsUsers)
    .values({ organizationId: classroom.id, userId: Number(teacher.user.id) })

  const [assignment] = await db
    .insert(assignments)
    .values({
      organizationId: classroom.id,
      creatorId: Number(teacher.user.id),
      title: 'TP0',
      slug: 'tp0',
      invitationsEnabled: options.invitationsEnabled ?? true,
    })
    .returning({ id: assignments.id, slug: assignments.slug })

  const key = `key-${githubId}`
  await db.insert(assignmentInvitations).values({ assignmentId: assignment.id, key })

  return { classroom, assignment, key }
}

/** Attaches a roster to a classroom, the way Roster::Creator does */
async function attachRoster(classroomId: number, identifiers: string[]) {
  const [roster] = await db
    .insert(rosters)
    .values({ identifierName: 'Padrón' })
    .returning({ id: rosters.id })

  await db
    .insert(rosterEntries)
    .values(identifiers.map((identifier) => ({ rosterId: roster.id, identifier })))

  await db.update(organizations).set({ rosterId: roster.id }).where(eq(organizations.id, classroomId))

  return roster
}

async function entryFor(rosterId: number, identifier: string) {
  const [entry] = await db
    .select()
    .from(rosterEntries)
    .where(eq(rosterEntries.identifier, identifier))

  expect(entry.rosterId).toBe(rosterId)
  return entry
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
})

describe('findInvitation', () => {
  // "find_by!(key: params[:id])" raising RecordNotFound
  it('returns null for a key that matches nothing', async () => {
    const student = await classroomStudent()
    expect(await findInvitation(student, 'no-existe')).toBeNull()
  })

  /**
   * The original's `#status`: "should create an invite status for a user when
   * one does not exist". Divergence, see db/schema.ts — no row is written on a
   * read, and its absence is what `unaccepted` means.
   */
  it('reports unaccepted for a student who never accepted, without writing a row', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher)

    const invitation = await findInvitation(student, key)

    expect(invitation?.status).toBe('unaccepted')
    expect(await db.select().from(inviteStatuses)).toEqual([])
  })

  // "returns the InviteStatus that belongs to the user and the invite"
  it('returns the status of the caller and nobody else', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const other = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher)

    await acceptInvitation(other, key)

    expect((await findInvitation(student, key))?.status).toBe('unaccepted')
    expect((await findInvitation(other, key))?.status).toBe('accepted')
  })

  // A soft-deleted assignment is invisible: `default_scope { where(deleted_at: nil) }`
  it('returns null once the assignment is soft-deleted', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { assignment, key } = await classroomWithAssignment(teacher)

    await db
      .update(assignments)
      .set({ deletedAt: new Date() })
      .where(eq(assignments.id, assignment.id))

    expect(await findInvitation(student, key)).toBeNull()
  })

  it('carries the roster and the entry the student holds', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    const roster = await attachRoster(classroom.id, ['101', '102'])

    expect((await findInvitation(student, key))?.rosterEntry).toBeNull()

    const entry = await entryFor(roster.id, '101')
    await joinRoster(student, key, entry.id)

    expect((await findInvitation(student, key))?.rosterEntry).toEqual({
      id: entry.id,
      identifier: '101',
    })
  })
})

/** Port of the `#redeem_for` cases of spec/models/assignment_invitation_spec.rb */
describe('acceptInvitation', () => {
  it('records the acceptance', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher)

    expect(await acceptInvitation(student, key)).toEqual({ success: true, status: 'accepted' })
    expect(await currentStatus(student, key)).toBe('accepted')
  })

  // "fails if invitations are not enabled"
  it('fails when invitations are disabled', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher, { invitationsEnabled: false })

    expect(await acceptInvitation(student, key)).toEqual({
      success: false,
      error: INVITATIONS_DISABLED,
    })
    expect(await db.select().from(inviteStatuses)).toEqual([])
  })

  // "fails if the classroom is archived"
  it('fails when the classroom is archived', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher, { archived: true })

    expect(await acceptInvitation(student, key)).toEqual({
      success: false,
      error: INVITATIONS_DISABLED_ARCHIVED,
    })
  })

  /**
   * The AssignmentRepo spec's "should only have one assignment repository for
   * each user-assignment combination", moved to the row that now carries the
   * acceptance.
   */
  it('is idempotent: accepting twice leaves one row', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher)

    await acceptInvitation(student, key)
    await acceptInvitation(student, key)

    expect(await db.select().from(inviteStatuses)).toHaveLength(1)
  })

  // Once the repository job exists, a reload must not walk the status back
  it('does not move a status that is already past accepted', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher)

    await acceptInvitation(student, key)
    await db.update(inviteStatuses).set({ status: 'creating_repo' })

    expect(await acceptInvitation(student, key)).toEqual({
      success: true,
      status: 'creating_repo',
    })
    expect(await currentStatus(student, key)).toBe('creating_repo')
  })
})

/** Port of the "PATCH #join_roster" cases of the controller spec */
describe('joinRoster', () => {
  // "adds the user to the roster entry"
  it('links the entry to the student', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    const roster = await attachRoster(classroom.id, ['101', '102'])
    const entry = await entryFor(roster.id, '101')

    expect(await joinRoster(student, key, entry.id)).toEqual({ success: true, identifier: '101' })

    const [linked] = await db.select().from(rosterEntries).where(eq(rosterEntries.id, entry.id))
    expect(linked.userId).toBe(Number(student.user.id))
  })

  // "with invalid roster entry id" → flash[:error]
  it('refuses an id that is on no roster at all', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    await attachRoster(classroom.id, ['101'])

    const result = await joinRoster(student, key, 987_654)
    expect(result).toEqual({
      success: false,
      error: 'No encontramos ese identificador en el roster.',
    })
  })

  /**
   * `organization.roster.roster_entries.find(...)` scopes the lookup to *this*
   * classroom's roster: an id from another classroom's roster is as good as a
   * made-up one, and must not link anything.
   */
  it('refuses an entry that belongs to another classroom roster', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    await attachRoster(classroom.id, ['101'])

    const { classroom: other } = await classroomWithAssignment(teacher)
    const otherRoster = await attachRoster(other.id, ['999'])
    const foreign = await entryFor(otherRoster.id, '999')

    expect(await joinRoster(student, key, foreign.id)).toEqual({
      success: false,
      error: 'No encontramos ese identificador en el roster.',
    })

    const [untouched] = await db
      .select()
      .from(rosterEntries)
      .where(eq(rosterEntries.id, foreign.id))
    expect(untouched.userId).toBeNull()
  })

  it('refuses when the classroom has no roster', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher)

    expect(await joinRoster(student, key, 1)).toEqual({
      success: false,
      error: 'Este classroom no tiene un roster.',
    })
  })

  /**
   * Divergence from InvitationsControllerMethods#join_roster, whose
   * `unless user_on_roster?` never looks at the entry: there, this call takes
   * the padrón over and silently unlinks its owner.
   */
  it('refuses a padrón already claimed by another account', async () => {
    const teacher = await classroomTeacher()
    const first = await classroomStudent()
    const second = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    const roster = await attachRoster(classroom.id, ['101', '102'])
    const entry = await entryFor(roster.id, '101')

    await joinRoster(first, key, entry.id)

    const result = await joinRoster(second, key, entry.id)
    expect(result.success).toBe(false)

    const [linked] = await db.select().from(rosterEntries).where(eq(rosterEntries.id, entry.id))
    expect(linked.userId).toBe(Number(first.user.id))
  })

  // `unless user_on_roster?` — the branch that is kept
  it('leaves a student who already holds an entry where they are', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    const roster = await attachRoster(classroom.id, ['101', '102'])
    const first = await entryFor(roster.id, '101')
    const second = await entryFor(roster.id, '102')

    await joinRoster(student, key, first.id)

    expect(await joinRoster(student, key, second.id)).toEqual({
      success: true,
      identifier: '101',
    })

    const [other] = await db.select().from(rosterEntries).where(eq(rosterEntries.id, second.id))
    expect(other.userId).toBeNull()
  })
})

/** Port of Roster#unlinked_entries, which is what the join_roster view lists */
describe('listUnlinkedRosterEntries', () => {
  it('lists the entries with no account, by identifier', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    const roster = await attachRoster(classroom.id, ['103', '101', '102'])

    expect((await listUnlinkedRosterEntries(student, key)).map((e) => e.identifier)).toEqual([
      '101',
      '102',
      '103',
    ])

    const other = await classroomStudent()
    await joinRoster(other, key, (await entryFor(roster.id, '102')).id)

    expect((await listUnlinkedRosterEntries(student, key)).map((e) => e.identifier)).toEqual([
      '101',
      '103',
    ])
  })

  it('is empty when the classroom has no roster', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { key } = await classroomWithAssignment(teacher)

    expect(await listUnlinkedRosterEntries(student, key)).toEqual([])
  })
})

/**
 * Port of the `@roster_entries` of AssignmentsController#show with
 * RosterEntry.order_for_view, and of its `@unlinked_user_repos`.
 */
describe('listAssignmentAcceptances', () => {
  it('orders accepted, then linked but not accepted, then unlinked', async () => {
    const teacher = await classroomTeacher()
    const accepted = await classroomStudent()
    const linked = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    const roster = await attachRoster(classroom.id, ['101', '102', '103'])

    await joinRoster(accepted, key, (await entryFor(roster.id, '103')).id)
    await acceptInvitation(accepted, key)
    await joinRoster(linked, key, (await entryFor(roster.id, '102')).id)

    const acceptances = await listAssignmentAcceptances(teacher, classroom.slug, 'tp0')

    expect(acceptances?.identifierName).toBe('Padrón')
    expect(acceptances?.entries.map((entry) => [entry.identifier, entry.state])).toEqual([
      ['103', 'accepted'],
      ['102', 'linked_not_accepted'],
      ['101', 'not_joined'],
    ])
    expect(acceptances?.acceptedCount).toBe(1)
    expect(acceptances?.unlinkedAccounts).toEqual([])
  })

  // The live site's "Unlinked GitHub accounts": accepted after skipping join_roster
  it('reports an acceptance with no roster entry separately', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)
    await attachRoster(classroom.id, ['101'])

    await acceptInvitation(student, key)

    const acceptances = await listAssignmentAcceptances(teacher, classroom.slug, 'tp0')

    expect(acceptances?.entries.map((entry) => entry.state)).toEqual(['not_joined'])
    expect(acceptances?.unlinkedAccounts.map((account) => account.userId)).toEqual([
      Number(student.user.id),
    ])
  })

  // The `else` of assignments#show: no roster, so everyone who accepted is the list
  it('lists everyone who accepted when there is no roster', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)

    await acceptInvitation(student, key)

    const acceptances = await listAssignmentAcceptances(teacher, classroom.slug, 'tp0')

    expect(acceptances?.identifierName).toBeNull()
    expect(acceptances?.entries).toEqual([])
    expect(acceptances?.acceptedCount).toBe(1)
  })

  // OrganizationAuthorization: the teacher boundary still applies here
  it('returns null for somebody who does not teach the classroom', async () => {
    const teacher = await classroomTeacher()
    const stranger = await classroomStudent()
    const { classroom } = await classroomWithAssignment(teacher)

    expect(await listAssignmentAcceptances(stranger, classroom.slug, 'tp0')).toBeNull()
  })

  // An acceptance of one assignment must not show up under another
  it('counts only the acceptances of this assignment', async () => {
    const teacher = await classroomTeacher()
    const student = await classroomStudent()
    const { classroom, key } = await classroomWithAssignment(teacher)

    const [second] = await db
      .insert(assignments)
      .values({
        organizationId: classroom.id,
        creatorId: Number(teacher.user.id),
        title: 'TP1',
        slug: 'tp1',
      })
      .returning({ id: assignments.id })

    await db
      .insert(assignmentInvitations)
      .values({ assignmentId: second.id, key: `${key}-tp1` })

    await acceptInvitation(student, key)

    expect((await listAssignmentAcceptances(teacher, classroom.slug, 'tp0'))?.acceptedCount).toBe(1)
    expect((await listAssignmentAcceptances(teacher, classroom.slug, 'tp1'))?.acceptedCount).toBe(0)
  })
})
