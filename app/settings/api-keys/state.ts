import { AVAILABLE_SCOPES } from '@/lib/data/api-key-scopes'

/**
 * The shape both of this screen's `useActionState` forms carry.
 *
 * Its own module rather than actions.ts: a "use server" file may only export
 * async functions, so `EMPTY_STATE` living there fails at runtime, when the
 * form posts. Same split as app/classrooms/[slug]/roster/state.ts.
 *
 * No `rawKey` field here: creating redirects back to the list on success (see
 * actions.ts), so this state only ever carries a validation error.
 *
 * `label`/`scopes` echo back what was submitted, not just what's checked by
 * default: React resets a `<form>`'s uncontrolled fields to their
 * `defaultValue`/`defaultChecked` after any action call, success or not —
 * without this, a rejected submission (e.g. no scope checked) would wipe the
 * label the teacher already typed, not just the checkboxes.
 */
export type ApiKeyActionState = { error: string | null; label: string; scopes: string[] }

export const EMPTY_STATE: ApiKeyActionState = { error: null, label: '', scopes: [...AVAILABLE_SCOPES] }

/**
 * The raw key exists in plain text for exactly one request: the one right
 * after creating it redirects to. It travels in a short-lived, httpOnly
 * cookie rather than the URL, which would put it in the browser's history —
 * see createApiKeyAction and page.tsx.
 */
export const REVEALED_KEY_COOKIE = 'flash_api_key'

export type RevealedKey = { id: number; rawKey: string }
