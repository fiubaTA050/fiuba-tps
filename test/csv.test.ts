import { describe, expect, it } from 'vitest'

import { studentsCsv, teamsCsv, toCsv } from '@/lib/csv'

describe('toCsv', () => {
  it('quotes every field and doubles the quotes inside one', () => {
    expect(toCsv([['0104001', 'Pérez, "Juan"']])).toBe('"0104001","Pérez, ""Juan"""\n')
  })
})

describe('teamsCsv', () => {
  const member = (userId: number, githubLogin: string | null) => ({
    userId,
    githubLogin,
    githubAvatarUrl: null,
  })

  it('writes one row per member, then the students on no team', () => {
    const csv = teamsCsv(
      {
        teams: [
          {
            id: 1,
            title: 'Distreet boys',
            slug: 'distreet-boys',
            members: [member(10, 'lazcanoluca'), member(11, 'sinpadron')],
            status: 'completed',
            repoId: 500,
          },
          // Accepted but its repository is not there yet
          {
            id: 2,
            title: 'threads',
            slug: 'threads',
            members: [member(12, 'otro')],
            status: 'creating_repo',
            repoId: null,
          },
          // Its last member was removed by the teacher
          { id: 3, title: 'vacío', slug: 'vacio', members: [], status: 'unaccepted', repoId: null },
        ],
        identifiers: new Map([
          [10, '104001'],
          [12, '104003'],
        ]),
        studentsNotOnTeam: [{ identifier: '104002', githubLogin: null }],
      },
      new Map([
        [
          500,
          {
            id: 500,
            fullName: 'fiubaTA050-labs/2026a-tp1-distreet-boys',
            htmlUrl: 'https://github.com/fiubaTA050-labs/2026a-tp1-distreet-boys',
            latestCommitAt: null,
            commitCount: 0,
          },
        ],
      ]),
    )

    expect(csv.trimEnd().split('\n')).toEqual([
      '"group_name","roster_identifier","github_username","student_repository_name","student_repository_url"',
      '"Distreet boys","104001","lazcanoluca","2026a-tp1-distreet-boys","https://github.com/fiubaTA050-labs/2026a-tp1-distreet-boys"',
      '"Distreet boys","","sinpadron","2026a-tp1-distreet-boys","https://github.com/fiubaTA050-labs/2026a-tp1-distreet-boys"',
      '"threads","104003","otro","",""',
      '"vacío","","","",""',
      '"","104002","","",""',
    ])
  })
})

describe('studentsCsv', () => {
  it('writes the roster, then the accounts with no entry, without a team column', () => {
    const csv = studentsCsv(
      {
        entries: [
          { entryId: 1, identifier: '104001', githubLogin: 'lazcanoluca', state: 'accepted', repoId: 500 },
          { entryId: 2, identifier: '104002', githubLogin: null, state: 'not_joined', repoId: null },
        ],
        unlinkedAccounts: [{ userId: 9, githubLogin: 'sinpadron', repoId: 501 }],
      },
      new Map([
        [
          500,
          {
            id: 500,
            fullName: 'fiubaTA050-labs/2026a-tp0-lazcanoluca',
            htmlUrl: 'https://github.com/fiubaTA050-labs/2026a-tp0-lazcanoluca',
            latestCommitAt: null,
            commitCount: 0,
          },
        ],
        // 501 is missing: deleted, or the App lost access to it
      ]),
    )

    expect(csv.trimEnd().split('\n')).toEqual([
      '"roster_identifier","github_username","student_repository_name","student_repository_url"',
      '"104001","lazcanoluca","2026a-tp0-lazcanoluca","https://github.com/fiubaTA050-labs/2026a-tp0-lazcanoluca"',
      '"104002","","",""',
      '"","sinpadron","",""',
    ])
  })
})
