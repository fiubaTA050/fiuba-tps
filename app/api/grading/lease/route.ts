import { NextResponse } from 'next/server'

import { authenticateRequest } from '@/lib/api-key-request'
import { leaseSubmissionForGrading } from '@/lib/data/grading'

/**
 * The grading worker asks for one submission to correct. See
 * grading-runs-plan: the worker holds no GitHub App credentials of its own —
 * this mints a token scoped to the one repository it hands back.
 *
 * No request body: the server picks what to grade, not the worker (point 2
 * of the algorithm in grading-runs-plan).
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request, 'grading')
  if (!auth.ok) return auth.response

  const lease = await leaseSubmissionForGrading(auth.auth.userId, auth.auth.apiKeyId)

  // Nothing to grade right now — not an error, so 204 rather than an empty 200
  if (!lease) return new NextResponse(null, { status: 204 })

  return NextResponse.json(lease, { headers: { 'Cache-Control': 'private, no-store' } })
}
