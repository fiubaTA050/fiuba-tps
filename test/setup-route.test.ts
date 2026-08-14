import { describe, expect, it } from 'vitest'

import { GET } from '@/app/github/setup/route'

const HOST = 'https://classroom.fiuba.ar'

async function locationFor(query: string): Promise<string> {
  const response = await GET(new Request(`${HOST}/github/setup${query}`))
  return response.headers.get('location')!
}

/**
 * `state` round-trips through GitHub untouched, so it is attacker-controlled:
 * a crafted install link would bounce a signed-in teacher off-site under our
 * own domain.
 */
describe('GET /github/setup', () => {
  it('returns to the relative path it was given', async () => {
    expect(await locationFor('?state=/classrooms/new')).toBe(`${HOST}/classrooms/new`)
  })

  it('falls back when no state is given', async () => {
    expect(await locationFor('?installation_id=1&setup_action=install')).toBe(
      `${HOST}/classrooms/new`,
    )
  })

  it.each([
    ['protocol-relative', '//evil.com'],
    // The URL parser folds backslashes into slashes for special schemes, so
    // this one defeats a guard that only rejects a literal leading `//`.
    ['backslash', '/\\evil.com'],
    ['mixed slashes', '/\\/evil.com'],
    ['absolute', 'https://evil.com/phish'],
    ['scheme-less absolute', 'evil.com'],
    ['javascript', 'javascript:alert(1)'],
  ])('refuses to redirect off-site: %s', async (_name, state) => {
    const location = await locationFor(`?state=${encodeURIComponent(state)}`)
    expect(new URL(location).origin).toBe(HOST)
  })
})
