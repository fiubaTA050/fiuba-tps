import 'server-only'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Session } from 'next-auth'
import * as z from 'zod/v4'

import { findAssignment, listAssignments, setAssignmentActive } from '@/lib/data/assignments'
import { listCheckpoints, type Checkpoint } from '@/lib/data/checkpoints'
import { findGroupAssignment, listGroupAssignments } from '@/lib/data/group-assignments'
import { findGroupingForTeacher, listGroupAssignmentAcceptances } from '@/lib/data/groups'
import { listAssignmentAcceptances } from '@/lib/data/invitations'
import { findClassroomInstallation, listTeachingClassrooms } from '@/lib/data/organizations'
import { findRoster, listUnlinkedAccounts } from '@/lib/data/rosters'
import {
  findSubmissionDetail,
  findSubmissionHistory,
  listAssignmentSubmissions,
  type CheckpointSubmissions,
} from '@/lib/data/submissions'
import { listRepositorySnapshots, type RepositorySnapshot } from '@/lib/github/repositories'
import { invitationUrl } from '@/lib/url'

/**
 * The MCP server a teacher reaches from Claude Code (app/api/mcp/route.ts).
 *
 * Every tool is a thin wrapper over lib/data/ with the API key's owner as the
 * session, so it can read and change exactly what that teacher can on the
 * web. Tools are named by intent rather than by form: `set_assignment_active`
 * flips one column instead of resubmitting the edit screen.
 *
 * Built per request: the endpoint is stateless, and the set of tools depends
 * on the key's scopes — a read-only key never sees a write tool listed.
 */

export const READ_SCOPE = 'classroom:read'
export const WRITE_SCOPE = 'classroom:write'

/** Where a grading run's output is cut: a full test log is tens of KB, and
 *  Claude Code warns past ~25k tokens for one tool result */
const OUTPUT_TAIL_CHARS = 4_000

const kindSchema = z
  .enum(['individual', 'group'])
  .default('individual')
  .describe('individual o group, como lo devuelve list_assignments')

const classroomSchema = z.string().describe('Slug del classroom, de list_classrooms')
const assignmentSchema = z.string().describe('Slug del trabajo práctico, de list_assignments')

