import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { findSubmissionHistory } from '@/lib/data/submissions'
import { isUsableSession } from '@/lib/session'

/**
 * The full submission history of one repo, for the teacher dashboard's
 * per-row disclosure. Not eager on the assignment page — see
 * `findSubmissionHistory` on why fetching this per-row on demand, rather than
 * for the whole cohort at once, is deliberate.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; assignmentSlug: string; repoId: string }> },
) {
  const session = await auth()
  if (!isUsableSession(session)) {
    return NextResponse.json({ history: null }, { status: 401 })
  }

  const { slug, assignmentSlug, repoId } = await params
  const id = Number(repoId)
  if (!Number.isInteger(id)) {
    return NextResponse.json({ history: null }, { status: 400 })
  }

  const history = await findSubmissionHistory(session, slug, assignmentSlug, id)
  if (history === null) {
    return NextResponse.json({ history: null }, { status: 404 })
  }

  // Confirmations of a specific student, so this must never sit in a shared cache
  return NextResponse.json({ history }, { headers: { 'Cache-Control': 'private, no-store' } })
}
