import {
  FileCodeIcon,
  LockIcon,
  OrganizationIcon,
  PeopleIcon,
  RepoIcon,
  ShieldLockIcon,
} from '@primer/octicons-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { ClassroomShell } from '@/components/ClassroomShell'
import { InvitationLink } from '@/components/InvitationLink'
import { findGroupAssignment } from '@/lib/data/group-assignments'
import { listGroupAssignmentAcceptances } from '@/lib/data/groups'
import { findClassroom } from '@/lib/data/organizations'
import { findRepositoryById } from '@/lib/github/repositories'
import { isUsableSession } from '@/lib/session'
import { baseUrl } from '@/lib/url'

export const dynamic = 'force-dynamic'

/** The label of each team's state, from SetupStatus */
const STATUS_LABEL: Record<string, string> = {
  unaccepted: 'Sin aceptar',
  accepted: 'Aceptado, sin repo',
  waiting: 'En espera',
  creating_repo: 'Creando el repo',
  importing_starter_code: 'Copiando starter code',
  completed: 'Con repo',
  errored_creating_repo: 'Falló la creación del repo',
  errored_importing_starter_code: 'Falló la copia del starter code',
}

/** Port of group_assignments#show */
export default async function GroupAssignmentPage(
  props: PageProps<'/classrooms/[slug]/group-assignments/[assignmentSlug]'>,
) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug, assignmentSlug } = await props.params

  const [classroom, assignment, acceptances] = await Promise.all([
    findClassroom(session, slug),
    findGroupAssignment(session, slug, assignmentSlug),
    listGroupAssignmentAcceptances(session, slug, assignmentSlug),
  ])

  if (!classroom || !assignment || !acceptances) notFound()

  const justCreated = (await props.searchParams).created === '1'

  const invitationUrl = `${await baseUrl()}/group-assignment-invitations/${assignment.invitationKey}`
  const invitationsEnabled = assignment.invitationsEnabled && !classroom.archivedAt

  const starterCode =
    assignment.starterCodeRepoId !== null && classroom.organization
      ? await findRepositoryById(
          classroom.organization.installationId,
          assignment.starterCodeRepoId,
        )
      : null

  const accepted = acceptances.teams.filter((team) => team.status !== 'unaccepted').length

  return (
    <ClassroomShell session={session} classroom={classroom} tab="assignments">
      {justCreated && (
        <div className="flash flash-success mb-4">
          Assignment grupal creado. Compartí el link de invitación con los alumnos: el primero de
          cada equipo lo crea y el resto se suma.
        </div>
      )}

      <div className="d-flex flex-items-center mb-2">
        <OrganizationIcon size={22} className="mr-2 color-fg-muted" />
        <h2 className="f2 text-normal flex-auto">{assignment.title}</h2>
      </div>

      <p className="color-fg-muted">
        Assignment grupal · los repos se van a llamar <code>{assignment.slug}-equipo</code> ·
        equipos de{' '}
        <Link href={`/classrooms/${classroom.slug}/groupings/${assignment.grouping.slug}`}>
          {assignment.grouping.title}
        </Link>
      </p>

      <div className="Box my-4">
        <div className="Box-row">
          <h3 className="h5 mb-2">Link de invitación</h3>
          <InvitationLink url={invitationUrl} disabled={!invitationsEnabled} />
          <p className="note mt-2 mb-0">
            {invitationsEnabled ? (
              <>Compartilo con los alumnos para que armen su equipo y acepten el assignment.</>
            ) : (
              <span className="color-fg-attention">
                {classroom.archivedAt
                  ? 'El link está deshabilitado porque el classroom está archivado.'
                  : 'El link está deshabilitado: este assignment no acepta invitaciones.'}
              </span>
            )}
          </p>
        </div>

        <div className="Box-row d-flex flex-items-center">
          <PeopleIcon className="mr-2 color-fg-muted" />
          <span>
            {assignment.maxMembers === null
              ? 'Sin máximo de integrantes por equipo'
              : `Hasta ${assignment.maxMembers} integrantes por equipo`}
            {' · '}
            {assignment.maxTeams === null
              ? 'sin máximo de equipos'
              : `hasta ${assignment.maxTeams} equipos`}
          </span>
        </div>

        <div className="Box-row d-flex flex-items-center">
          <FileCodeIcon className="mr-2 color-fg-muted" />
          <span>
            {assignment.starterCodeRepoId === null ? (
              <>Sin starter code, cada equipo arranca de un repo vacío</>
            ) : starterCode ? (
              <>
                Starter code:{' '}
                <a href={starterCode.htmlUrl} className="text-mono">
                  {starterCode.fullName}
                </a>
              </>
            ) : (
              <span className="color-fg-attention">
                Starter code inaccesible: el repo se borró o la App perdió acceso
              </span>
            )}
          </span>
        </div>

        <div className="Box-row d-flex flex-items-center">
          {assignment.publicRepo ? (
            <RepoIcon className="mr-2 color-fg-muted" />
          ) : (
            <LockIcon className="mr-2 color-fg-attention" />
          )}
          <span>
            Repositorios <strong>{assignment.publicRepo ? 'públicos' : 'privados'}</strong>
          </span>
        </div>

        <div className="Box-row d-flex flex-items-center">
          <ShieldLockIcon className="mr-2 color-fg-muted" />
          <span>
            Los alumnos <strong>{assignment.studentsAreRepoAdmins ? 'son' : 'no son'}</strong> admin
            del repo de su equipo
          </span>
        </div>
      </div>

      <div className="d-flex flex-items-center flex-justify-between mb-2">
        <h3 className="f4">
          Equipos <span className="Counter">{acceptances.teams.length}</span>
        </h3>
        <span className="f6 color-fg-muted">{accepted} aceptaron</span>
      </div>

      {acceptances.teams.length === 0 ? (
        <div className="blankslate blankslate-spacious">
          <h3 className="mb-2">Todavía no hay equipos</h3>
          <p className="color-fg-muted mb-0">
            Los equipos aparecen acá a medida que los alumnos los arman desde el link.
          </p>
        </div>
      ) : (
        <div className="Box">
          {acceptances.teams.map((team) => (
            <div
              className="Box-row d-md-flex flex-items-center flex-justify-between"
              key={team.id}
            >
              <div className="col-md-6">
                <strong>{team.title}</strong>
                <span className="d-block f6 color-fg-muted">
                  {team.members.length === 0
                    ? 'Sin integrantes'
                    : team.members.map((member) => `@${member.githubLogin}`).join(', ')}
                </span>
              </div>

              <div className="col-md-3 f6 color-fg-muted text-mono">
                {team.status === 'completed' ? `${assignment.slug}-${team.slug}` : ''}
              </div>

              <div className="col-md-3 text-md-right">
                <span
                  className={`Label ${
                    team.status === 'completed'
                      ? 'Label--success'
                      : team.status.startsWith('errored')
                        ? 'Label--danger'
                        : ''
                  }`}
                >
                  {STATUS_LABEL[team.status] ?? team.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* `@students_not_on_team` of the original's #show */}
      {acceptances.identifierName !== null && (
        <>
          <h3 className="f4 mt-5 mb-2">
            Sin equipo{' '}
            <span className="Counter">{acceptances.studentsNotOnTeam.length}</span>
          </h3>

          {acceptances.studentsNotOnTeam.length === 0 ? (
            <p className="color-fg-muted">
              Todos los {acceptances.identifierName.toLowerCase()}es del roster están en un equipo.
            </p>
          ) : (
            <div className="Box">
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
        </>
      )}
    </ClassroomShell>
  )
}
