import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { suggestTeachingAssistants } from '@/lib/data/teaching-assistants'
import { isUsableSession } from '@/lib/session'

/**
 * The suggestions of "Agregar ayudante", next to `github_repos` and shaped
 * like it. No equivalent in the original, which had no one to add.
 *
 * Teacher-only, by the classroom it is asked for: the known accounts it ranks
 * first come from the teacher's own classrooms.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!isUsableSession(session)) {
    return NextResponse.json({ suggestions: [], error: null }, { status: 401 })
  }

  const params = new URL(request.url).searchParams
  const result = await suggestTeachingAssistants(
    session,
    params.get('classroom') ?? '',
    params.get('query') ?? '',
  )
  if (!result) return NextResponse.json({ suggestions: [], error: null }, { status: 404 })

  // Names the teacher's students, so never cached by a shared layer
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
