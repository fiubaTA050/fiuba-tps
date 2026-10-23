import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { NextResponse } from 'next/server'

import { sessionFromApiKey } from '@/lib/data/api-keys'
import { READ_SCOPE, WRITE_SCOPE, createMcpServer } from '@/lib/mcp/server'
import { baseUrl } from '@/lib/url'

/**
 * The MCP endpoint a teacher adds to Claude Code:
 *
 *   claude mcp add --transport http fiuba <host>/api/mcp \
 *     --header "Authorization: Bearer <api key>"
 *
 * Authenticated with an API key from /settings/api-keys rather than OAuth: a
 * key already exists for the grading worker, and none of the tools needs the
 * teacher's GitHub token (see `sessionFromApiKey`).
 *
 * Stateless, with plain JSON responses: a fresh server and transport per POST
 * and no SSE stream, since a serverless function cannot hold one open between
 * requests and no tool runs long enough to stream progress.
 */
export async function POST(request: Request) {
  const header = request.headers.get('authorization')
  const rawKey = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  const found = rawKey ? await sessionFromApiKey(rawKey) : null

  // `classroom:write` implies read — see lib/data/api-key-scopes.ts
  if (!found || !found.scopes.some((scope) => scope === READ_SCOPE || scope === WRITE_SCOPE)) {
    return NextResponse.json(
      { error: `API key inválida o sin el scope ${READ_SCOPE} o ${WRITE_SCOPE}.` },
      { status: 401 },
    )
  }

  const server = createMcpServer(found.session, found.scopes, await baseUrl())
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)

  return transport.handleRequest(request)
}

/** No server-initiated stream and no session to end: see the jsdoc above */
function methodNotAllowed() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } })
}

export const GET = methodNotAllowed
export const DELETE = methodNotAllowed
