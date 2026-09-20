import { describe, expect, it } from 'vitest'

import { apiKeyFileContents, apiKeyFileName } from '@/lib/api-key-file'

/**
 * No equivalent in the original, which has no API keys at all. These pin the
 * shape the worker reads, so renaming a field fails here rather than there.
 */
describe('apiKeyFileContents', () => {
  const apiKey = { label: 'PC de casa', scopes: ['grading'] }

  it('carries the label, the url, the key and the scopes', () => {
    const contents = JSON.parse(
      apiKeyFileContents(apiKey, 'fc_abc123', 'https://classroom.fi.uba.ar'),
    )

    expect(contents).toEqual({
      label: 'PC de casa',
      api_url: 'https://classroom.fi.uba.ar/api',
      api_key: 'fc_abc123',
      scopes: ['grading'],
    })
  })

  it('does not leak anything else the row has', () => {
    const contents = JSON.parse(apiKeyFileContents(apiKey, 'fc_abc123', 'http://localhost:3000'))

    expect(Object.keys(contents)).toEqual(['label', 'api_url', 'api_key', 'scopes'])
  })

  it('derives the url from the origin it is given, so a local key points at localhost', () => {
    const contents = JSON.parse(apiKeyFileContents(apiKey, 'fc_abc123', 'http://localhost:3000'))

    expect(contents.api_url).toBe('http://localhost:3000/api')
  })

  it('is indented, since a teacher opens it to check what it is', () => {
    expect(apiKeyFileContents(apiKey, 'fc_abc123', 'http://localhost:3000')).toContain('\n  "label"')
  })
})

describe('apiKeyFileName', () => {
  it('slugs the label, so two downloads do not collide', () => {
    expect(apiKeyFileName({ id: 7, label: 'PC de casa' })).toBe('fiuba-classroom-pc-de-casa.json')
    expect(apiKeyFileName({ id: 8, label: 'Worker de corrección' })).toBe(
      'fiuba-classroom-worker-de-correccion.json',
    )
  })

  it('falls back to the id when nothing survives the slug', () => {
    expect(apiKeyFileName({ id: 7, label: '???' })).toBe('fiuba-classroom-7.json')
  })
})
