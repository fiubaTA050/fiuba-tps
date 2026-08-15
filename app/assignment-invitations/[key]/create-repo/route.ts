import { auth } from '@/auth'
import { createStudentRepository } from '@/lib/data/repositories'
import { isUsableSession } from '@/lib/session'

/**
 * Port of AssignmentInvitationsController#create_repo.
 *
 * The original answered `{ job_started, status, repo_url }` after enqueueing a
 * Sidekiq job; here the work happens in this request, measured at ~2.8 s. The
 * caller is the student's own browser, which is what makes their token
 * available to accept the repository invitation. See docs/creacion-de-repos.md.
 */

// Measured worst case is under 3 s. The ceiling is for the day GitHub is slow,
// not for the normal path.
export const maxDuration = 60

export async function POST(
  _request: Request,
  context: RouteContext<'/assignment-invitations/[key]/create-repo'>,
) {
  const session = await auth()

  if (!isUsableSession(session)) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { key } = await context.params
  const result = await createStudentRepository(session, key)

  // 200 in every case, including `retry` and `errored`: these are states of the
  // student's setup, not failures of the request, and the page renders each of
  // them. A 4xx/5xx would only make the client's fetch throw them away.
  return Response.json(result)
}
