import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  groupAssignmentInvitations,
  groupAssignmentRepos,
  groupAssignments,
  groupInviteStatuses,
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
 * The import of an export made with
 * github-education-resources/classroom-export-utility.
 *
 * There is no original spec to port: the Rails app had nothing to import from,
 * it *was* the source. So the cases below are the export's own traps, all of
 * them seen on the real export of TA050 (three classrooms, five assignments,
 * 181 acceptances): the student id that is not GitHub's, the roster that only
 * exists inside grades.csv, and the team name that lives in a different file
 * from the team's members.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const { importClassroom } = await import('@/lib/data/import')
const { githubUid, parseCsv, planExport, readExport } = await import(
  '@/lib/import/classroom-export'
)

beforeEach(async () => {
  ;({ db } = await createTestDatabase())
})

/** GitHub's own avatar URL, the only place the real id appears in an export */
const avatar = (uid: number) => `https://avatars.githubusercontent.com/u/${uid}?v=4`

type Student = { login: string; uid: number; name: string | null; identifier: string }

const ana: Student = { login: 'ana', uid: 1001, name: 'Ana Pérez', identifier: '100\tPÉREZ, ANA' }
const beto: Student = { login: 'beto', uid: 1002, name: null, identifier: '' }
const caro: Student = { login: 'caro', uid: 1003, name: 'Caro', identifier: '300\tGÓMEZ, CARO' }

type FixtureOptions = {
  title?: string
  shortKey?: string
  /** Repository ids are unique across the database, so a second export needs its own */
  repoBase?: number
  /** Puts caro on the other team in the second group assignment */
  moved?: boolean
  /** Gives ana a second padrón, which the roster's unique index cannot link twice */
  duplicateIdentifier?: boolean
}

/**
 * An export directory with the same shape the utility produces: one directory
 * per classroom, one per assignment, and the four files inside it.
 */
