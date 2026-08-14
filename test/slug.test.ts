import { describe, expect, it } from 'vitest'

import { organizationSlug, parameterize } from '@/lib/data/slug'

/**
 * Reference values come from ActiveSupport's parameterize, which is what the
 * original's `Sluggable` concern calls.
 */
describe('parameterize', () => {
  it('downcases and joins with dashes', () => {
    expect(parameterize('Algoritmos y Programacion II')).toBe('algoritmos-y-programacion-ii')
  })

  it('strips diacritics instead of dropping the letter', () => {
    expect(parameterize('Programación')).toBe('programacion')
    // NFKD decomposes the ñ, matching what ActiveSupport's transliterate does
    expect(parameterize('Diseño')).toBe('diseno')
  })

  it('collapses runs of separators and trims the edges', () => {
    expect(parameterize('  TA050 --- 2026 / 2C  ')).toBe('ta050-2026-2c')
  })

  it('returns an empty string when nothing survives', () => {
    expect(parameterize('---')).toBe('')
    expect(parameterize('日本語')).toBe('')
  })
})

describe('organizationSlug', () => {
  it('is built from github id and title, per Organization#name_for_slug', () => {
    expect(organizationSlug(12345, 'Algoritmos 2026 2C')).toBe('12345-algoritmos-2026-2c')
  })

  it('never collapses to empty, because the github id always survives', () => {
    expect(organizationSlug(12345, '日本語')).toBe('12345')
  })

  it('collides for titles that differ only in punctuation', () => {
    // This is why createClassroom distinguishes the slug unique index from the
    // title one: both titles are legitimately different, only the slug clashes.
    expect(organizationSlug(1, 'Algo 2026')).toBe(organizationSlug(1, 'Algo/2026'))
  })
})
