import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  checkpoints,
  groupAssignmentInvitations,
  groupAssignmentRepos,
  groupAssignments,
  groupings,
  groups,
  groupsUsers,
  inviteStatuses,
  lateSubmissionJustifications,
  organizations,
  organizationsUsers,
  rosterEntries,
  rosters,
  submissionFeedbacks,
  submissions,
  teachingAssistantAllocations,
  teachingAssistants,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * What a teaching assistant reads, through the readers that opt in with
 * `allowAssistant` — docs/teaching-assistants.md. One classroom, two
 * students, an individual and a group assignment; the TA is allocated the
 * first student's padrón and the first student's team, and must see nothing
 * of the second.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

vi.mock('@/lib/github/organizations', () => ({
  listUserOrganizations: vi.fn(async () => []),
  setDefaultRepositoryPermissionToNone: vi.fn(),
  findOrganizationByInstallation: vi.fn(async () => null),
  findInstallationAccount: vi.fn(async () => null),
}))

const { findAssignment, listAssignments } = await import('@/lib/data/assignments')
const { findGroupAssignment, listGroupAssignments } = await import('@/lib/data/group-assignments')
const { listGroupAssignmentAcceptances } = await import('@/lib/data/groups')
const { listAssignmentAcceptances } = await import('@/lib/data/invitations')
const { classroomCounters, findClassroom, findClassroomInstallation, listClassrooms } =
  await import('@/lib/data/organizations')
const {
  findSubmissionDetail,
  findSubmissionHistory,
  listAssignmentSubmissions,
  saveSubmissionFeedback,
} = await import('@/lib/data/submissions')
const { createApiKey, sessionFromApiKey } = await import('@/lib/data/api-keys')

const OPEN = { allowAssistant: true }
const SLUG = 'sd-2026-1'

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
    via: 'browser',
    user: { id: String(row.id), uid, githubLogin: login },
  } as Session
}

const idOf = (session: Session) => Number(session.user.id)

type World = {
  profe: Session
  ta: Session
  /** Ids of what the TA is allocated, and of what they are not */
  mine: { repo: number; teamRepo: number; submission: number; teamSubmission: number }
  theirs: { repo: number; teamRepo: number; submission: number; teamSubmission: number }
  checkpoint: number
  teamCheckpoint: number
}