function writeExport(options: FixtureOptions = {}): string {
  const {
    title = 'Distribuidos 2026',
    shortKey = 'aBcDeFgH',
    repoBase = 5000,
    moved = false,
    duplicateIdentifier = false,
  } = options

  const root = mkdtempSync(join(tmpdir(), 'classroom-export-'))
  const classroom = {
    id: 1,
    name: title,
    archived: false,
    url: `https://classroom.github.com/classrooms/99-${title.toLowerCase().replace(/ /g, '-')}`,
  }

  writeFileSync(join(root, 'classrooms.json'), JSON.stringify([classroom]))

  const path = join(root, 'classroom-1')
  mkdirSync(path)
  writeFileSync(
    join(path, 'classroom.json'),
    JSON.stringify({
      ...classroom,
      organization: {
        id: 99,
        login: 'catedra',
        node_id: 'O_abc',
        html_url: 'https://github.com/catedra',
        name: null,
        avatar_url: avatar(99),
      },
    }),
  )

  const student = (person: Student) => ({
    // Classroom's own id, deliberately different from the GitHub one: this is
    // the trap the importer exists to avoid
    id: person.uid + 900_000,
    login: person.login,
    name: person.name,
    avatar_url: avatar(person.uid),
    html_url: `https://github.com/${person.login}`,
  })

  const repository = (id: number, name: string) => ({
    id,
    name,
    full_name: `catedra/${name}`,
    html_url: `https://github.com/catedra/${name}`,
    node_id: `R_${id}`,
    private: true,
    default_branch: 'main',
  })

  const base = {
    public_repo: false,
    invitations_enabled: true,
    students_are_repo_admins: false,
    feedback_pull_requests_enabled: false,
    max_teams: null,
    max_members: null,
    deadline: null,
    classroom,
  }

  const tp1 = {
    ...base,
    id: 10,
    title: 'TP1',
    slug: 'tp1',
    type: 'individual' as const,
    invite_link: `https://classroom.github.com/a/${shortKey}`,
    deadline: '2026-04-01T18:03:00Z',
  }

  const groupAssignment = (id: number, slug: string) => ({
    ...base,
    id,
    title: slug.toUpperCase(),
    slug,
    type: 'group' as const,
    invite_link: `https://classroom.github.com/g/${shortKey}${id}`,
    max_members: 2,
  })

  const tp2 = groupAssignment(11, 'tp2')
  const tp3 = groupAssignment(12, 'tp3')

  writeFileSync(join(path, 'assignments.json'), JSON.stringify([tp1, tp2, tp3]))

  const csvHeader =
    'assignment_name,assignment_url,starter_code_url,github_username,roster_identifier,' +
    'student_repository_name,student_repository_url,submission_timestamp,points_awarded,points_available'

  const row = (person: Student, repo: string, group?: string, identifier?: string) =>
    [
      'TP',
      'https://classroom.github.com/x',
      '',
      person.login,
      `"${identifier ?? person.identifier}"`,
      repo,
      `https://github.com/catedra/${repo}`,
      '',
      '0',
      '0',
      ...(group ? [group] : []),
    ].join(',')

  // TP1, individual: ana has a repository, beto accepted without one
  write(path, 'assignment-10', {
    assignment: { ...tp1, starter_code_repository: repository(4999, 'tp1-starter') },
    accepted: [
      {
        id: 1,
        submitted: false,
        commit_count: 3,
        students: [student(ana)],
        repository: repository(repoBase + 1, 'tp1-ana'),
      },
      { id: 2, submitted: false, commit_count: 0, students: [student(beto)], repository: null },
    ],
    csv: [
      csvHeader,
      row(ana, 'tp1-ana'),
      row(beto, 'tp1-beto'),
      ...(duplicateIdentifier ? [row(ana, 'tp1-ana', undefined, '101\tPÉREZ, ANA (bis)')] : []),
    ].join('\n'),
  })

  // TP2 and TP3, group, on the same two teams — which is what a grouping is
  const teams = (assignment: string, offset: number, swap: boolean) => [
    {
      id: offset,
      submitted: false,
      commit_count: 7,
      students: [student(ana), student(swap ? caro : beto)],
      repository: repository(repoBase + offset, `${assignment}-los-pibes`),
    },
    {
      id: offset + 1,
      submitted: false,
      commit_count: 1,
      students: [student(swap ? beto : caro)],
      repository: repository(repoBase + offset + 1, `${assignment}-solistas`),
    },
  ]

  for (const [assignment, definition, offset, swap] of [
    ['tp2', tp2, 20, false],
    ['tp3', tp3, 30, moved],
  ] as const) {
    const accepted = teams(assignment, offset, swap)
    write(path, `assignment-${definition.id}`, {
      assignment: { ...definition, starter_code_repository: null },
      accepted,
      csv: [
        `${csvHeader},group_name`,
        ...accepted.flatMap((entry, index) =>
          entry.students.map((member) =>
            row(
              [ana, beto, caro].find((person) => person.login === member.login)!,
              entry.repository!.name,
              index === 0 ? 'Los Pibes' : 'Solistas',
            ),
          ),
        ),
      ].join('\n'),
    })
  }

  return root
}

function write(
  path: string,
  directory: string,
  files: { assignment: unknown; accepted: unknown; csv: string },
): void {
  const target = join(path, directory)
  mkdirSync(target)
  writeFileSync(join(target, 'assignment.json'), JSON.stringify(files.assignment))
  writeFileSync(join(target, 'accepted-assignments.json'), JSON.stringify(files.accepted))
  writeFileSync(join(target, 'grades.csv'), files.csv)
}

function plan(options: FixtureOptions = {}) {
  return planExport(readExport(writeExport(options)))[0]
}

/** Everyone the plan names, with the id the export already knows */
function resolved(users: { login: string; uid: number | null; name: string | null }[]) {
  return users.map((user) => ({
    login: user.login,
    uid: user.uid!,
    name: user.name,
    avatarUrl: avatar(user.uid!),
    htmlUrl: `https://github.com/${user.login}`,
  }))
}

const teacher = { login: 'profe', uid: 7, name: 'La Profe', avatarUrl: null, htmlUrl: null }

async function importFixture(options: FixtureOptions = {}) {
  const classroom = plan(options)
  const result = await importClassroom(classroom, {
    installationId: 42,
    users: [...resolved(classroom.users), teacher],
    teachers: ['profe'],
  })

  return { plan: classroom, result }
}

