import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiKeys, users } from '@/db/schema'

import { createTestDatabase } from './helpers/db'

let db: Awaited<ReturnType<typeof createTestDatabase>>['db']
let client: Awaited<ReturnType<typeof createTestDatabase>>['client']

vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

const { authenticateApiKey, createApiKey, deleteApiKey, listApiKeys } = await import(
  '@/lib/data/api-keys'
)

let nextUid = 1

async function teacher(): Promise<Session> {
  const uid = nextUid++
  const [user] = await db
    .insert(users)
    .values({ uid, githubLogin: `profe-${uid}` })
    .returning({ id: users.id })

  return {
    accessToken: 'gho_test',
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: String(user.id), uid, githubLogin: `profe-${uid}` },
  } as Session
}

beforeEach(async () => {
  ;({ db, client } = await createTestDatabase())
  nextUid = 1
})

describe('createApiKey', () => {
  it('returns a raw key that hashes to what was stored', async () => {
    const profe = await teacher()

    const { id, rawKey } = await createApiKey(profe, 'PC de casa', ['grading:write'])

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id))
    expect(row.keyHash).not.toBe(rawKey)
    expect(await authenticateApiKey(rawKey, 'grading:write')).toEqual({
      success: true,
      userId: Number(profe.user.id),
      apiKeyId: id,
    })
  })

  it('never generates the same raw key twice', async () => {
    const profe = await teacher()

    const first = await createApiKey(profe, 'a', ['grading:write'])
    const second = await createApiKey(profe, 'b', ['grading:write'])

    expect(first.rawKey).not.toBe(second.rawKey)
  })

  it('drops a scope that is not in AVAILABLE_SCOPES', async () => {
    const profe = await teacher()

    const { id } = await createApiKey(profe, 'a', ['grading:write', 'made-up'])

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id))
    expect(row.scopes).toEqual(['grading:write'])
  })

  it('refuses to create a key with no valid scope', async () => {
    const profe = await teacher()

    await expect(createApiKey(profe, 'a', ['made-up'])).rejects.toThrow()
  })
})

describe('listApiKeys', () => {
  it('only lists the caller’s own keys', async () => {
    const profe = await teacher()
    const ajeno = await teacher()
    await createApiKey(profe, 'mia', ['grading:write'])
    await createApiKey(ajeno, 'ajena', ['grading:write'])

    const found = await listApiKeys(profe)

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ label: 'mia' })
  })
})

describe('deleteApiKey', () => {
  it('deletes a key the caller owns', async () => {
    const profe = await teacher()
    const { id } = await createApiKey(profe, 'mia', ['grading:write'])

    const result = await deleteApiKey(profe, id)

    expect(result).toEqual({ success: true })
    expect(await listApiKeys(profe)).toHaveLength(0)
  })

  it('refuses a key that belongs to another user', async () => {
    const profe = await teacher()
    const ajeno = await teacher()
    const { id } = await createApiKey(profe, 'mia', ['grading:write'])

    const result = await deleteApiKey(ajeno, id)

    expect(result).toEqual({ success: false })
    expect(await listApiKeys(profe)).toHaveLength(1)
  })

  it('is a no-op on a key already deleted', async () => {
    const profe = await teacher()
    const { id } = await createApiKey(profe, 'mia', ['grading:write'])
    await deleteApiKey(profe, id)

    const result = await deleteApiKey(profe, id)

    expect(result).toEqual({ success: false })
  })

  it('refuses a key id that does not exist', async () => {
    const profe = await teacher()

    const result = await deleteApiKey(profe, 999999)

    expect(result).toEqual({ success: false })
  })
})

describe('authenticateApiKey', () => {
  it('rejects a key that was deleted', async () => {
    const profe = await teacher()
    const { rawKey, id } = await createApiKey(profe, 'mia', ['grading:write'])
    await deleteApiKey(profe, id)

    expect(await authenticateApiKey(rawKey, 'grading:write')).toEqual({ success: false })
  })

  it('rejects a scope the key was not granted', async () => {
    const profe = await teacher()
    const { rawKey } = await createApiKey(profe, 'mia', ['grading:write'])

    expect(await authenticateApiKey(rawKey, 'something-else')).toEqual({ success: false })
  })

  it('rejects a key that does not exist', async () => {
    expect(await authenticateApiKey('garbage', 'grading:write')).toEqual({ success: false })
  })
})

/**
 * `grading` became `grading:write`. Keys stored before migration 0020 runs
 * in production still say `grading`, and the worker holding one must keep
 * getting leases through the deploy.
 */
describe('the renamed grading scope', () => {
  async function legacyKey(profe: Session, scopes: string[]): Promise<string> {
    const rawKey = `legacy-${nextUid++}`
    const { createHash } = await import('node:crypto')
    await db.insert(apiKeys).values({
      userId: Number(profe.user.id),
      label: 'worker viejo',
      keyHash: createHash('sha256').update(rawKey).digest('hex'),
      scopes,
    })
    return rawKey
  }

  it('authenticates a key stored as `grading` for `grading:write`', async () => {
    const profe = await teacher()
    const rawKey = await legacyKey(profe, ['grading'])

    expect(await authenticateApiKey(rawKey, 'grading:write')).toMatchObject({ success: true })
  })

  it('lists it under the new name', async () => {
    const profe = await teacher()
    await legacyKey(profe, ['grading'])

    const [key] = await listApiKeys(profe)

    expect(key.scopes).toEqual(['grading:write'])
  })

  it('stores the new name when a stale form still posts `grading`', async () => {
    const profe = await teacher()

    const { id } = await createApiKey(profe, 'pestaña vieja', ['grading'])

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id))
    expect(row.scopes).toEqual(['grading:write'])
  })

  it('is rewritten by migration 0020, leaving the other scopes alone', async () => {
    const profe = await teacher()
    await legacyKey(profe, ['grading', 'classroom:read'])
    await legacyKey(profe, ['classroom:write'])

    await client.exec(
      readFileSync(join(process.cwd(), 'db/migrations/0020_grading_write_scope.sql'), 'utf8'),
    )

    const rows = await db.select({ scopes: apiKeys.scopes }).from(apiKeys).orderBy(apiKeys.id)
    expect(rows.map((row) => row.scopes)).toEqual([
      ['grading:write', 'classroom:read'],
      ['classroom:write'],
    ])
  })
})
