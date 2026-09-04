'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { createApiKey, deleteApiKey } from '@/lib/data/api-keys'
import { isUsableSession } from '@/lib/session'

import { EMPTY_STATE, REVEALED_KEY_COOKIE, type ApiKeyActionState, type RevealedKey } from './state'

/**
 * Creates a key and redirects back to the list, the same round trip
 * github.com/settings/personal-access-tokens/new does — the new row shows the
 * raw value once, expanded under it (ApiKeyRow), instead of on this page.
 *
 * The raw value crosses the redirect in a cookie rather than a query string,
 * which would leave it in the browser's history. `maxAge: 60` is a fallback
 * for a client with JS disabled; the ordinary path clears it right after the
 * list reads it, via consumeRevealedKeyAction.
 */
export async function createApiKeyAction(
  _previous: ApiKeyActionState,
  formData: FormData,
): Promise<ApiKeyActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const label = String(formData.get('label') ?? '').trim()
  const scopes = formData.getAll('scopes').map(String)

  if (!label) return { error: 'Ponele un nombre a la key.', label, scopes }
  if (scopes.length === 0) return { error: 'Elegí al menos un permiso.', label, scopes }

  const { id, rawKey } = await createApiKey(session, label, scopes)

  const revealed: RevealedKey = { id, rawKey }
  const jar = await cookies()
  jar.set(REVEALED_KEY_COOKIE, JSON.stringify(revealed), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/settings/api-keys',
    maxAge: 60,
  })

  revalidatePath('/settings/api-keys')
  redirect('/settings/api-keys')
}

/** Fire-and-forget from the client once the revealed row has rendered */
export async function consumeRevealedKeyAction(): Promise<void> {
  const jar = await cookies()
  // `path` must match the one `set` used above: a delete with no path targets
  // "/" instead, which leaves this cookie (scoped to /settings/api-keys)
  // right where it was — the browser then sends both.
  jar.delete({ name: REVEALED_KEY_COOKIE, path: '/settings/api-keys' })
}

export async function deleteApiKeyAction(
  _previous: ApiKeyActionState,
  formData: FormData,
): Promise<ApiKeyActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const keyId = Number(formData.get('key_id'))
  await deleteApiKey(session, keyId)

  revalidatePath('/settings/api-keys')
  return EMPTY_STATE
}
