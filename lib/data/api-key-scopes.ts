/**
 * The scopes an API key can be issued with, shared between the data layer
 * (lib/data/api-keys.ts, which validates against it and has `server-only`)
 * and the client-side picker (app/settings/api-keys/new/NewApiKeyForm.tsx) —
 * this file has no `server-only` so the client component can import it too.
 *
 * The picker renders a checkbox per entry: adding a scope is just adding it
 * here and to SCOPE_DESCRIPTIONS. Every name is `<area>:<access>`.
 *
 * `classroom:write` implies `classroom:read` (app/api/mcp/route.ts): a key
 * that can close entregas but not see which ones exist is no use to anybody.
 */
export const AVAILABLE_SCOPES = ['grading:write', 'classroom:read', 'classroom:write'] as const

export type ApiKeyScope = (typeof AVAILABLE_SCOPES)[number]

/** What the picker shows next to each scope's checkbox */
export const SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  'grading:write': 'Pedir entregas para corregir y devolver resultados (worker de corrección)',
  'classroom:read': 'Leer tus classrooms, trabajos prácticos, entregas y alumnos (servidor MCP)',
  'classroom:write':
    'Modificar tus classrooms: por ahora, activar o desactivar trabajos prácticos (servidor MCP). Incluye la lectura',
}

/**
 * Scope names a stored key may still carry from before a rename, and what
 * each one is called now. `grading` was the only scope until the MCP server
 * added the `classroom:*` pair, and became `grading:write` to read like them.
 *
 * Migration 0020 rewrites the stored arrays, but it can only run after the
 * code that understands the new name is deployed — the code before it checks
 * for `grading` — so for the length of that window both names have to work.
 * Drop this once 0020 is applied in production.
 */
const RENAMED_SCOPES: Record<string, ApiKeyScope> = { grading: 'grading:write' }

/** A key's scopes under today's names, without duplicates */
export function currentScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => RENAMED_SCOPES[scope] ?? scope))]
}
