import { describe, expect, it } from 'vitest'

import { buildRepositoryQuery } from '@/lib/github/search'

/**
 * Port of spec/lib/github/search_spec.rb's coverage of
 * `build_github_repositories_query`.
 *
 * The `template:true` qualifier is the one addition, and it is not cosmetic:
 * measured against the live API, `starter in:name fork:true` returns 1,101,881
 * repos and the same query with `template:true` returns 90,241, all of them
 * templates. `is:template` is silently ignored, so the spelling matters.
 */
describe('buildRepositoryQuery', () => {
  it('searches the name and includes forks', () => {
    expect(buildRepositoryQuery('starter')).toBe('starter in:name fork:true template:true')
  })

  // "add namespace criteria if needed"
  it('turns owner/name into a user qualifier', () => {
    expect(buildRepositoryQuery('fiubaTA050-labs/raft')).toBe(
      'raft in:name fork:true template:true user:fiubaTA050-labs',
    )
  })

  it('drops the owner from the keyword, keeping only the repo part', () => {
    expect(buildRepositoryQuery('actions/typescript-action')).toContain(
      'typescript-action in:name',
    )
    expect(buildRepositoryQuery('actions/typescript-action')).not.toContain('actions/')
  })

  it('handles a trailing slash with no repo name', () => {
    expect(buildRepositoryQuery('fiubaTA050-labs/')).toBe(
      ' in:name fork:true template:true user:fiubaTA050-labs',
    )
  })

  // The qualifier that actually filters. `is:template` looks right and does
  // nothing, which is exactly the kind of thing a test should pin down.
  it('always asks GitHub for templates only', () => {
    for (const input of ['starter', 'org/repo', 'a-b_c']) {
      expect(buildRepositoryQuery(input)).toContain('template:true')
      expect(buildRepositoryQuery(input)).not.toContain('is:template')
    }
  })
})