async function world(): Promise<World> {
  const profe = await user('profe')
  const ta = await user('ayudante')
  const uno = await user('alumno-uno')
  const dos = await user('alumno-dos')

  const [roster] = await db
    .insert(rosters)
    .values({ identifierName: 'Padrón' })
    .returning({ id: rosters.id })
  const [org] = await db
    .insert(organizations)
    .values({ githubId: 4321, installationId: 99, title: 'SD', slug: SLUG, rosterId: roster.id })
    .returning({ id: organizations.id })
  await db.insert(organizationsUsers).values({ organizationId: org.id, userId: idOf(profe) })
  const [taRow] = await db
    .insert(teachingAssistants)
    .values({ organizationId: org.id, userId: idOf(ta), createdByUserId: idOf(profe) })
    .returning({ id: teachingAssistants.id })

  const [e1] = await db
    .insert(rosterEntries)
    .values([
      { rosterId: roster.id, identifier: '100001', userId: idOf(uno) },
      { rosterId: roster.id, identifier: '100002', userId: idOf(dos) },
    ])
    .returning({ id: rosterEntries.id })

  // Individual: tp0, both accepted, both submitted late, the first justified
  const [tp0] = await db
    .insert(assignments)
    .values({ organizationId: org.id, creatorId: idOf(profe), title: 'TP0', slug: 'tp0' })
    .returning({ id: assignments.id })
  const [invitation] = await db
    .insert(assignmentInvitations)
    .values({ key: 'k-tp0', assignmentId: tp0.id })
    .returning({ id: assignmentInvitations.id })
  await db.insert(inviteStatuses).values([
    { assignmentInvitationId: invitation.id, userId: idOf(uno), status: 'completed' },
    { assignmentInvitationId: invitation.id, userId: idOf(dos), status: 'completed' },
  ])
  const [r1, r2] = await db
    .insert(assignmentRepos)
    .values([
      { githubRepoId: 1001, assignmentId: tp0.id, userId: idOf(uno) },
      { githubRepoId: 1002, assignmentId: tp0.id, userId: idOf(dos) },
    ])
    .returning({ id: assignmentRepos.id })
  const [checkpoint] = await db
    .insert(checkpoints)
    .values({ assignmentId: tp0.id, deadlineAt: new Date('2026-01-01T00:00:00Z') })
    .returning({ id: checkpoints.id })
  const submission = (repoId: number, by: Session) => ({
    assignmentRepoId: repoId,
    checkpointId: checkpoint.id,
    sha: 'a'.repeat(40),
    ref: 'main',
    committedAt: new Date('2026-02-01T00:00:00Z'),
    submittedAt: new Date('2026-02-01T00:00:00Z'),
    submittedByUserId: idOf(by),
  })
  const [s1, s2] = await db
    .insert(submissions)
    .values([submission(r1.id, uno), submission(r2.id, dos)])
    .returning({ id: submissions.id })
  await db.insert(lateSubmissionJustifications).values({
    submissionId: s1.id,
    reason: 'Estuvo internado',
    createdByUserId: idOf(profe),
  })

  // Group: tp1, two teams with a repository and a submission each
  const [set] = await db
    .insert(groupings)
    .values({ organizationId: org.id, title: 'Equipos', slug: 'equipos' })
    .returning({ id: groupings.id })
  const [t1, t2] = await db
    .insert(groups)
    .values([
      { groupingId: set.id, organizationId: org.id, title: 'Los Raft', slug: 'los-raft' },
      { groupingId: set.id, organizationId: org.id, title: 'Los Paxos', slug: 'los-paxos' },
    ])
    .returning({ id: groups.id })
  await db.insert(groupsUsers).values([
    { groupId: t1.id, groupingId: set.id, userId: idOf(uno) },
    { groupId: t2.id, groupingId: set.id, userId: idOf(dos) },
  ])
  const [tp1] = await db
    .insert(groupAssignments)
    .values({
      organizationId: org.id,
      groupingId: set.id,
      creatorId: idOf(profe),
      title: 'TP1',
      slug: 'tp1',
    })
    .returning({ id: groupAssignments.id })
  await db.insert(groupAssignmentInvitations).values({ key: 'k-tp1', groupAssignmentId: tp1.id })
  const [g1, g2] = await db
    .insert(groupAssignmentRepos)
    .values([
      { githubRepoId: 2001, groupAssignmentId: tp1.id, groupId: t1.id },
      { githubRepoId: 2002, groupAssignmentId: tp1.id, groupId: t2.id },
    ])
    .returning({ id: groupAssignmentRepos.id })
  const [teamCheckpoint] = await db
    .insert(checkpoints)
    .values({ groupAssignmentId: tp1.id })
    .returning({ id: checkpoints.id })
  const teamSubmission = (repoId: number, by: Session) => ({
    groupAssignmentRepoId: repoId,
    checkpointId: teamCheckpoint.id,
    sha: 'b'.repeat(40),
    ref: 'main',
    committedAt: new Date(),
    submittedByUserId: idOf(by),
  })
  const [gs1, gs2] = await db
    .insert(submissions)
    .values([teamSubmission(g1.id, uno), teamSubmission(g2.id, dos)])
    .returning({ id: submissions.id })

  // The TA corrects the first student and the first team
  await db.insert(teachingAssistantAllocations).values([
    {
      teachingAssistantId: taRow.id,
      organizationId: org.id,
      assignmentId: tp0.id,
      rosterEntryId: e1.id,
      createdByUserId: idOf(profe),
    },
    {
      teachingAssistantId: taRow.id,
      organizationId: org.id,
      groupAssignmentId: tp1.id,
      groupingId: set.id,
      groupId: t1.id,
      createdByUserId: idOf(profe),
    },
  ])

  return {
    profe,
    ta,
    mine: { repo: 1001, teamRepo: 2001, submission: s1.id, teamSubmission: gs1.id },
    theirs: { repo: 1002, teamRepo: 2002, submission: s2.id, teamSubmission: gs2.id },
    checkpoint: checkpoint.id,
    teamCheckpoint: teamCheckpoint.id,
  }
}

