import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { parseAssignmentKind } from '@/lib/assignment-paths'
import { findSubmissionHistory } from '@/lib/data/submissions'
import { positiveInteger } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

/**
 * The full submission history of one repo on one entrega, for the teacher
 * dashboard's per-row disclosure. Not eager on the assignment page — see
 * `findSubmissionHistory` on why fetching this per-row on demand, rather than
 * for the whole cohort at once, is deliberate.
 *
 * `checkpointId` is a query param, not a path segment: it names which of the
 * assignment's entregas the open tab is showing, the same value
 * `listAssignmentSubmissions` already scoped the dashboard rows to.
 *
 * So is `kind=group`, which reads `assignmentSlug` as a group assignment and
 * the repository as a team's — one route for both dashboards rather than a
 * second tree under /group-assignments for the same handler.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; assignmentSlug: string; repoId: string }> },
) {
  const session = await auth()
  if (!isUsableSession(session)) {
    return NextResponse.json({ history: null }, { status: 401 })
  }

  const { slug, assignmentSlug, repoId } = await params
  const id = Number(repoId)
  // positiveInteger, not a bare `Number(...)`: an absent or blank param would
  // otherwise coerce to 0 and pass `Number.isInteger`, same pitfall its own
  // doc comment warns about for a missing hidden input.
  const query = new URL(request.url).searchParams
  const checkpointId = positiveInteger(query.get('checkpointId'))
  const kind = parseAssignmentKind(query.get('kind'))
  if (!Number.isInteger(id) || checkpointId === null) {
    return NextResponse.json({ history: null }, { status: 400 })
  }

  const history = await findSubmissionHistory(session, slug, assignmentSlug, id, checkpointId, kind)
  if (history === null) {
    return NextResponse.json({ history: null }, { status: 404 })
  }

  // Confirmations of a specific student, so this must never sit in a shared cache
  return NextResponse.json({ history }, { headers: { 'Cache-Control': 'private, no-store' } })
}