describe('reading the export', () => {
  it('takes the GitHub id from the avatar, not from the export id', () => {
    // `students[].id` is Classroom's own: on the real export @espinaemmanuel is
    // 3268030 there and 517713 on GitHub
    expect(plan().users.map((user) => [user.login, user.uid])).toEqual([
      ['ana', 1001],
      ['beto', 1002],
      ['caro', 1003],
    ])
  })

  it('parses a quoted identifier with a comma and a tab inside it', () => {
    const rows = parseCsv<{ a: string; b: string }>('a,b\n1,"109525\tURBANO, SOL"\n')
    expect(rows).toEqual([{ a: '1', b: '109525\tURBANO, SOL' }])
  })

  it('reads no id from an avatar that is not GitHub’s', () => {
    expect(githubUid('https://example.com/foto.png')).toBeNull()
    expect(githubUid(null)).toBeNull()
  })

  it('rebuilds the roster from grades.csv and turns the tab into a space', () => {
    expect(plan().roster).toEqual([
      { identifier: '100 PÉREZ, ANA', login: 'ana' },
      { identifier: '300 GÓMEZ, CARO', login: 'caro' },
    ])
  })

  it('reports the students who accepted without a padrón', () => {
    expect(plan().warnings).toContainEqual(expect.stringContaining('@beto'))
  })

  it('keeps a second padrón unlinked, which is what the unique index allows', () => {
    const roster = plan({ duplicateIdentifier: true }).roster
    expect(roster).toContainEqual({ identifier: '101 PÉREZ, ANA (bis)', login: null })
    expect(plan({ duplicateIdentifier: true }).warnings).toContainEqual(
      expect.stringContaining('dos padrones'),
    )
  })

  it('takes the team name from grades.csv and the slug from the repository', () => {
    expect(plan().teams).toEqual([
      { title: 'Los Pibes', slug: 'los-pibes', members: ['ana', 'beto'] },
      { title: 'Solistas', slug: 'solistas', members: ['caro'] },
    ])
  })

  it('says the deadline is dropped', () => {
    expect(plan().warnings).toContainEqual(expect.stringContaining('deadline'))
  })

  it('refuses an export where a student changed teams inside the classroom', () => {
    // groups_users is unique on (grouping_id, user_id) and groups on
    // (organization_id, slug): there is no way to hold both memberships
    expect(plan({ moved: true }).errors).toContainEqual(expect.stringContaining('@caro'))
  })
})

