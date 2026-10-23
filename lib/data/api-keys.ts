import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { apiKeys, users } from '@/db/schema'
import { AVAILABLE_SCOPES, currentScopes, type ApiKeyScope } from '@/lib/data/api-key-scopes'
import { db } from '@/lib/db'

export { AVAILABLE_SCOPES, SCOPE_DESCRIPTIONS, type ApiKeyScope } from '@/lib/data/api-key-scopes'

/**
 * API keys — credentials for a non-browser client of the API (the grading
 * worker of docs is the first one, not the only one planned).
 *
 * DA-4: every function takes the session and filters by `session.user.id`.
 * Unlike most of `lib/data/`, there is no classroom to join through — the key
 * belongs to the user, not to a classroom they teach.
 */

export type ApiKeyListItem = {
  id: number
  label: string
  scopes: string[]
  createdAt: Date
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

/** Generates a key, stores only its hash, and returns the raw value once.
 * `scopes` is trusted only as far as AVAILABLE_SCOPES — anything else the
 * caller sends (a stale checkbox value, a hand-crafted request) is dropped
 * rather than stored, since a scope is what an endpoint checks to authorize
 * itself. Throws if that leaves nothing: the form already requires at least
 * one checkbox checked, so an empty result here means the request was
 * tampered with, not a validation case worth a friendly message. */
export async function createApiKey(
  session: Session,
  label: string,
  scopes: string[],
): Promise<{ id: number; rawKey: string }> {
  const validScopes = currentScopes(scopes).filter((scope): scope is ApiKeyScope =>
    (AVAILABLE_SCOPES as readonly string[]).includes(scope),
  )
  if (validScopes.length === 0) throw new Error('No scope selected')

  const rawKey = randomBytes(32).toString('hex')

  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: Number(session.user.id),
      label,
      keyHash: hashKey(rawKey),
      scopes: validScopes,
    })
    .returning({ id: apiKeys.id })

  return { id: row.id, rawKey }
}

/** Every key the user holds, newest first */
export async function listApiKeys(session: Session): Promise<ApiKeyListItem[]> {
  const rows = await db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      scopes: apiKeys.scopes,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, Number(session.user.id)))
    .orderBy(desc(apiKeys.createdAt))

  return rows.map((row) => ({ ...row, scopes: currentScopes(row.scopes) }))
}

/** `success: false` when the key is not the caller's or does not exist — the
 * ownership check lives in the WHERE, not a query first.
 *
 * A hard delete, like GitHub's own "Delete" — not a soft revoke. A key that
 * already authenticated a grading run is not force-kept alive by that: once
 * grading_runs exists (Historia 2), its `apiKeyId` will be nullable with
 * `onDelete: 'set null'`, so deleting a key orphans that reference instead of
 * either blocking the delete or cascading away the grading history. */
export async function deleteApiKey(session: Session, keyId: number): Promise<{ success: boolean }> {
  const [row] = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, Number(session.user.id))))
    .returning({ id: apiKeys.id })

  return { success: Boolean(row) }
}

/** Used by the grading lease endpoints (lib/data/grading.ts) */
export async function authenticateApiKey(
  rawKey: string,
  scope: string,
): Promise<{ success: true; userId: number; apiKeyId: number } | { success: false }> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashKey(rawKey)))

  if (!row || !currentScopes(row.scopes).includes(scope)) return { success: false }

  return { success: true, userId: row.userId, apiKeyId: row.id }
}

/**
 * The key's owner as the Session every other function here takes, for the MCP
 * endpoint (app/api/mcp/route.ts): its tools go through the same boundary as
 * the web — `organizations_users` — and can do nothing the owner could not.
 *
 * `accessToken` is empty because a key carries no GitHub OAuth token. The few
 * paths that use one (`userClient` in lib/github/client.ts: the org list,
 * starter-code search, accepting an invitation) fail with GitHub's 401 rather
 * than acting as anybody, and no tool reaches them.
 */
export async function sessionFromApiKey(
  rawKey: string,
): Promise<{ session: Session; scopes: string[]; apiKeyId: number } | null> {
  const [row] = await db
    .select({
      apiKeyId: apiKeys.id,
      scopes: apiKeys.scopes,
      userId: users.id,
      uid: users.uid,
      githubLogin: users.githubLogin,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hashKey(rawKey)))

  if (!row) return null

  return {
    apiKeyId: row.apiKeyId,
    scopes: currentScopes(row.scopes),
    session: {
      accessToken: '',
      // One request long: nothing keeps this object past the response
      expires: new Date(Date.now() + 60_000).toISOString(),
      user: { id: String(row.userId), uid: row.uid, githubLogin: row.githubLogin ?? '' },
    },
  }
}
