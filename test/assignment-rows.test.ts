import { describe, expect, it } from 'vitest'

import { hasSubmitted, submissionLabel, type RepoRow, type RepoSubmission } from '@/lib/assignment-rows'
import type { RepositorySnapshot } from '@/lib/github/repositories'

/**
 * `submissionLabel` and `hasSubmitted` are pure functions with no spec to
 * port — the original never had a student-declared submission. The cases
 * come from docs/entregas.md and from the third state AGENTS.md describes:
 * a confirmed submission reads differently from a repo that merely has
 * commits.
 */

function snapshot(commitCount: number): RepositorySnapshot {
  return { id: 1, fullName: 'org/repo', htmlUrl: 'https://github.com/org/repo', latestCommitAt: null, commitCount }
}

function submission(overrides: Partial<RepoSubmission> = {}): RepoSubmission {
  return { sha: 'a'.repeat(40), late: false, ...overrides }
}

describe('submissionLabel', () => {
  it('reads "Sin repo" with no repository at all, whatever the third argument is', () => {
    expect(submissionLabel(false, null)).toEqual({ text: 'Sin repo', tone: 'neutral' })
    expect(submissionLabel(false, null, null)).toEqual({ text: 'Sin repo', tone: 'neutral' })
  })

  it('reads "Repo inaccesible" when GitHub has nothing to say about the repo', () => {
    expect(submissionLabel(true, null)).toEqual({ text: 'Repo inaccesible', tone: 'attention' })
  })

  describe('with submission left undefined — no checkpoint tracked (the group dashboard, today)', () => {
    it('reads "Entregado" off commits alone', () => {
      expect(submissionLabel(true, snapshot(3))).toEqual({ text: 'Entregado', tone: 'success' })
    })

    it('reads "Sin entregar" with no commits of the student\'s own', () => {
      expect(submissionLabel(true, snapshot(0))).toEqual({ text: 'Sin entregar', tone: 'danger' })
    })
  })

  describe('with submission tracked — the individual dashboard', () => {
    it('reads "Entregado · <short sha>" once confirmed, regardless of commit count', () => {
      const label = submissionLabel(true, snapshot(5), submission({ sha: 'abc1234deadbeef'.padEnd(40, '0') }))

      expect(label.tone).toBe('success')
      expect(label.text).toBe('Entregado · abc1234')
    })

    it('reads "Sin confirmar" with commits but no confirmation', () => {
      expect(submissionLabel(true, snapshot(2), null)).toEqual({ text: 'Sin confirmar', tone: 'attention' })
    })

    it('reads "Sin entregar" with neither commits nor a confirmation', () => {
      expect(submissionLabel(true, snapshot(0), null)).toEqual({ text: 'Sin entregar', tone: 'danger' })
    })
  })
})

describe('hasSubmitted', () => {
  function row(overrides: Partial<RepoRow> = {}): RepoRow {
    return {
      key: 'k',
      name: 'alumna',
      githubLogin: 'alumna',
      visual: 'account',
      label: { text: '', tone: 'neutral' },
      snapshot: null,
      accepted: true,
      unlinkedIdentifier: false,
      unlinkedAccount: false,
      ...overrides,
    }
  }

  it('falls back to commit count when submission is untracked', () => {
    expect(hasSubmitted(row({ snapshot: snapshot(1) }))).toBe(true)
    expect(hasSubmitted(row({ snapshot: snapshot(0) }))).toBe(false)
  })

  it('reads confirmation instead of commits once submission is tracked', () => {
    // Committed but not confirmed: still counts as not submitted
    expect(hasSubmitted(row({ snapshot: snapshot(4), submission: null }))).toBe(false)
    expect(hasSubmitted(row({ snapshot: snapshot(0), submission: submission() }))).toBe(true)
  })
})
