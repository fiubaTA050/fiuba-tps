import type { Session } from 'next-auth'
import { describe, expect, it } from 'vitest'

import { positiveInteger } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

function session(overrides: Record<string, unknown> = {}): Session {
  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: '7', uid: 1, githubLogin: 'eespina-fiuba' },
    ...overrides,
  } as Session
}

describe('isUsableSession', () => {
  it('accepts a complete session', () => {
    expect(isUsableSession(session())).toBe(true)
  })

  it('rejects no session at all', () => {
    expect(isUsableSession(null)).toBe(false)
  })

  it.each(['RefreshFailed', 'InvalidSession', 'TokenRevoked'])('rejects error %s', (error) => {
    expect(isUsableSession(session({ error }))).toBe(false)
  })

  // Without this, Number(session.user.id) is 0: listClassrooms silently
  // returns nothing and every insert violates the foreign key.
  it('rejects a session with no users row id', () => {
    expect(isUsableSession(session({ user: { id: '', uid: 1, githubLogin: 'x' } }))).toBe(false)
  })
})

describe('positiveInteger', () => {
  it('parses a normal id', () => {
    expect(positiveInteger('4321')).toBe(4321)
  })

  // An unselected hidden input posts "", and Number("") is 0, which passes
  // Number.isInteger — the whole reason this helper looks at the raw value.
  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['zero', '0'],
    ['negative', '-5'],
    ['decimal', '1.5'],
    ['not a number', 'abc'],
    ['beyond safe integer range', '9007199254740993'],
  ])('rejects %s', (_name, value) => {
    expect(positiveInteger(value)).toBeNull()
  })
})
