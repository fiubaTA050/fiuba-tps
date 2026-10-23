import { sql } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apiKeys,
  assignmentRepos,
  assignments,
  checkpoints,
  groupAssignmentInvitations,
  groupAssignmentRepos,
  groupAssignments,
  groupings,
  groups,
  groupsUsers,
  organizations,
  organizationsUsers,
  submissions,
  users,
} from '@/db/schema'

import { createTestDatabase } from './helpers/db'

/**
 * Entregas on a group assignment. No spec to port, the same as
 * test/submissions.test.ts: the rules come from docs/entregas.md — any member
 * confirms for the whole team, the last confirmation wins, and nobody outside
 * the team reads or writes it. What is tested here is what the kind changes:
 * the team's repository instead of the student's, membership through
 * `groups_users` as the authorization, and the two kinds never seeing each
 * other's rows.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const github = { refs: new Map<string, string>() }

vi.mock('@/lib/github/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/repositories')>()

  return {
    ...actual,
    resolveRepositoryRef: async (_installationId: number, _repositoryId: number, ref: string) => {
      const sha = github.refs.get(ref)
      if (!sha) return null
      return {
        fullName: 'fiubaTA050-labs/tp1-los-pibes',
        defaultBranch: 'main',
        commit: { sha, committedAt: new Date('2026-10-01T12:00:00Z'), messageHeadline: 'Entrega' },
      }
    },
    isReachableFromDefaultBranch: async () => true,
    findRepositoryOwnerAndName: async (_installationId: number, repositoryId: number) => ({
      owner: 'fiubaTA050-labs',
      name: `repo-${repositoryId}`,
    }),
  }
})

vi.mock('@/lib/github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/client')>()),
  mintRepositoryScopedToken: async () => ({
    token: 'scoped-token',
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
}))

const {
  confirmSubmission,
  findSubmissionDetail,
  findSubmissionHistory,
  findSubmissionPanels,
  justifyLateSubmission,
  listAssignmentSubmissions,
  saveSubmissionFeedback,
  setSubmissionExemption,
} = await import('@/lib/data/submissions')
const { listCheckpoints, saveCheckpoints } = await import('@/lib/data/checkpoints')
const { leaseSubmissionForGrading } = await import('@/lib/data/grading')

let nextUid = 1
let nextGithubId = 1000

const DECLARATION = 'No usamos herramientas de IA.'

async function person(login: string): Promise<Session> {
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

type GroupFixture = {
  profe: Session
  classroomSlug: string
  assignmentSlug: string
  groupAssignmentId: number
  groupingId: number
  organizationId: number
  key: string
}

/** A classroom with one group assignment over one set of teams, no teams yet */
async function groupAssignment(
  options: { invitationsEnabled?: boolean } = {},
): Promise<GroupFixture> {
  const githubId = nextGithubId++
  const profe = await person(`profe-${githubId}`)

  const [classroom] = await db
    .insert(organizations)
    .values({ githubId, installationId: githubId, title: `${githubId}`, slug: `${githubId}-classroom` })
    .returning({ id: organizations.id, slug: organizations.slug })

  await db
    .insert(organizationsUsers)
    .values({ organizationId: classroom.id, userId: Number(profe.user.id) })

  const [grouping] = await db
    .insert(groupings)
    .values({ organizationId: classroom.id, title: `Equipos ${githubId}`, slug: `equipos-${githubId}` })
    .returning({ id: groupings.id })

  const [assignment] = await db
    .insert(groupAssignments)
    .values({
      organizationId: classroom.id,
      groupingId: grouping.id,
      creatorId: Number(profe.user.id),
      title: `TP grupal ${githubId}`,
      slug: `tpg-${githubId}`,
      invitationsEnabled: options.invitationsEnabled ?? true,
    })
    .returning({ id: groupAssignments.id, slug: groupAssignments.slug })

  const key = `gkey-${githubId}`
  await db.insert(groupAssignmentInvitations).values({ groupAssignmentId: assignment.id, key })

  return {
    profe,
    classroomSlug: classroom.slug,
    assignmentSlug: assignment.slug,
    groupAssignmentId: assignment.id,
    groupingId: grouping.id,
    organizationId: classroom.id,
    key,
  }
}