let w: World

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  w = await world()
})

describe('without the opt-in, every reader stays teacher-only', () => {
  it('shuts the TA out of every reader', async () => {
    const { ta } = w
    expect(await findClassroom(ta, SLUG)).toBeNull()
    expect(await findClassroomInstallation(ta, SLUG)).toBeNull()
    expect(await listAssignments(ta, SLUG)).toEqual([])
    expect(await listGroupAssignments(ta, SLUG)).toEqual([])
    expect(await findAssignment(ta, SLUG, 'tp0')).toBeNull()
    expect(await findGroupAssignment(ta, SLUG, 'tp1')).toBeNull()
    expect(await listAssignmentAcceptances(ta, SLUG, 'tp0')).toBeNull()
    expect(await listGroupAssignmentAcceptances(ta, SLUG, 'tp1')).toBeNull()
    expect(await listAssignmentSubmissions(ta, SLUG, 'tp0')).toBeNull()
    expect(
      await findSubmissionDetail(ta, SLUG, 'tp0', w.mine.repo, w.mine.submission),
    ).toBeNull()
    expect(
      await findSubmissionHistory(ta, SLUG, 'tp0', w.mine.repo, w.checkpoint),
    ).toBeNull()
    expect(
      await saveSubmissionFeedback(ta, SLUG, 'tp0', w.mine.repo, w.mine.submission, 'Bien', null),
    ).toBeNull()
  })

  it('gives a teacher the same as before, in the teacher role', async () => {
    expect(await findClassroom(w.profe, SLUG)).toMatchObject({ role: 'teacher' })
    expect(await findClassroom(w.profe, SLUG, OPEN)).toMatchObject({ role: 'teacher' })
    const acceptances = await listAssignmentAcceptances(w.profe, SLUG, 'tp0', OPEN)
    expect(acceptances?.entries).toHaveLength(2)
  })
})

