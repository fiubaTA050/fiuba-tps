import { describe, expect, it, vi } from 'vitest'

/**
 * `listRepositorySnapshots`, the one call the assignment dashboard makes to
 * show a whole cohort.
 *
 * The arithmetic is what these cases are about. The original's
 * `AssignmentRepoable#number_of_commits` subtracts the starter code
 * repository's own commit count, which only holds on its importer path; this
 * port always generates from a template and GitHub squashes that into a single
 * "Initial commit" — measured on TA050, a starter of 2 commits produced a
 * student repo of 1. So the baseline is the 1 commit the repository is born
 * with, and a repo still sitting at it has handed in nothing.
 */

/** One page of the GraphQL response, and the queries it was asked for */
const github = {
  pages: [] as unknown[],
  calls: [] as { cursor: string | null }[],
}

vi.mock('@/lib/github/client', () => ({
  installationClient: () => ({
    graphql: async (_query: string, variables: { cursor: string | null }) => {
      github.calls.push({ cursor: variables.cursor })
      return github.pages.shift()
    },
  }),
}))

const { listRepositorySnapshots } = await import('@/lib/github/repositories')

function page(
  nodes: { databaseId: number; commits: number; committedDate?: string }[],
  hasNextPage = false,
) {
  return {
    organization: {
      repositories: {
        pageInfo: { hasNextPage, endCursor: 'cursor-1' },
        nodes: nodes.map((node) => ({
          databaseId: node.databaseId,
          nameWithOwner: `fiubaTA050-labs/repo-${node.databaseId}`,
          url: `https://github.com/fiubaTA050-labs/repo-${node.databaseId}`,
          defaultBranchRef: {
            target: {
              committedDate: node.committedDate ?? '2026-05-06T23:54:26Z',
              history: { totalCount: node.commits },
            },
          },
        })),
      },
    },
  }
}

describe('listRepositorySnapshots', () => {
  it('subtracts the commit the repository was born with', async () => {
    github.pages = [page([{ databaseId: 1, commits: 1 }, { databaseId: 2, commits: 8 }])]
    github.calls = []

    const snapshots = await listRepositorySnapshots(1, 'fiubaTA050-labs', [1, 2], 1)

    // Still at the starter code: nothing handed in
    expect(snapshots.get(1)?.commitCount).toBe(0)
    expect(snapshots.get(2)?.commitCount).toBe(7)
  })

  // An assignment with no starter code starts from an empty repository
  it('counts every commit when there is no baseline', async () => {
    github.pages = [page([{ databaseId: 1, commits: 1 }])]
    github.calls = []

    const snapshots = await listRepositorySnapshots(1, 'fiubaTA050-labs', [1], 0)

    expect(snapshots.get(1)?.commitCount).toBe(1)
  })

  // A student who rewrites history can leave fewer commits than the baseline
  it('never reports a negative count', async () => {
    github.pages = [page([{ databaseId: 1, commits: 0 }])]
    github.calls = []

    const snapshots = await listRepositorySnapshots(1, 'fiubaTA050-labs', [1], 1)

    expect(snapshots.get(1)?.commitCount).toBe(0)
  })

  // The whole point of walking the org: one call for the cohort, not one each
  it('stops paginating as soon as every id has turned up', async () => {
    github.pages = [page([{ databaseId: 1, commits: 3 }], true), page([{ databaseId: 2, commits: 3 }])]
    github.calls = []

    await listRepositorySnapshots(1, 'fiubaTA050-labs', [1], 0)

    expect(github.calls).toHaveLength(1)
  })

  it('keeps paginating while an id is still missing', async () => {
    github.pages = [page([{ databaseId: 1, commits: 3 }], true), page([{ databaseId: 2, commits: 3 }])]
    github.calls = []

    const snapshots = await listRepositorySnapshots(1, 'fiubaTA050-labs', [1, 2], 0)

    expect(github.calls.map((call) => call.cursor)).toEqual([null, 'cursor-1'])
    expect(snapshots.size).toBe(2)
  })

  /**
   * NullGitHubRepository: the repository was deleted or moved out of the org.
   * The row renders as unreachable rather than the page failing.
   */
  it('leaves out an id GitHub does not have', async () => {
    github.pages = [page([{ databaseId: 1, commits: 3 }])]
    github.calls = []

    const snapshots = await listRepositorySnapshots(1, 'fiubaTA050-labs', [1, 999], 0)

    expect(snapshots.has(999)).toBe(false)
    expect(snapshots.size).toBe(1)
  })

  it('asks for nothing when there is nothing to look up', async () => {
    github.pages = []
    github.calls = []

    expect((await listRepositorySnapshots(1, 'fiubaTA050-labs', [], 0)).size).toBe(0)
    expect(github.calls).toHaveLength(0)
  })
})
