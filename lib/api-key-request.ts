import { NextResponse } from 'next/server'

import { authenticateApiKey } from '@/lib/data/api-keys'

/**
 * The `Authorization: Bearer <key>` check shared by every non-browser API
 * route — the grading lease endpoints today, whatever else gets built on top
 * of api_keys later. Kept out of lib/data/ on purpose: it touches
 * `Request`/`NextResponse`, which lib/data/ never imports.
 */
export type ApiKeyAuth = { userId: number; apiKeyId: number }

export async function authenticateRequest(
  request: Request,
  scope: string,
): Promise<{ ok: true; auth: ApiKeyAuth } | { ok: false; response: NextResponse }> {
  const header = request.headers.get('authorization')
  const rawKey = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''

  const result = rawKey ? await authenticateApiKey(rawKey, scope) : ({ success: false } as const)

  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `API key inválida o sin el scope ${scope}.` },
        { status: 401 },
      ),
    }
  }

  return { ok: true, auth: { userId: result.userId, apiKeyId: result.apiKeyId } }
}
