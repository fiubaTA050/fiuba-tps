import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { studentsCsv } from '@/lib/csv'
import { listAssignmentAcceptances } from '@/lib/data/invitations'
import { currentInstallationId, findClassroomInstallation } from '@/lib/data/organizations'
import { listRepositorySnapshots } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'

/**
 * The students of an individual assignment with their repositories — the
 * individual counterpart of the group assignment's teams export, see
 * `studentsCsv` for the columns.
 */
export async function GET(
  _request: Request,
  context: RouteContext<'/classrooms/[slug]/assignments/[assignmentSlug]/csv'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await context.params

  const [classroom, acceptances] = await Promise.all([
    findClassroomInstallation(session, slug),
    listAssignmentAcceptances(session, slug, assignmentSlug),
  ])

  if (!classroom || !acceptances) notFound()

  const installationId = await currentInstallationId(session, classroom)
  const repoIds = [...acceptances.entries, ...acceptances.unlinkedAccounts]
    .map((row) => row.repoId)
    .filter((id): id is number => id !== null)

  // The organization is gone: the students still export, without repositories
  const snapshots =
    installationId === null ? new Map() : await listRepositorySnapshots(installationId, repoIds)

  return new Response(studentsCsv(acceptances, snapshots), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${assignmentSlug}-alumnos.csv"`,
    },
  })
}
