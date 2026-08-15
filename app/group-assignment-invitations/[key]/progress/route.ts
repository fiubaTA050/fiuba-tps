import { auth } from '@/auth'
import { currentGroupStatus } from '@/lib/data/group-invitations'
import { findTeamRepository } from '@/lib/data/repositories'
import { isUsableSession } from '@/lib/session'

/**
 * Port of GroupAssignmentInvitationsController#progress.
 *
 * The status is the team's, so a member watching this sees the bar move while
 * a teammate's request is the one doing the work — which is the whole reason
 * the original keyed `group_invite_statuses` on the group.
 */
export async function GET(
  _request: Request,
  context: RouteContext<'/group-assignment-invitations/[key]/progress'>,
) {
  const session = await auth()

  if (!isUsableSession(session)) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { key } = await context.params

  const [status, repository] = await Promise.all([
    currentGroupStatus(session, key),
    findTeamRepository(session, key),
  ])

  return Response.json({ status, repoUrl: repository?.htmlUrl ?? null })
}
