import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { AssignmentHeader } from '@/components/AssignmentHeader'
import { Breadcrumb } from '@/components/Breadcrumb'
import { StatTiles } from '@/components/StatTiles'
import { findAssignment } from '@/lib/data/assignments'
import { listAssignmentAcceptances } from '@/lib/data/invitations'
import { findClassroom } from '@/lib/data/organizations'
import { findRepositoryById, listRepositorySnapshots } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'
import { baseUrl } from '@/lib/url'

import { AcceptanceList } from './AcceptanceList'

export const dynamic = 'force-dynamic'

/**
 * Port of assignments#show: the invitation link, the counters, and below them
 * one row per student with their repository.
 *
 * The original keyed that list off `assignment_repos`; here it comes from
 * `invite_statuses`, which is where an acceptance lands before any repository
 * exists. See lib/data/invitations.ts.
 *
 * The frame is the breadcrumb alone, not ClassroomShell: the live
 * classroom.github.com drops the tab bar on this screen, the same as on the
 * new-assignment one — an assignment is a step away from the classroom rather
 * than one of its tabs.
 */
export default async function AssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/[assignmentSlug]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  const [classroom, assignment, acceptances] = await Promise.all([
    findClassroom(session, slug),
    findAssignment(session, slug, assignmentSlug),
    listAssignmentAcceptances(session, slug, assignmentSlug),
  ])

  if (!classroom || !assignment || !acceptances) notFound()

  // flash[:success]: only right after creating or saving, not on every later visit
  const searchParams = await props.searchParams
  const justCreated = searchParams.created === '1'
  const justUpdated = searchParams.updated === '1'

  // InvitationHelper#invitation_url, without the short_key branch
  const invitationUrl = `${await baseUrl()}/assignment-invitations/${assignment.invitationKey}`

  // AssignmentInvitation#enabled?
  const invitationsEnabled = assignment.invitationsEnabled && !classroom.archivedAt

  const repoIds = [...acceptances.entries, ...acceptances.unlinkedAccounts]
    .map((row) => row.repoId)
    .filter((id): id is number => id !== null)

  // DA-2: only the ids are stored, everything shown about a repository is read
  // from GitHub here. Both calls are skipped when the org is unreachable, which
  // is the same NullGitHubRepository case the rows already render.
  const [starterCode, snapshots] = classroom.organization
    ? await Promise.all([
        assignment.starterCodeRepoId === null
          ? null
          : findRepositoryById(classroom.organization.installationId, assignment.starterCodeRepoId),
        listRepositorySnapshots(
          classroom.organization.installationId,
          classroom.organization.login,
          repoIds,
          // A repo generated from a template is born with one commit; one
          // created empty, with none
          assignment.starterCodeRepoId === null ? 0 : 1,
        ),
      ])
    : [null, new Map()]

  const submitted = repoIds.filter((id) => (snapshots.get(id)?.commitCount ?? 0) > 0).length
  const students = acceptances.entries.length + acceptances.unlinkedAccounts.length

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
          {
            label: assignment.title,
            href: `/classrooms/${classroom.slug}/assignments/${assignment.slug}`,
          },
        ]}
      />

      <div className="container-xl p-responsive">
        {justCreated && (
          <div className="flash flash-success mt-4">
            Assignment creado. Compartí el link de invitación con los alumnos.
          </div>
        )}

        {/* flash[:success] = "Assignment \"...\" is being updated" */}
        {justUpdated && <div className="flash flash-success mt-4">Assignment actualizado.</div>}

        <AssignmentHeader
          title={assignment.title}
          group={false}
          active={assignment.invitationsEnabled}
          starterCodeRepoId={assignment.starterCodeRepoId}
          starterCode={starterCode}
          editHref={`/classrooms/${classroom.slug}/assignments/${assignment.slug}/edit`}
          invitationUrl={invitationUrl}
          invitationsEnabled={invitationsEnabled}
          disabledReason={
            invitationsEnabled
              ? null
              : // The two reasons of
                // AssignmentInvitation#reason_for_disabled_invitations
                classroom.archivedAt
                ? 'El link está deshabilitado porque el classroom está archivado.'
                : 'El link está deshabilitado: este assignment no acepta invitaciones.'
          }
        />

        <h2 className="mb-2">Detalle del assignment</h2>

        <StatTiles
          tiles={[
            {
              label: 'Alumnos',
              total: students,
              parts: [
                { value: acceptances.entries.length, label: 'en el roster' },
                { value: acceptances.unlinkedAccounts.length, label: 'sin vincular' },
              ],
            },
            {
              label: 'Aceptaron',
              total: acceptances.acceptedCount,
              parts: [{ value: acceptances.acceptedCount, label: 'alumnos' }],
            },
            {
              label: 'Entregas',
              total: repoIds.length,
              parts: [
                { value: submitted, label: 'con commits' },
                { value: repoIds.length - submitted, label: 'sin commits' },
              ],
              progress: repoIds.length === 0 ? undefined : submitted / repoIds.length,
            },
          ]}
        />

        <AcceptanceList
          acceptances={acceptances}
          assignmentTitle={assignment.title}
          snapshots={snapshots}
        />
      </div>
    </>
  )
}
