import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { after } from 'next/server'

import { auth } from '@/auth'
import { AssignmentHeader } from '@/components/AssignmentHeader'
import { AssignmentRepoList } from '@/components/AssignmentRepoList'
import { Breadcrumb } from '@/components/Breadcrumb'
import { StatTiles } from '@/components/StatTiles'
import { submissionLabel, type RepoRow, type SubmissionLabel } from '@/lib/assignment-rows'
import { syncAssistantRepoAccess } from '@/lib/data/assistant-repo-access'
import { findGroupAssignment } from '@/lib/data/group-assignments'
import { listGroupAssignmentAcceptances, type TeamAcceptance } from '@/lib/data/groups'
import { currentInstallationId, findClassroomInstallation } from '@/lib/data/organizations'
import { rosterSummary } from '@/lib/data/rosters'
import { listAssignmentSubmissions } from '@/lib/data/submissions'
import { listAllocations } from '@/lib/data/teaching-assistants'
import { findRepositoryById, listRepositorySnapshots } from '@/lib/github/repositories'
import type { RepositorySnapshot } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'
import { baseUrl, invitationUrl } from '@/lib/url'

export const dynamic = 'force-dynamic'

/**
 * Port of group_assignments#show, on the live site's dashboard layout: the
 * same header and counters as the individual one, with a row per team instead
 * of per student.
 *
 * The entregas read exactly as on the individual dashboard — one tab per
 * entrega, "Entregado" meaning a confirmed SHA, the ⋯ with the extension
 * (the live site's per-team "Extend deadline"), the justification and the
 * devolución — over the team's repository. Any member confirms for the team.
 *
 * Until the teacher opens the first entrega, though, the dashboard keeps the
 * commit-based "Entregado" it had before group entregas existed. Group
 * assignments were already running then, and flipping every team with
 * commits to "Sin confirmar" — something nobody can do yet — would read as
 * the whole cohort having stopped handing in.
 */