/** A team with these members and, unless `repo: false`, its repository */
async function team(
  fixture: GroupFixture,
  title: string,
  members: Session[],
  options: { repo?: boolean } = {},
): Promise<{ groupId: number; repoId: number | null; githubRepoId: number | null }> {
  const [group] = await db
    .insert(groups)
    .values({
      groupingId: fixture.groupingId,
      organizationId: fixture.organizationId,
      title,
      slug: title.toLowerCase().replace(/\s+/g, '-'),
    })
    .returning({ id: groups.id })

  for (const member of members) {
    await db
      .insert(groupsUsers)
      .values({ groupId: group.id, groupingId: fixture.groupingId, userId: Number(member.user.id) })
  }

  if (options.repo === false) return { groupId: group.id, repoId: null, githubRepoId: null }

  const githubRepoId = nextGithubId++
  const [repo] = await db
    .insert(groupAssignmentRepos)
    .values({ groupAssignmentId: fixture.groupAssignmentId, groupId: group.id, githubRepoId })
    .returning({ id: groupAssignmentRepos.id })

  return { groupId: group.id, repoId: repo.id, githubRepoId }
}

async function groupCheckpoint(
  groupAssignmentId: number,
  values: { title?: string | null; deadlineAt?: Date | null; closedAt?: Date | null; autograderId?: string | null } = {},
): Promise<number> {
  const [checkpoint] = await db
    .insert(checkpoints)
    .values({
      groupAssignmentId,
      title: values.title ?? null,
      deadlineAt: values.deadlineAt ?? null,
      closedAt: values.closedAt ?? null,
      autograderId: values.autograderId ?? null,
    })
    .returning({ id: checkpoints.id })

  return checkpoint.id
}

async function confirm(
  member: Session,
  fixture: GroupFixture,
  checkpointId: number,
  ref = 'main',
) {
  return confirmSubmission(member, fixture.key, checkpointId, ref, DECLARATION, 'group')
}

/** Moves every confirmation into the past, so the cooldown is not what answers */
async function ageSubmissions(): Promise<void> {
  await db.execute(sql`update submissions set submitted_at = submitted_at - interval '1 minute'`)
}

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
  nextUid = 1
  nextGithubId = 1000
  github.refs = new Map([
    ['main', 'a'.repeat(40)],
    ['v1', 'b'.repeat(40)],
  ])
})

describe('confirmSubmission on a group assignment', () => {
  it('writes the team repository and who confirmed', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const { repoId } = await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    const result = await confirm(ana, fixture, checkpointId)
    expect(result).toMatchObject({ success: true, sha: 'a'.repeat(40) })

    const [row] = await db.select().from(submissions)
    expect(row.groupAssignmentRepoId).toBe(repoId)
    expect(row.assignmentRepoId).toBeNull()
    expect(row.submittedByUserId).toBe(Number(ana.user.id))
  })

  it('lets a second member re-submit for the team, and the last one is current', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const beto = await person('beto')
    await team(fixture, 'Los Pibes', [ana, beto])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    await confirm(ana, fixture, checkpointId, 'main')
    await ageSubmissions()
    await confirm(beto, fixture, checkpointId, 'v1')

    // Both members read the same entrega, with who handed in each version
    for (const member of [ana, beto]) {
      const [panel] = (await findSubmissionPanels(member, fixture.key, 'group'))!
      expect(panel.current).toMatchObject({ sha: 'b'.repeat(40), submittedBy: 'beto' })
      expect(panel.history.map((row) => row.submittedBy)).toEqual(['beto', 'ana'])
    }
  })

  it('shares the cooldown across the team, since it protects the repository', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const beto = await person('beto')
    await team(fixture, 'Los Pibes', [ana, beto])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    await confirm(ana, fixture, checkpointId, 'main')
    const result = await confirm(beto, fixture, checkpointId, 'v1')

    expect(result.success).toBe(false)
  })

  it('refuses a student on another team, who reaches their own team instead', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const zoe = await person('zoe')
    await team(fixture, 'Los Pibes', [ana])
    await team(fixture, 'Otro Equipo', [zoe], { repo: false })
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    await confirm(ana, fixture, checkpointId)
    await ageSubmissions()

    const result = await confirm(zoe, fixture, checkpointId, 'v1')
    expect(result).toEqual({
      success: false,
      error: 'Tu equipo todavía no tiene un repositorio para este trabajo práctico.',
    })

    const [panel] = (await findSubmissionPanels(zoe, fixture.key, 'group'))!
    expect(panel.current).toBeNull()
    expect(await db.select().from(submissions)).toHaveLength(1)
  })

  it('refuses a student who is on no team at all', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const suelto = await person('suelto')
    await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    const result = await confirm(suelto, fixture, checkpointId)
    expect(result.success).toBe(false)
  })

  it('refuses while the group assignment is inactive', async () => {
    const fixture = await groupAssignment({ invitationsEnabled: false })
    const ana = await person('ana')
    await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    const result = await confirm(ana, fixture, checkpointId)
    expect(result.success).toBe(false)
  })

  it('does not take a group invitation key on the individual path, or the reverse', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    const result = await confirmSubmission(ana, fixture.key, checkpointId, 'main', DECLARATION)
    expect(result).toEqual({ success: false, error: 'No encontramos ese trabajo práctico.' })
    expect(await findSubmissionPanels(ana, fixture.key)).toBeNull()
  })
})

