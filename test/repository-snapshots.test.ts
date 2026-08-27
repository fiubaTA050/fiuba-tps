import { describe, expect, it, vi } from 'vitest'

/**
 * `listRepositorySnapshots`, the one call the assignment dashboard makes to
 * show a whole cohort.
 *
 * Two things are under test. The arithmetic: the original's
 * `AssignmentRepoable#number_of_commits` subtracts the starter code
 * repository's own commit count, which only holds on its importer path; this
 * port always generates from a template and GitHub squashes that into a single
 * "Initial commit" — measured on TA050, a starter of 2 commits produced a
 * student repo of 1. So the baseline is the 1 commit the repository is born
 * with, and a repo still sitting at it has handed in nothing.
 *
 * And the lookup: repositories are asked for by their derived node id, in
 * parallel batches, where this used to walk the whole organization page by
 * page. The walk cost the commit history of all 127 repositories of
 * `fiubaTA050-labs` to read 13 of them.
 */

/** What the mocked GraphQL endpoint answers, and what it was asked for */
const github = {
  /** Keyed by node id, so a batch can be answered node by node */
  repositories: new Map<string, unknown>(),
  calls: [] as string[][],
  /** Node ids that make the whole batch fail, the way a deleted repo does */
  missing: new Set<string>(),
}

vi.mock('@/lib/github/client', () => ({
  installationClient: () => ({
    graphql: async (_query: string, variables: { ids: string[] }) => {
      github.calls.push(variables.ids)

      const nodes = variables.ids.map((id) => github.repositories.get(id) ?? null)
      if (variables.ids.some((id) => github.missing.has(id))) {
        // GitHub answers NOT_FOUND for the slot and returns every other node.
        // GraphqlResponseError carries both.
        throw Object.assign(new Error('Could not resolve to a node'), { data: { nodes } })
      }

      return { nodes }
    },
  }),
}))

const { listRepositorySnapshots } = await import('@/lib/github/repositories')

/** The same derivation the implementation does, kept independent of it */
function nodeId(databaseId: number): string {
  const packed = Buffer.alloc(7)
  packed[0] = 0x92
  packed[1] = 0x00
  packed[2] = 0xce
  packed.writeUInt32BE(databaseId, 3)
  return `R_${packed.toString('base64url')}`
}

function given(
  repositories: { databaseId: number; commits: number; committedDate?: string }[],
  missing: number[] = [],
) {
  github.repositories = new Map(
    repositories.map((repository) => [
      nodeId(repository.databaseId),
      {
        databaseId: repository.databaseId,
        nameWithOwner: `fiubaTA050-labs/repo-${repository.databaseId}`,
        url: `https://github.com/fiubaTA050-labs/repo-${repository.databaseId}`,
        defaultBranchRef: {
          target: {
            committedDate: repository.committedDate ?? '2026-05-06T23:54:26Z',
            history: { totalCount: repository.commits },
          },
        },
      },
    ]),
  )
  github.missing = new Set(missing.map(nodeId))
  github.calls = []
}

describe('listRepositorySnapshots', () => {
  it('subtracts the commit the repository was born with', async () => {
    given([{ databaseId: 1, commits: 1 }, { databaseId: 2, commits: 8 }])

    const snapshots = await listRepositorySnapshots(1, [1, 2], 1)

    // Still at the starter code: nothing handed in
    expect(snapshots.get(1)?.commitCount).toBe(0)
    expect(snapshots.get(2)?.commitCount).toBe(7)
  })

  // An assignment with no starter code starts from an empty repository
  it('counts every commit when there is no baseline', async () => {
    given([{ databaseId: 1, commits: 1 }])

    const snapshots = await listRepositorySnapshots(1, [1], 0)

    expect(snapshots.get(1)?.commitCount).toBe(1)
  })

  // A student who rewrites history can leave fewer commits than the baseline
  it('never reports a negative count', async () => {
    given([{ databaseId: 1, commits: 0 }])

    const snapshots = await listRepositorySnapshots(1, [1], 1)

    expect(snapshots.get(1)?.commitCount).toBe(0)
  })

  it('carries the name, the url and the last commit', async () => {
    given([{ databaseId: 7, commits: 4, committedDate: '2026-08-20T10:00:00Z' }])

    const snapshot = (await listRepositorySnapshots(1, [7], 1)).get(7)

    expect(snapshot?.fullName).toBe('fiubaTA050-labs/repo-7')
    expect(snapshot?.htmlUrl).toBe('https://github.com/fiubaTA050-labs/repo-7')
    expect(snapshot?.latestCommitAt).toEqual(new Date('2026-08-20T10:00:00Z'))
  })

  /**
   * The node id is derived from the numeric id, which is the whole reason this
   * can ask by id at all. The vector is measured against the real API:
   * repository 1064428436 is `R_kgDOP3HjlA`.
   */
  it('derives the node id GitHub itself reports', async () => {
    given([{ databaseId: 1064428436, commits: 3 }])

    await listRepositorySnapshots(1, [1064428436], 0)

    expect(github.calls).toEqual([['R_kgDOP3HjlA']])
  })

  // Asked in one query, 80 repositories cost 5.5 s; in batches of 5, 0.6 s
  it('splits the cohort into parallel batches', async () => {
    given(Array.from({ length: 12 }, (_, index) => ({ databaseId: index + 1, commits: 2 })))

    const snapshots = await listRepositorySnapshots(1, Array.from({ length: 12 }, (_, i) => i + 1), 1)

    expect(snapshots.size).toBe(12)
    expect(github.calls.map((batch) => batch.length)).toEqual([5, 5, 2])
  })

  it('asks for each repository once', async () => {
    given([{ databaseId: 1, commits: 2 }])

    await listRepositorySnapshots(1, [1, 1, 1], 0)

    expect(github.calls).toEqual([[nodeId(1)]])
  })

  /**
   * NullGitHubRepository: the repository was deleted or moved out of the org.
   * GitHub fails the whole batch for it, so the rest has to be recovered from
   * the error — otherwise four other students lose their row over one deletion.
   */
  it('keeps the rest of a batch when one repository is gone', async () => {
    given([{ databaseId: 1, commits: 3 }, { databaseId: 2, commits: 5 }], [999])

    const snapshots = await listRepositorySnapshots(1, [1, 2, 999], 0)

    expect(snapshots.has(999)).toBe(false)
    expect(snapshots.get(1)?.commitCount).toBe(3)
    expect(snapshots.get(2)?.commitCount).toBe(5)
  })

  it('leaves out a batch that failed with nothing to recover', async () => {
    given([{ databaseId: 1, commits: 3 }])
    github.repositories = new Map()
    github.missing = new Set([nodeId(1)])

    const snapshots = await listRepositorySnapshots(1, [1], 0)

    expect(snapshots.size).toBe(0)
  })

  it('asks for nothing when there is nothing to look up', async () => {
    given([])

    expect((await listRepositorySnapshots(1, [], 0)).size).toBe(0)
    expect(github.calls).toHaveLength(0)
  })
})