export default async function GroupAssignmentPage(
  props: PageProps<'/classrooms/[slug]/group-assignments/[assignmentSlug]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  // The roster's size is the first tile's "alumnos en el roster"; it is an
  // indexed count
  // A teaching assistant reads this dashboard too, narrowed to the teams
  // allocated to them: `allowAssistant` is the opt-in of every reader they may
  // reach (docs/teaching-assistants.md). The roster and the allocations stay
  // teacher-only and come back null for them.
  const access = { allowAssistant: true }
  const [classroom, assignment, acceptances, roster, submissions, allocations] = await Promise.all([
    findClassroomInstallation(session, slug, access),
    findGroupAssignment(session, slug, assignmentSlug, access),
    listGroupAssignmentAcceptances(session, slug, assignmentSlug, access),
    rosterSummary(session, slug),
    listAssignmentSubmissions(session, slug, assignmentSlug, 'group', access),
    // Who corrects each team: the menus on every row
    listAllocations(session, slug, assignmentSlug, 'group'),
  ])

  if (!classroom || !assignment || !acceptances || !submissions) notFound()

  const teacher = classroom.role === 'teacher'

  // A TA reads their teams' repositories on GitHub as a collaborator, and the
  // invitation is accepted with their token — so it is granted here, when they
  // come, after the page is sent (docs/teaching-assistants.md)
  if (!teacher) {
    after(() =>
      syncAssistantRepoAccess(session, slug, assignmentSlug).catch((error) =>
        console.error('syncAssistantRepoAccess failed', error),
      ),
    )
  }

  const searchParams = await props.searchParams
  const justCreated = searchParams.created === '1'
  const justUpdated = searchParams.updated === '1'

  const inviteUrl = invitationUrl(await baseUrl(), 'group-assignment', assignment)
  const invitationsEnabled = assignment.invitationsEnabled && !classroom.archivedAt

  const repoIds = acceptances.teams
    .map((team) => team.repoId)
    .filter((id): id is number => id !== null)

  // DA-2: only the ids are stored, everything shown about a repository is read
  // from GitHub here.
  const readGitHub = (installationId: number) =>
    Promise.all([
      assignment.starterCodeRepoId === null
        ? null
        : findRepositoryById(installationId, assignment.starterCodeRepoId),
      listRepositorySnapshots(
        installationId,
        repoIds,
        assignment.starterCodeRepoId === null ? 0 : 1,
      ),
    ])

  // The reads go out against the stored installation at the same time as the
  // check that it is still the right one, instead of queueing behind it: they
  // need the installation and nothing else about the organization.
  const [installationId, reads] = await Promise.all([
    currentInstallationId(session, classroom),
    readGitHub(classroom.installationId),
  ])

  // A reinstall issues a new installation id, so those reads went out against a
  // dead one. Rare — and `currentInstallationId` has already written the new id
  // back, so the next visit takes the fast path.
  const [starterCode, snapshots] =
    installationId !== null && installationId !== classroom.installationId
      ? await readGitHub(installationId)
      : reads

  const accepted = acceptances.teams.filter((team) => team.status !== 'unaccepted').length

  // See the jsdoc: with no entrega opened, "submitted" is still commits
  const tracksEntregas = submissions.checkpoints.length > 0

  // As on the individual dashboard: a team counts once it confirmed any
  // entrega, and passed once it passed every entrega with an autograder
  const confirmedRepoIds = new Set(submissions.checkpoints.flatMap((c) => [...c.byRepoId.keys()]))
  const submitted = repoIds.filter((id) =>
    tracksEntregas ? confirmedRepoIds.has(id) : (snapshots.get(id)?.commitCount ?? 0) > 0,
  ).length
  const autograded = submissions.checkpoints.filter((c) => c.autograded)
  const passed = repoIds.filter((id) =>
    autograded.every((c) => c.byRepoId.get(id)?.passed === true),
  ).length
  const failed = repoIds.filter((id) =>
    autograded.some((c) => c.byRepoId.get(id)?.passed === false),
  ).length

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
            Trabajo práctico grupal creado. Compartí el link de invitación con los alumnos: el primero de
            cada equipo lo crea y el resto se suma.
          </div>
        )}

        {justUpdated && <div className="flash flash-success mt-4">Trabajo práctico actualizado.</div>}

        <AssignmentHeader
          title={assignment.title}
          group
          active={assignment.invitationsEnabled}
          starterCodeRepoId={assignment.starterCodeRepoId}
          starterCode={starterCode}
          editHref={`/classrooms/${classroom.slug}/group-assignments/${assignment.slug}/edit`}
          downloadHref={`/classrooms/${classroom.slug}/group-assignments/${assignment.slug}/csv`}
          teacher={teacher}
          invitationUrl={inviteUrl}
          invitationsEnabled={invitationsEnabled}
          disabledReason={
            invitationsEnabled
              ? null
              : classroom.archivedAt
                ? 'El link está deshabilitado porque el classroom está archivado.'
                : 'El link está deshabilitado: este trabajo práctico no acepta invitaciones.'
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

        <h2 className="mb-2">Detalle del trabajo práctico</h2>

        {/* The group counterpart of the live tiles: the docs describe it as
            "total teams, rostered students, students not on a team, accepted
            teams, submitted teams", so the first tile counts teams and breaks
            down students, exactly as the live one does. */}
        <StatTiles
          tiles={[
            {
              label: 'Equipos',
              total: acceptances.teams.length,
              // A TA reads their own teams, not the roster: who is left
              // without a team is a teacher's question
              parts: teacher
                ? [
                    { value: roster?.count ?? 0, label: 'alumnos en la lista' },
                    { value: acceptances.studentsNotOnTeam.length, label: 'sin equipo' },
                  ]
                : [
                    {
                      value: acceptances.teams.reduce((n, team) => n + team.members.length, 0),
                      label: 'integrantes',
                    },
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
              parts: tracksEntregas
                ? [
                    { value: submitted, label: 'confirmaron' },
                    { value: accepted - submitted, label: 'sin confirmar' },
                  ]
                : [
                    { value: submitted, label: 'entregaron' },
                    { value: accepted - submitted, label: 'sin entregar' },
                  ],
            },
            ...(autograded.length === 0
              ? []
              : [
                  {
                    label: 'Equipos aprobados',
                    progress: { value: passed, failed, of: accepted, label: 'aprobados' },
                  },
                ]),
          ]}
        />

        {acceptances.teams.length === 0 && !teacher ? (
          <div className="blankslate blankslate-spacious">
            <h3 className="mb-2">Todavía no tenés equipos asignados en este trabajo práctico</h3>
            <p className="color-fg-muted mb-0">Los asigna un profesor desde este mismo tablero.</p>
          </div>
        ) : acceptances.teams.length === 0 ? (
          <div className="blankslate blankslate-spacious">
            <h3 className="mb-2">Todavía no hay equipos</h3>
            <p className="color-fg-muted mb-0">
              Los equipos aparecen acá a medida que los alumnos los arman desde el link.
            </p>
          </div>
        ) : (
          <AssignmentRepoList
            title="Equipos"
            teacher={teacher}
            classroomSlug={classroom.slug}
            assignmentSlug={assignment.slug}
            kind="group"
            checkpoints={tracksEntregas ? submissions.checkpoints : undefined}
            allocation={
              allocations && allocations.assistants.length > 0
                ? { assistants: allocations.assistants, editable: classroom.archivedAt === null }
                : undefined
            }
            rows={acceptances.teams.map((team): RepoRow => {
              const snapshot = team.repoId === null ? null : (snapshots.get(team.repoId) ?? null)

              return {
                key: `team-${team.id}`,
                name: team.title,
                // A team is searched by its name; its members carry the handles
                githubLogin: null,
                visual: 'none',
                members: team.members,
                label: teamLabel(team, tracksEntregas ? undefined : snapshot),
                snapshot,
                repoId: team.repoId,
                accepted: team.status !== 'unaccepted',
                unlinkedIdentifier: false,
                unlinkedAccount: false,
                allocationTarget: team.id,
                assistantIds: allocations?.byTarget.get(team.id) ?? [],
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
 * A team's fixed label, before it has a repository. Unlike a student, a team
 * carries the setup statuses of SetupStatus — its repository is built by
 * whichever member arrives first, and a failure there is what the teacher has
 * to see (docs/creacion-de-repos.md). Once the repository is there the label
 * is the open tab's entrega, which `AssignmentRepoList` resolves — or, with
 * no entrega opened yet, the commits in `snapshot`, which only that case
 * passes.
 */
function teamLabel(
  team: TeamAcceptance,
  snapshot?: RepositorySnapshot | null,
): SubmissionLabel | undefined {
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

  return snapshot === undefined ? undefined : submissionLabel(true, snapshot)
}