describe('the teacher on a group assignment', () => {
  it('lists the team submissions by github repo id, apart from the individual ones', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const { githubRepoId } = await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)
    await confirm(ana, fixture, checkpointId)

    const listed = await listAssignmentSubmissions(
      fixture.profe,
      fixture.classroomSlug,
      fixture.assignmentSlug,
      'group',
    )
    expect(listed!.checkpoints).toHaveLength(1)
    expect(listed!.checkpoints[0].byRepoId.get(githubRepoId!)).toMatchObject({ sha: 'a'.repeat(40) })

    // The same slug read as an individual assignment is nothing
    const asIndividual = await listAssignmentSubmissions(
      fixture.profe,
      fixture.classroomSlug,
      fixture.assignmentSlug,
    )
    expect(asIndividual).toEqual({ checkpoints: [] })
  })

  it('does not let a teacher of another classroom read it', async () => {
    const fixture = await groupAssignment()
    const other = await groupAssignment()

    expect(
      await listAssignmentSubmissions(other.profe, fixture.classroomSlug, fixture.assignmentSlug, 'group'),
    ).toBeNull()
  })

  it('reads the history and the detail, with who confirmed', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const beto = await person('beto')
    const { githubRepoId } = await team(fixture, 'Los Pibes', [ana, beto])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)
    await confirm(ana, fixture, checkpointId, 'main')
    await ageSubmissions()
    await confirm(beto, fixture, checkpointId, 'v1')

    const history = await findSubmissionHistory(
      fixture.profe,
      fixture.classroomSlug,
      fixture.assignmentSlug,
      githubRepoId!,
      checkpointId,
      'group',
    )
    expect(history!.map((row) => row.submittedBy)).toEqual(['beto', 'ana'])

    const detail = await findSubmissionDetail(
      fixture.profe,
      fixture.classroomSlug,
      fixture.assignmentSlug,
      githubRepoId!,
      history![1].id,
      'group',
    )
    expect(detail).toMatchObject({
      assignment: { slug: fixture.assignmentSlug },
      team: 'Los Pibes',
      submittedBy: 'ana',
      newer: { sha: 'b'.repeat(40) },
    })

    // A team's repository is not reachable as an individual one
    expect(
      await findSubmissionHistory(
        fixture.profe,
        fixture.classroomSlug,
        fixture.assignmentSlug,
        githubRepoId!,
        checkpointId,
      ),
    ).toEqual([])
  })

  it('lets an exempted team back into a closed entrega', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const { githubRepoId } = await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId, { closedAt: new Date() })

    expect((await confirm(ana, fixture, checkpointId)).success).toBe(false)

    const exempted = await setSubmissionExemption(
      fixture.profe,
      fixture.classroomSlug,
      fixture.assignmentSlug,
      checkpointId,
      githubRepoId!,
      true,
      'group',
    )
    expect(exempted).toEqual({ success: true })
    expect((await confirm(ana, fixture, checkpointId)).success).toBe(true)

    const listed = await listAssignmentSubmissions(
      fixture.profe,
      fixture.classroomSlug,
      fixture.assignmentSlug,
      'group',
    )
    expect([...listed!.checkpoints[0].exemptRepoIds]).toEqual([githubRepoId])
  })

  it('justifies a late team submission and writes its devolución', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const { githubRepoId } = await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId, {
      deadlineAt: new Date(Date.now() - 86_400_000),
    })
    await confirm(ana, fixture, checkpointId)
    const [submission] = await db.select().from(submissions)

    const args = [fixture.profe, fixture.classroomSlug, fixture.assignmentSlug, githubRepoId!, submission.id] as const

    expect(await justifyLateSubmission(...args, 'Se cayó GitHub', 'group')).toEqual({ success: true })
    expect(await saveSubmissionFeedback(...args, 'Muy bien el informe.', null, 'group')).toEqual({
      success: true,
    })

    const detail = await findSubmissionDetail(...args, 'group')
    expect(detail!.submission).toMatchObject({ late: true, lateJustified: true })
    expect(detail!.feedback[0].body).toBe('Muy bien el informe.')
  })
})

