import type { GroupAssignmentAcceptances } from '@/lib/data/groups'
import type { AssignmentAcceptances } from '@/lib/data/invitations'
import type { RepositorySnapshot } from '@/lib/github/repositories'

/**
 * Ruby's CSV with `force_quotes: true`, so a padrón that starts with a zero
 * survives the trip through a spreadsheet and a name with a comma does not
 * split.
 */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(quote).join(',')).join('\n') + '\n'
}

/** RFC 4180 quoting */
function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * The teams of a group assignment, one row per member.
 *
 * The columns are named after the live site's "Download grades" export of a
 * group assignment, without the grading ones: `group_name`, `roster_identifier`,
 * `github_username`, `student_repository_name`, `student_repository_url`. Like
 * that export, the students on no team are rows too, with an empty team, so
 * the file is the whole roster. A team with no members is one row with empty
 * member columns, and a repository that does not exist yet or is unreachable
 * on GitHub leaves its two columns empty.
 */
export function teamsCsv(
  acceptances: Pick<GroupAssignmentAcceptances, 'teams' | 'studentsNotOnTeam' | 'identifiers'>,
  snapshots: Map<number, RepositorySnapshot>,
): string {
  const rows = [
    [
      'group_name',
      'roster_identifier',
      'github_username',
      'student_repository_name',
      'student_repository_url',
    ],
  ]

  for (const team of acceptances.teams) {
    const repoColumns = repositoryColumns(team.repoId, snapshots)

    if (team.members.length === 0) rows.push([team.title, '', '', ...repoColumns])

    for (const member of team.members) {
      rows.push([
        team.title,
        acceptances.identifiers.get(member.userId) ?? '',
        member.githubLogin ?? '',
        ...repoColumns,
      ])
    }
  }

  for (const student of acceptances.studentsNotOnTeam) {
    rows.push(['', student.identifier, student.githubLogin ?? '', '', ''])
  }

  return toCsv(rows)
}

/**
 * The students of an individual assignment: `teamsCsv` without `group_name`,
 * as the live site's individual export leaves it out. The roster comes first,
 * in the dashboard's order, students who never joined included; then the
 * accounts that accepted without claiming a roster entry, with no identifier.
 */
export function studentsCsv(
  acceptances: Pick<AssignmentAcceptances, 'entries' | 'unlinkedAccounts'>,
  snapshots: Map<number, RepositorySnapshot>,
): string {
  return toCsv([
    ['roster_identifier', 'github_username', 'student_repository_name', 'student_repository_url'],
    ...acceptances.entries.map((entry) => [
      entry.identifier,
      entry.githubLogin ?? '',
      ...repositoryColumns(entry.repoId, snapshots),
    ]),
    ...acceptances.unlinkedAccounts.map((account) => [
      '',
      account.githubLogin ?? '',
      ...repositoryColumns(account.repoId, snapshots),
    ]),
  ])
}

/** Name and URL, empty while the repository does not exist or is unreachable */
function repositoryColumns(
  repoId: number | null,
  snapshots: Map<number, RepositorySnapshot>,
): [string, string] {
  const repo = repoId === null ? undefined : snapshots.get(repoId)
  return [repo?.fullName.split('/')[1] ?? '', repo?.htmlUrl ?? '']
}
