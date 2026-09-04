/**
 * The scopes an API key can be issued with, shared between the data layer
 * (lib/data/api-keys.ts, which validates against it and has `server-only`)
 * and the client-side picker (app/settings/api-keys/new/NewApiKeyForm.tsx) —
 * this file has no `server-only` so the client component can import it too.
 *
 * One scope so far, but the picker already renders a checkbox per entry:
 * adding a second one is just adding it here and to SCOPE_DESCRIPTIONS.
 */
export const AVAILABLE_SCOPES = ['grading'] as const

export type ApiKeyScope = (typeof AVAILABLE_SCOPES)[number]

/** What the picker shows next to each scope's checkbox */
export const SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  grading: 'Pedir entregas para corregir y devolver resultados (worker de corrección)',
}