describe('importing it', () => {
  it('writes the classroom, its teacher and its roster', async () => {
    const { result } = await importFixture()
    expect(result).toMatchObject({ success: true, slug: '99-distribuidos-2026' })

    const [classroom] = await db.select().from(organizations)
    expect(classroom).toMatchObject({ githubId: 99, installationId: 42, title: 'Distribuidos 2026' })
    expect(classroom.archivedAt).toBeNull()

    const [link] = await db.select().from(organizationsUsers)
    const [profe] = await db.select().from(users).where(eq(users.uid, 7))
    expect(link).toEqual({ organizationId: classroom.id, userId: profe.id })

    const [roster] = await db.select().from(rosters)
    expect(classroom.rosterId).toBe(roster.id)
    expect(await db.select().from(rosterEntries)).toHaveLength(2)
  })

  it('creates the students with their GitHub id', async () => {
    await importFixture()

    const rows = await db.select({ uid: users.uid, login: users.githubLogin }).from(users)
    expect(rows).toEqual(
      expect.arrayContaining([
        { uid: 1001, login: 'ana' },
        { uid: 1002, login: 'beto' },
        { uid: 1003, login: 'caro' },
        { uid: 7, login: 'profe' },
      ]),
    )
  })

  it('reuses the row of a student who had already signed in', async () => {
    const [existing] = await db
      .insert(users)
      .values({ uid: 1001, githubLogin: 'ana-vieja' })
      .returning({ id: users.id })

    await importFixture()

    const rows = await db.select().from(users).where(eq(users.uid, 1001))
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(existing.id)
    // GitHub is the source of truth for the name, so the import refreshes it
    expect(rows[0].githubLogin).toBe('ana')
  })

  it('writes the individual assignment with its starter code and its repositories', async () => {
    await importFixture()

    const [assignment] = await db.select().from(assignments)
    expect(assignment).toMatchObject({
      title: 'TP1',
      slug: 'tp1',
      publicRepo: false,
      starterCodeRepoId: 4999,
    })

    // beto accepted without a repository, so only ana has a row
    const repos = await db.select().from(assignmentRepos)
    expect(repos).toHaveLength(1)
    expect(repos[0].githubRepoId).toBe(5001)

    const statuses = await db
      .select({ status: inviteStatuses.status })
      .from(inviteStatuses)
      .orderBy(inviteStatuses.id)
    expect(statuses.map((row) => row.status)).toEqual(['completed', 'accepted'])
  })

  it('keeps the short key of the exported invitation and mints a new long one', async () => {
    await importFixture()

    const [invitation] = await db.select().from(assignmentInvitations)
    expect(invitation.shortKey).toBe('aBcDeFgH')
    expect(invitation.key).toMatch(/^[0-9a-f]{32}$/)
  })

  it('mints another short key when that one is taken', async () => {
    await importFixture()
    // A second export of the same classroom under another name: same links,
    // other repositories
    const { result } = await importFixture({
      title: 'Distribuidos 2027',
      repoBase: 6000,
    })

    expect(result).toMatchObject({ success: true })

    const invitations = await db
      .select({ shortKey: assignmentInvitations.shortKey })
      .from(assignmentInvitations)
    expect(invitations).toHaveLength(2)
    expect(invitations[0].shortKey).toBe('aBcDeFgH')
    expect(invitations[1].shortKey).not.toBe('aBcDeFgH')
  })

  it('puts both group assignments on one set of teams', async () => {
    await importFixture()

    const [grouping] = await db.select().from(groupings)
    expect(grouping.title).toBe('Equipos')

    const rows = await db.select().from(groupAssignments).orderBy(groupAssignments.id)
    expect(rows.map((row) => row.slug)).toEqual(['tp2', 'tp3'])
    expect(rows.every((row) => row.groupingId === grouping.id)).toBe(true)
    expect(rows[0].maxMembers).toBe(2)

    const teams = await db.select().from(groups).orderBy(groups.id)
    expect(teams.map((team) => team.slug)).toEqual(['los-pibes', 'solistas'])

    // ana and beto on one team, caro on the other, once and not twice
    expect(await db.select().from(groupsUsers)).toHaveLength(3)

    const [repos, statuses] = [
      await db.select().from(groupAssignmentRepos),
      await db.select().from(groupInviteStatuses),
    ]
    expect(repos).toHaveLength(4)
    expect(statuses.every((status) => status.status === 'completed')).toBe(true)
    expect(await db.select().from(groupAssignmentInvitations)).toHaveLength(2)
  })

  it('refuses to import the same classroom twice', async () => {
    await importFixture()
    const { result } = await importFixture()

    expect(result).toEqual({
      success: false,
      error: 'Ya existe el classroom "Distribuidos 2026" en @catedra. Borralo antes de reimportar.',
    })
    expect(await db.select().from(organizations)).toHaveLength(1)
  })

  it('leaves nothing behind when a repository was already imported', async () => {
    await importFixture()
    // Same repositories, another classroom: `github_repo_id` is unique
    const { result } = await importFixture({ title: 'Distribuidos 2027' })

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('No se importó nada de "Distribuidos 2027"'),
    })
    expect(await db.select().from(organizations)).toHaveLength(1)
    expect(await db.select().from(assignments)).toHaveLength(1)
  })

  it('refuses a plan it cannot represent, and one with a login it has no id for', async () => {
    const moved = plan({ moved: true })
    expect(await importClassroom(moved, { installationId: 42, users: [], teachers: ['profe'] })).
      toMatchObject({ success: false })

    const classroom = plan()
    expect(
      await importClassroom(classroom, {
        installationId: 42,
        users: [teacher],
        teachers: ['profe'],
      }),
    ).toEqual({ success: false, error: 'Faltan los ids de GitHub de @ana, @beto, @caro.' })
  })

  it('names the classroom archived when the export says so', async () => {
    const classroom = plan()
    classroom.archived = true

    await importClassroom(classroom, {
      installationId: 42,
      users: [...resolved(classroom.users), teacher],
      teachers: ['profe'],
    })

    const [row] = await db.select().from(organizations)
    expect(row.archivedAt).not.toBeNull()
  })
})
