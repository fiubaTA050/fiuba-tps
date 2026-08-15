import { auth } from '@/auth'
import { createTeamRepository } from '@/lib/data/repositories'
import { isUsableSession } from '@/lib/session'

/**
 * Port of GroupAssignmentInvitationsController#create_repo.
 *
 * The team's repository is built in the request of whoever gets here first, and
 * every later member's request finds it already there and only grants them
 * their own access. See docs/creacion-de-repos.md.
 */

// Same ceiling as the individual route: the measured path is ~3 s
export const maxDuration = 60

export async function POST(
  _request: Request,
  context: RouteContext<'/group-assignment-invitations/[key]/create-repo'>,
) {
  const session = await auth()

  if (!isUsableSession(session)) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { key } = await context.params
  const result = await createTeamRepository(session, key)

  // 200 in every case, including `retry` and `errored`: these are states of the
  // team's setup, not failures of the request
  return Response.json(result)
}