describe('checkpoints of a group assignment', () => {
  it('saves and lists them against the group assignment', async () => {
    const fixture = await groupAssignment()

    const saved = await saveCheckpoints(
      fixture.profe,
      fixture.classroomSlug,
      fixture.assignmentSlug,
      [
        { id: null, title: '1A', deadlineAt: null, autograderId: null, closed: false, resultsPublished: false },
        { id: null, title: '1B', deadlineAt: null, autograderId: null, closed: false, resultsPublished: false },
      ],
      undefined,
      'group',
    )
    expect(saved).toEqual({ success: true })

    const listed = await listCheckpoints(fixture.profe, fixture.classroomSlug, fixture.assignmentSlug, 'group')
    expect(listed!.map((row) => row.title)).toEqual(['1A', '1B'])

    const rows = await db.select().from(checkpoints)
    expect(rows.every((row) => row.groupAssignmentId === fixture.groupAssignmentId)).toBe(true)
    expect(rows.every((row) => row.assignmentId === null)).toBe(true)

    expect(await listCheckpoints(fixture.profe, fixture.classroomSlug, fixture.assignmentSlug)).toBeNull()
  })

  it('refuses a checkpoint that belongs to both kinds, or to neither', async () => {
    const fixture = await groupAssignment()
    const [individual] = await db
      .insert(assignments)
      .values({
        organizationId: fixture.organizationId,
        creatorId: Number(fixture.profe.user.id),
        title: 'TP individual',
        slug: 'tp-individual',
      })
      .returning({ id: assignments.id })

    await expect(
      db
        .insert(checkpoints)
        .values({ assignmentId: individual.id, groupAssignmentId: fixture.groupAssignmentId }),
    ).rejects.toThrow()
    await expect(db.insert(checkpoints).values({})).rejects.toThrow()
  })

  it('refuses a submission that names both repositories', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const { repoId } = await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId)

    const [individual] = await db
      .insert(assignments)
      .values({
        organizationId: fixture.organizationId,
        creatorId: Number(fixture.profe.user.id),
        title: 'TP individual',
        slug: 'tp-individual',
      })
      .returning({ id: assignments.id })
    const [own] = await db
      .insert(assignmentRepos)
      .values({ assignmentId: individual.id, userId: Number(ana.user.id), githubRepoId: 1 })
      .returning({ id: assignmentRepos.id })

    await expect(
      db.insert(submissions).values({
        assignmentRepoId: own.id,
        groupAssignmentRepoId: repoId,
        checkpointId,
        sha: 'a'.repeat(40),
        ref: 'main',
        committedAt: new Date(),
        submittedByUserId: Number(ana.user.id),
      }),
    ).rejects.toThrow()
  })
})

describe('grading a team submission', () => {
  it('leases it like a student one', async () => {
    const fixture = await groupAssignment()
    const ana = await person('ana')
    const { githubRepoId } = await team(fixture, 'Los Pibes', [ana])
    const checkpointId = await groupCheckpoint(fixture.groupAssignmentId, { autograderId: 'tp1' })
    await confirm(ana, fixture, checkpointId)
    await db.update(checkpoints).set({ closedAt: new Date() })

    const [key] = await db
      .insert(apiKeys)
      .values({ userId: Number(fixture.profe.user.id), label: 'test', keyHash: 'hash', scopes: ['grading:write'] })
      .returning({ id: apiKeys.id })

    const lease = await leaseSubmissionForGrading(Number(fixture.profe.user.id), key.id)
    expect(lease).toMatchObject({
      repo: { owner: 'fiubaTA050-labs', name: `repo-${githubRepoId}` },
      sha: 'a'.repeat(40),
      autograderId: 'tp1',
    })
  })
})
