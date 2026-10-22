import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { teamsCsv } from '@/lib/csv'
import { listGroupAssignmentAcceptances } from '@/lib/data/groups'
import { currentInstallationId, findClassroomInstallation } from '@/lib/data/organizations'
import { listRepositorySnapshots } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'

/**
 * The teams of a group assignment with their members and repositories, as the
 * live site's "Download grades" of a group assignment lists them — see
 * `teamsCsv` for the columns. The original has no such export; the nearest is
 * download_roster's `grouping` parameter, which only adds the team name.
 *
 * The repositories are read with `listRepositorySnapshots`, the dashboard's
 * batched query by id (DA-2), rather than one REST call per team.
 */
export async function GET(
  _request: Request,
  context: RouteContext<'/classrooms/[slug]/group-assignments/[assignmentSlug]/csv'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await context.params

  const [classroom, acceptances] = await Promise.all([
    findClassroomInstallation(session, slug),
    listGroupAssignmentAcceptances(session, slug, assignmentSlug),
  ])

  if (!classroom || !acceptances) notFound()

  const installationId = await currentInstallationId(session, classroom)
  const repoIds = acceptances.teams
    .map((team) => team.repoId)
    .filter((id): id is number => id !== null)

  // The organization is gone: the teams still export, without repositories
  const snapshots =
    installationId === null ? new Map() : await listRepositorySnapshots(installationId, repoIds)

  return new Response(teamsCsv(acceptances, snapshots), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${assignmentSlug}-equipos.csv"`,
    },
  })
}
