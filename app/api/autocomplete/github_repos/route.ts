import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { searchTemplateRepositories } from '@/lib/github/search'
import { isUsableSession } from '@/lib/session'

/**
 * Port of AutocompleteController#github_repos, kept at the original's path
 * (`/autocomplete/github_repos`, under /api here).
 *
 * The original rendered an HTML partial and let jQuery drop it into the
 * suggestions list. This answers JSON instead: the list is rendered by a React
 * component, and returning markup to be injected would be handing the client
 * something to `innerHTML`.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!isUsableSession(session)) {
    return NextResponse.json({ repositories: [], error: null }, { status: 401 })
  }

  const query = new URL(request.url).searchParams.get('query') ?? ''
  const result = await searchTemplateRepositories(session, query)

  // Private repos of the teacher can appear here, so it must never be cached
  // by a shared layer.
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
