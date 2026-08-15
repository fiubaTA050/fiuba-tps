import { auth } from '@/auth'
import { currentStatus } from '@/lib/data/invitations'
import { isUsableSession } from '@/lib/session'

/**
 * Port of AssignmentInvitationsController#progress, which answered
 *
 *   { status: ..., repo_url: current_submission&.github_repository&.html_url }
 *
 * `repoUrl` is always null here: `assignment_repos` gets no rows until
 * repository creation is ported. The field stays in the shape so the setup
 * screen does not have to change when it starts arriving.
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

  return Response.json({ status: await currentStatus(session, key), repoUrl: null })
}