describe('with the opt-in, a TA reads their own rows', () => {
  it('reaches the classroom and every assignment, as an assistant', async () => {
    expect(await findClassroom(w.ta, SLUG, OPEN)).toMatchObject({ role: 'assistant' })
    expect(await findClassroomInstallation(w.ta, SLUG, OPEN)).toMatchObject({
      role: 'assistant',
    })
    expect((await listAssignments(w.ta, SLUG, OPEN)).map((a) => a.slug)).toEqual(['tp0'])
    expect((await listGroupAssignments(w.ta, SLUG, OPEN)).map((a) => a.slug)).toEqual(['tp1'])
    expect(await findAssignment(w.ta, SLUG, 'tp0', OPEN)).toMatchObject({ slug: 'tp0' })
    expect(await findGroupAssignment(w.ta, SLUG, 'tp1', OPEN)).toMatchObject({ slug: 'tp1' })
  })

  it('lists only the allocated padrón, and no account off the roster', async () => {
    const acceptances = await listAssignmentAcceptances(w.ta, SLUG, 'tp0', OPEN)

    expect(acceptances).toMatchObject({
      identifierName: 'Padrón',
      unlinkedAccounts: [],
      acceptedCount: 1,
    })
    expect(acceptances?.entries.map((e) => e.identifier)).toEqual(['100001'])
  })

  it('lists only the allocated team, nobody without a team, and only its padrones', async () => {
    const acceptances = await listGroupAssignmentAcceptances(w.ta, SLUG, 'tp1', OPEN)

    expect(acceptances?.teams.map((t) => t.title)).toEqual(['Los Raft'])
    expect(acceptances?.studentsNotOnTeam).toEqual([])
    expect([...acceptances!.identifiers.values()]).toEqual(['100001'])
  })

  it('reads the submissions of their rows only, without the reason of a justification', async () => {
    const individual = await listAssignmentSubmissions(w.ta, SLUG, 'tp0', 'individual', OPEN)
    const byRepo = individual!.checkpoints[0].byRepoId
    expect([...byRepo.keys()]).toEqual([w.mine.repo])
    expect(byRepo.get(w.mine.repo)?.justification).toMatchObject({ reason: '', createdBy: null })

    const group = await listAssignmentSubmissions(w.ta, SLUG, 'tp1', 'group', OPEN)
    expect([...group!.checkpoints[0].byRepoId.keys()]).toEqual([w.mine.teamRepo])

    // The teacher still reads the reason
    const teacher = await listAssignmentSubmissions(w.profe, SLUG, 'tp0')
    expect(teacher!.checkpoints[0].byRepoId.get(w.mine.repo)?.justification?.reason).toBe(
      'Estuvo internado',
    )
  })

  it('opens the detail of their own submission, justified but without the reasons', async () => {
    const detail = await findSubmissionDetail(
      w.ta,
      SLUG,
      'tp0',
      w.mine.repo,
      w.mine.submission,
      'individual',
      OPEN,
    )

    expect(detail).toMatchObject({ role: 'assistant', justifications: [] })
    expect(detail?.submission).toMatchObject({ late: true, lateJustified: true })
  })

  it('cannot open, or read the history of, anybody else’s', async () => {
    expect(
      await findSubmissionDetail(w.ta, SLUG, 'tp0', w.theirs.repo, w.theirs.submission, 'individual', OPEN),
    ).toBeNull()
    expect(
      await findSubmissionDetail(w.ta, SLUG, 'tp1', w.theirs.teamRepo, w.theirs.teamSubmission, 'group', OPEN),
    ).toBeNull()
    expect(
      await findSubmissionHistory(w.ta, SLUG, 'tp0', w.theirs.repo, w.checkpoint, 'individual', OPEN),
    ).toEqual([])
    expect(
      await findSubmissionHistory(w.ta, SLUG, 'tp0', w.mine.repo, w.checkpoint, 'individual', OPEN),
    ).toHaveLength(1)
  })

  it('writes the devolución of their own rows only', async () => {
    expect(
      await saveSubmissionFeedback(
        w.ta,
        SLUG,
        'tp1',
        w.mine.teamRepo,
        w.mine.teamSubmission,
        'Bien el líder',
        null,
        'group',
        OPEN,
      ),
    ).toEqual({ success: true })
    expect(
      await saveSubmissionFeedback(
        w.ta,
        SLUG,
        'tp1',
        w.theirs.teamRepo,
        w.theirs.teamSubmission,
        'Ajena',
        null,
        'group',
        OPEN,
      ),
    ).toEqual({ success: false, error: 'No encontramos esa entrega.' })

    const saved = await db.select().from(submissionFeedbacks)
    expect(saved).toEqual([
      expect.objectContaining({ submissionId: w.mine.teamSubmission, createdByUserId: idOf(w.ta) }),
    ])
  })

  it('sees nothing once the allocation is gone', async () => {
    await db.delete(teachingAssistantAllocations)

    expect((await listAssignmentAcceptances(w.ta, SLUG, 'tp0', OPEN))?.entries).toEqual([])
    expect(
      [...(await listAssignmentSubmissions(w.ta, SLUG, 'tp0', 'individual', OPEN))!.checkpoints[0]
        .byRepoId.keys()],
    ).toEqual([])
  })

  it('counts only the assignments for the tab bar', async () => {
    expect(await classroomCounters(w.ta, SLUG)).toEqual({
      assignments: 2,
      students: null,
      staff: null,
      role: 'assistant',
    })
    expect(await classroomCounters(w.profe, SLUG)).toMatchObject({ role: 'teacher', students: 2 })
  })

  it('lists the classroom on the TA’s index, with no organization of their own', async () => {
    const cards = await listClassrooms(w.ta)

    expect(cards).toEqual([
      expect.objectContaining({ slug: SLUG, role: 'assistant', organization: null }),
    ])
  })

  it('gives an API key session of the TA nothing, opt-in or not', async () => {
    const { rawKey } = await createApiKey(w.ta, 'mia', ['classroom:read'])
    const keySession = (await sessionFromApiKey(rawKey))!.session

    expect(await findClassroom(keySession, SLUG, OPEN)).toBeNull()
    expect(await listAssignmentAcceptances(keySession, SLUG, 'tp0', OPEN)).toBeNull()
    expect(await listClassrooms(keySession)).toEqual([])
  })
})

