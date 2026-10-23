/**
 * The scopes an API key can be issued with, shared between the data layer
 * (lib/data/api-keys.ts, which validates against it and has `server-only`)
 * and the client-side picker (app/settings/api-keys/new/NewApiKeyForm.tsx) —
 * this file has no `server-only` so the client component can import it too.
 *
 * The picker renders a checkbox per entry: adding a scope is just adding it
 * here and to SCOPE_DESCRIPTIONS.
 *
 * `classroom:write` implies `classroom:read` (app/api/mcp/route.ts): a key
 * that can close entregas but not see which ones exist is no use to anybody.
 */
export const AVAILABLE_SCOPES = ['grading', 'classroom:read', 'classroom:write'] as const

export type ApiKeyScope = (typeof AVAILABLE_SCOPES)[number]

/** What the picker shows next to each scope's checkbox */
export const SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  grading: 'Pedir entregas para corregir y devolver resultados (worker de corrección)',
  'classroom:read': 'Leer tus classrooms, trabajos prácticos, entregas y alumnos (servidor MCP)',
  'classroom:write':
    'Modificar tus classrooms: por ahora, activar o desactivar trabajos prácticos (servidor MCP). Incluye la lectura',
}
