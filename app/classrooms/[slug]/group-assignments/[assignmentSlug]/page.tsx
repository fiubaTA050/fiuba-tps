import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { AssignmentHeader } from '@/components/AssignmentHeader'
import { AssignmentRepoList } from '@/components/AssignmentRepoList'
import { Breadcrumb } from '@/components/Breadcrumb'
import { StatTiles } from '@/components/StatTiles'
import { submissionLabel, type RepoRow, type SubmissionLabel } from '@/lib/assignment-rows'
import { findGroupAssignment } from '@/lib/data/group-assignments'
import { listGroupAssignmentAcceptances, type TeamAcceptance } from '@/lib/data/groups'
import { findClassroom } from '@/lib/data/organizations'
import { rosterSummary } from '@/lib/data/rosters'
import { findRepositoryById, listRepositorySnapshots } from '@/lib/github/repositories'
import type { RepositorySnapshot } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'
import { baseUrl } from '@/lib/url'

export const dynamic = 'force-dynamic'

/**
 * Port of group_assignments#show, on the live site's dashboard layout: the
 * same header and counters as the individual one, with a row per team instead
 * of per student.
 *
 * The live site's per-team deadline extension is not here — deadlines are not
 * ported (db/schema.ts).
 */
export default async function GroupAssignmentPage(
  props: PageProps<'/classrooms/[slug]/group-assignments/[assignmentSlug]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  // The roster's size is the first tile's "alumnos en el roster"; it is an
  // indexed count, and `findClassroom` is memoised per request
  const [classroom, assignment, acceptances, roster] = await Promise.all([
    findClassroom(session, slug),
    findGroupAssignment(session, slug, assignmentSlug),
    listGroupAssignmentAcceptances(session, slug, assignmentSlug),
    rosterSummary(session, slug),
  ])

  if (!classroom || !assignment || !acceptances) notFound()

  const searchParams = await props.searchParams
  const justCreated = searchParams.created === '1'
  const justUpdated = searchParams.updated === '1'

  const invitationUrl = `${await baseUrl()}/group-assignment-invitations/${assignment.invitationKey}`
  const invitationsEnabled = assignment.invitationsEnabled && !classroom.archivedAt

  const repoIds = acceptances.teams
    .map((team) => team.repoId)
    .filter((id): id is number => id !== null)

  const [starterCode, snapshots] = classroom.organization
    ? await Promise.all([
        assignment.starterCodeRepoId === null
          ? null
          : findRepositoryById(classroom.organization.installationId, assignment.starterCodeRepoId),
        listRepositorySnapshots(
          classroom.organization.installationId,
          classroom.organization.login,
          repoIds,
          assignment.starterCodeRepoId === null ? 0 : 1,
        ),
      ])
    : [null, new Map()]

  const accepted = acceptances.teams.filter((team) => team.status !== 'unaccepted').length
  const submitted = repoIds.filter((id) => (snapshots.get(id)?.commitCount ?? 0) > 0).length

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
          {
            label: assignment.title,
            href: `/classrooms/${classroom.slug}/group-assignments/${assignment.slug}`,
          },
        ]}
      />

      <div className="container-xl p-responsive">
        {justCreated && (
          <div className="flash flash-success mt-4">
            Assignment grupal creado. Compartí el link de invitación con los alumnos: el primero de
            cada equipo lo crea y el resto se suma.
          </div>
        )}

        {justUpdated && <div className="flash flash-success mt-4">Assignment actualizado.</div>}

        <AssignmentHeader
          title={assignment.title}
          group
          active={assignment.invitationsEnabled}
          starterCodeRepoId={assignment.starterCodeRepoId}
          starterCode={starterCode}
          editHref={`/classrooms/${classroom.slug}/group-assignments/${assignment.slug}/edit`}
          invitationUrl={invitationUrl}
          invitationsEnabled={invitationsEnabled}
          disabledReason={
            invitationsEnabled
              ? null
              : classroom.archivedAt
                ? 'El link está deshabilitado porque el classroom está archivado.'
                : 'El link está deshabilitado: este assignment no acepta invitaciones.'
          }
        />

        <p className="color-fg-muted mb-4">
          Equipos de{' '}
          <Link href={`/classrooms/${classroom.slug}/groupings/${assignment.grouping.slug}`}>
            {assignment.grouping.title}
          </Link>
          {' · '}
          {assignment.maxMembers === null
            ? 'sin máximo de integrantes'
            : `hasta ${assignment.maxMembers} integrantes`}
          {' · '}
          {assignment.maxTeams === null ? 'sin máximo de equipos' : `hasta ${assignment.maxTeams} equipos`}
        </p>

        <h2 className="mb-2">Detalle del assignment</h2>

        {/* The group counterpart of the live tiles: the docs describe it as
            "total teams, rostered students, students not on a team, accepted
            teams, submitted teams", so the first tile counts teams and breaks
            down students, exactly as the live one does. */}
        <StatTiles
          tiles={[
            {
              label: 'Equipos',
              total: acceptances.teams.length,
              parts: [
                { value: roster?.count ?? 0, label: 'alumnos en el roster' },
                { value: acceptances.studentsNotOnTeam.length, label: 'sin equipo' },
              ],
            },
            {
              label: 'Equipos que aceptaron',
              total: accepted,
              parts: [{ value: accepted, label: 'equipos' }],
            },
            {
              label: 'Entregas',
              total: accepted,
              parts: [
                { value: submitted, label: 'entregaron' },
                { value: accepted - submitted, label: 'sin entregar' },
              ],
            },
          ]}
        />

        {acceptances.teams.length === 0 ? (
          <div className="blankslate blankslate-spacious">
            <h3 className="mb-2">Todavía no hay equipos</h3>
            <p className="color-fg-muted mb-0">
              Los equipos aparecen acá a medida que los alumnos los arman desde el link.
            </p>
          </div>
        ) : (
          <AssignmentRepoList
            title="Equipos"
            rows={acceptances.teams.map((team): RepoRow => {
              const snapshot = team.repoId === null ? null : (snapshots.get(team.repoId) ?? null)

              return {
                key: `team-${team.id}`,
                name: team.title,
                // A team is searched by its name; its members carry the handles
                githubLogin: null,
                visual: 'none',
                members: team.members,
                label: teamLabel(team, snapshot),
                snapshot,
                accepted: team.status !== 'unaccepted',
                unlinkedIdentifier: false,
                unlinkedAccount: false,
              }
            })}
          />
        )}

        {/* `@students_not_on_team` of the original's #show. A plain Box, not
            the filterable list: these rows have no repository to filter by */}
        {acceptances.identifierName !== null && acceptances.studentsNotOnTeam.length > 0 && (
          <div className="Box mt-4">
            <div className="Box-header">
              <h3 className="Box-title">Sin equipo</h3>
            </div>

            {acceptances.studentsNotOnTeam.map((student) => (
              <div className="Box-row d-flex flex-justify-between" key={student.identifier}>
                <span className="text-mono">{student.identifier}</span>
                <span className="color-fg-muted">
                  {student.githubLogin ? `@${student.githubLogin}` : 'Sin cuenta vinculada'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/**
 * A team's label. Unlike a student, a team carries the setup statuses of
 * SetupStatus — its repository is built by whichever member arrives first, and
 * a failure there is what the teacher has to see (docs/creacion-de-repos.md).
 */
function teamLabel(team: TeamAcceptance, snapshot: RepositorySnapshot | null): SubmissionLabel {
  if (team.status === 'unaccepted') return { text: 'Sin aceptar', tone: 'neutral' }

  if (team.status.startsWith('errored')) {
    return {
      text:
        team.status === 'errored_creating_repo'
          ? 'Falló la creación del repo'
          : 'Falló la copia del starter code',
      tone: 'danger',
    }
  }

  if (team.repoId === null) {
    // accepted, waiting, creating_repo, importing_starter_code
    return { text: 'Creando el repo', tone: 'attention' }
  }

  return submissionLabel(true, snapshot)
}
