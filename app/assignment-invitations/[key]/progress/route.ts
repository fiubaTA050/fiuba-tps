import { auth } from '@/auth'
import { currentStatus } from '@/lib/data/invitations'
import { findStudentRepository } from '@/lib/data/repositories'
import { isUsableSession } from '@/lib/session'

/**
 * Port of AssignmentInvitationsController#progress:
 *
 *   { status: ..., repo_url: current_submission&.github_repository&.html_url }
 *
 * DA-2: the URL is read from GitHub against the stored id, so a repository the
 * teacher renamed still resolves and one that was deleted comes back null.
 */
export async function GET(
  _request: Request,
  context: RouteContext<'/assignment-invitations/[key]/progress'>,
) {
  const session = await auth()

  // The polling outlives the session — a laptop left open overnight. 401
  // rather than a redirect, so the fetch in SetupProgress sees a failure it
  // can ignore instead of parsing a login page as JSON.
  if (!isUsableSession(session)) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { key } = await context.params

  const [status, repository] = await Promise.all([
    currentStatus(session, key),
    findStudentRepository(session, key),
  ])

  return Response.json({ status, repoUrl: repository?.htmlUrl ?? null })
}