/** Unindented: indentation alone is a third of a cohort's dashboard */
function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function error(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function tail(text: string | null): string | null {
  if (text === null || text.length <= OUTPUT_TAIL_CHARS) return text
  return `[… recortado, se muestran los últimos ${OUTPUT_TAIL_CHARS} caracteres]\n${text.slice(-OUTPUT_TAIL_CHARS)}`
}

function entrega(checkpoint: Checkpoint) {
  return {
    id: checkpoint.id,
    title: checkpoint.title,
    deadlineAt: checkpoint.deadlineAt,
    closed: checkpoint.closedAt !== null,
    autograded: checkpoint.autograderId !== null,
    resultsPublished: checkpoint.resultsPublishedAt !== null,
    submissionCount: checkpoint.submissionCount,
  }
}

function repository(snapshot: RepositorySnapshot | undefined) {
  if (!snapshot) return null
  return {
    id: snapshot.id,
    fullName: snapshot.fullName,
    url: snapshot.htmlUrl,
    commitCount: snapshot.commitCount,
    latestCommitAt: snapshot.latestCommitAt,
  }
}

/**
 * One repository's standing on the entregas where there is something to say —
 * a submission or an exemption — in the dashboard's tab order. An entrega
 * left out was not handed in: listing every empty one for every student is
 * most of the payload on a cohort of a few hundred.
 */
function entregasOf(repoId: number | null, checkpoints: CheckpointSubmissions[]) {
  if (repoId === null) return []

  return checkpoints.flatMap((checkpoint) => {
    const current = checkpoint.byRepoId.get(repoId)
    const exempt = checkpoint.exemptRepoIds.has(repoId)
    if (!current && !exempt) return []

    return [
      {
        entregaId: checkpoint.id,
        entrega: checkpoint.title,
        exempt,
        submission: current
          ? {
              id: current.id,
              sha: current.sha,
              submittedAt: current.submittedAt,
              late: current.late,
              lateJustified: current.justification !== null,
              passed: current.passed,
              hasFeedback: current.hasFeedback,
            }
          : null,
      },
    ]
  })
}

export function createMcpServer(session: Session, scopes: string[], origin: string): McpServer {
  const server = new McpServer(
    { name: 'fiuba-classroom', version: '1.0.0' },
    {
      instructions:
        'Administración de FIUBA Classroom (port de GitHub Classroom) para un docente. ' +
        'Empezá por list_classrooms y list_assignments para resolver slugs; "assignment" es un ' +
        'trabajo práctico y una "entrega" es un checkpoint con su deadline. Una deadline no cierra ' +
        'nada: lo que cierra las entregas de un TP es pasarlo a Inactivo (set_assignment_active).',
    },
  )

  server.registerTool(
    'list_classrooms',
    {
      title: 'Listar classrooms',
      description: 'Los classrooms de los que sos docente, del más nuevo al más viejo.',
      annotations: { readOnlyHint: true },
    },
    async () => json(await listTeachingClassrooms(session)),
  )

  server.registerTool(
    'list_assignments',
    {
      title: 'Listar trabajos prácticos',
      description:
        'Los trabajos prácticos individuales y grupales de un classroom, con si están activos, ' +
        'su link de invitación y sus entregas (deadline, cerrada, resultados publicados, cantidad de envíos).',
      inputSchema: { classroom: classroomSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ classroom }) => {
      if (!(await findClassroomInstallation(session, classroom))) {
        return error('No encontramos ese classroom.')
      }

      const [individual, group] = await Promise.all([
        listAssignments(session, classroom),
        listGroupAssignments(session, classroom),
      ])

      // One query per assignment: a classroom has a handful, and it is all
      // database
      const withEntregas = async (kind: 'individual' | 'group', slug: string) =>
        ((await listCheckpoints(session, classroom, slug, kind)) ?? []).map(entrega)

      return json([
        ...(await Promise.all(
          individual.map(async (assignment) => ({
            kind: 'individual' as const,
            title: assignment.title,
            slug: assignment.slug,
            active: assignment.invitationsEnabled,
            publicRepo: assignment.publicRepo,
            invitationUrl: invitationUrl(origin, 'assignment', assignment),
            entregas: await withEntregas('individual', assignment.slug),
          })),
        )),
        ...(await Promise.all(
          group.map(async (assignment) => ({
            kind: 'group' as const,
            title: assignment.title,
            slug: assignment.slug,
            active: assignment.invitationsEnabled,
            publicRepo: assignment.publicRepo,
            invitationUrl: invitationUrl(origin, 'group-assignment', assignment),
            grouping: assignment.grouping.slug,
            maxMembers: assignment.maxMembers,
            entregas: await withEntregas('group', assignment.slug),
          })),
        )),
      ])
    },
  )

  server.registerTool(
    'get_dashboard',
    {
      title: 'Dashboard de un trabajo práctico',
      description:
        'Una fila por alumno (individual) o por equipo (grupal): su repositorio con la cantidad de ' +
        'commits propios, y las entregas donde hay algo — el envío vigente (SHA, si fue tarde, si ' +
        'está justificado, si pasó la corrección automática, si tiene devolución) o una eximición. ' +
        'Una entrega que no aparece en la fila no fue entregada.',
      inputSchema: { classroom: classroomSchema, assignment: assignmentSchema, kind: kindSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ classroom: classroomSlug, assignment: assignmentSlug, kind }) => {
      const [classroom, assignment, submissions] = await Promise.all([
        findClassroomInstallation(session, classroomSlug),
        kind === 'group'
          ? findGroupAssignment(session, classroomSlug, assignmentSlug)
          : findAssignment(session, classroomSlug, assignmentSlug),
        listAssignmentSubmissions(session, classroomSlug, assignmentSlug, kind),
      ])

      if (!classroom || !assignment || !submissions) {
        return error('No encontramos ese trabajo práctico en ese classroom.')
      }

      // A template is squashed into one commit — see listRepositorySnapshots
      const baseline = assignment.starterCodeRepoId === null ? 0 : 1
      const entregas = submissions.checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        title: checkpoint.title,
        deadlineAt: checkpoint.deadlineAt,
        closed: checkpoint.closed,
        autograded: checkpoint.autograded,
      }))

      // The stored installation, without `currentInstallationId`: healing a
      // stale one goes through the teacher's OAuth token, which a key lacks.
      // A dead installation leaves every repository null, which the web
      // heals on the next visit.
      if (kind === 'group') {
        const acceptances = await listGroupAssignmentAcceptances(
          session,
          classroomSlug,
          assignmentSlug,
        )
        if (!acceptances) return error('No encontramos ese trabajo práctico en ese classroom.')

        const snapshots = await listRepositorySnapshots(
          classroom.installationId,
          acceptances.teams.flatMap((team) => (team.repoId === null ? [] : [team.repoId])),
          baseline,
        )

        return json({
          assignment: { title: assignment.title, slug: assignment.slug, active: assignment.invitationsEnabled },
          entregas,
          teams: acceptances.teams.map((team) => ({
            title: team.title,
            status: team.status,
            members: team.members.map((member) => ({
              githubLogin: member.githubLogin,
              identifier: acceptances.identifiers.get(member.userId) ?? null,
            })),
            repoId: team.repoId,
            repository: repository(team.repoId === null ? undefined : snapshots.get(team.repoId)),
            entregas: entregasOf(team.repoId, submissions.checkpoints),
          })),
          studentsNotOnTeam: acceptances.studentsNotOnTeam,
        })
      }

      const acceptances = await listAssignmentAcceptances(session, classroomSlug, assignmentSlug)
      if (!acceptances) return error('No encontramos ese trabajo práctico en ese classroom.')

      const rows = [
        ...acceptances.entries.map((entry) => ({
          identifier: entry.identifier as string | null,
          githubLogin: entry.githubLogin,
          state: entry.state as string,
          repoId: entry.repoId,
        })),
        ...acceptances.unlinkedAccounts.map((account) => ({
          identifier: null,
          githubLogin: account.githubLogin,
          state: 'accepted_unlinked',
          repoId: account.repoId,
        })),
      ]

      const snapshots = await listRepositorySnapshots(
        classroom.installationId,
        rows.flatMap((row) => (row.repoId === null ? [] : [row.repoId])),
        baseline,
      )

      return json({
        assignment: { title: assignment.title, slug: assignment.slug, active: assignment.invitationsEnabled },
        identifierName: acceptances.identifierName,
        entregas,
        students: rows.map((row) => ({
          ...row,
          repository: repository(row.repoId === null ? undefined : snapshots.get(row.repoId)),
          entregas: entregasOf(row.repoId, submissions.checkpoints),
        })),
      })
    },
  )

  server.registerTool(
    'get_submission_history',
    {
      title: 'Historial de envíos',
      description:
        'Todas las confirmaciones de un repositorio en una entrega, de la más nueva a la más vieja.',
      inputSchema: {
        classroom: classroomSchema,
        assignment: assignmentSchema,
        kind: kindSchema,
        repoId: z.number().int().describe('repoId del alumno o equipo, de get_dashboard'),
        entregaId: z.number().int().describe('id de la entrega, de list_assignments o get_dashboard'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ classroom, assignment, kind, repoId, entregaId }) => {
      const history = await findSubmissionHistory(session, classroom, assignment, repoId, entregaId, kind)
      return history ? json(history) : error('No encontramos ese repositorio o esa entrega.')
    },
  )

  server.registerTool(
    'get_submission',
    {
      title: 'Detalle de un envío',
      description:
        'Un envío con su declaración de uso de IA, cada corrida de la corrección automática ' +
        '(salida recortada al final), las justificaciones de entrega tardía y las versiones de la devolución.',
      inputSchema: {
        classroom: classroomSchema,
        assignment: assignmentSchema,
        kind: kindSchema,
        repoId: z.number().int().describe('repoId del alumno o equipo, de get_dashboard'),
        submissionId: z.number().int().describe('id del envío, de get_dashboard o get_submission_history'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ classroom, assignment, kind, repoId, submissionId }) => {
      const detail = await findSubmissionDetail(session, classroom, assignment, repoId, submissionId, kind)
      if (!detail) return error('No encontramos ese envío.')

      return json({
        ...detail,
        gradingRuns: detail.gradingRuns.map((run) => ({ ...run, output: tail(run.output) })),
      })
    },
  )

  server.registerTool(
    'get_roster',
    {
      title: 'Lista de alumnos',
      description:
        'La lista de alumnos del classroom (padrón y cuenta de GitHub vinculada) y las cuentas ' +
        'que aceptaron algún trabajo práctico sin vincularse a un padrón.',
      inputSchema: { classroom: classroomSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ classroom }) => {
      const [roster, unlinkedAccounts] = await Promise.all([
        findRoster(session, classroom),
        listUnlinkedAccounts(session, classroom),
      ])
      if (!roster) return error('Ese classroom no tiene lista de alumnos, o no es tuyo.')

      return json({
        identifierName: roster.identifierName,
        entries: roster.entries.map(({ identifier, githubLogin }) => ({ identifier, githubLogin })),
        unlinkedAccounts: unlinkedAccounts.map(({ githubLogin }) => githubLogin),
      })
    },
  )

  server.registerTool(
    'list_teams',
    {
      title: 'Equipos',
      description: 'Los equipos de un conjunto de equipos y sus miembros.',
      inputSchema: {
        classroom: classroomSchema,
        grouping: z.string().describe('Slug del conjunto de equipos: el campo grouping de list_assignments'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ classroom, grouping }) => {
      const found = await findGroupingForTeacher(session, classroom, grouping)
      if (!found) return error('No encontramos ese conjunto de equipos.')

      return json({
        title: found.title,
        teams: found.teams.map((team) => ({
          title: team.title,
          members: team.members.map((member) => member.githubLogin),
        })),
      })
    },
  )

  if (scopes.includes(WRITE_SCOPE)) {
    server.registerTool(
      'set_assignment_active',
      {
        title: 'Activar o desactivar un trabajo práctico',
        description:
          'Pasa un trabajo práctico a Activo o Inactivo, como el "Assignment status" de Editar. ' +
          'Inactivo cierra todas sus entregas a la vez y deja de aceptar alumnos nuevos; nada se ' +
          'borra y se puede volver a activar. No toca los repositorios.',
        inputSchema: {
          classroom: classroomSchema,
          assignment: assignmentSchema,
          kind: kindSchema,
          active: z.boolean().describe('true para Activo, false para Inactivo'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ classroom, assignment, kind, active }) => {
        const result = await setAssignmentActive(session, classroom, assignment, kind, active)
        if (!result.success) return error(result.error)
        return json({ assignment, kind, active })
      },
    )
  }

  return server
}
