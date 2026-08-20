import { parseArgs } from 'node:util'

import { importClassroom, type ResolvedUser } from '@/lib/data/import'
import { appClient, installationClient } from '@/lib/github/client'
import { planExport, readExport, type ClassroomPlan } from '@/lib/import/classroom-export'

/**
 * Imports an export of GitHub Classroom produced by
 * `github-education-resources/classroom-export-utility`.
 *
 *   npm run import:classroom -- <directorio> --teacher <login> [...]
 *
 * What the export cannot answer, this script does, and only this script: it
 * resolves the App installation of each organization, and the GitHub id of
 * every login — the export's `students[].id` is Classroom's own id, not
 * GitHub's (see lib/import/classroom-export.ts). The writing itself is
 * `importClassroom`, in the data layer, in one transaction per classroom.
 *
 * `--dry-run` touches neither GitHub nor the database: it reads the export,
 * plans it and prints what would happen, which is also how you read an export
 * without having any credentials at hand.
 */

const usage = `
Uso: npm run import:classroom -- <directorio> --teacher <login> [opciones]

  --teacher <login>        Docente del classroom. Repetible; el primero queda
                           como creador de los assignments. Obligatorio salvo
                           en --dry-run.
  --classroom <id>         Importar sólo este classroom del export (el id que
                           lleva el directorio). Repetible.
  --installation <id>      installation_id de la App, para no preguntárselo a
                           GitHub. "<org_github_id>=<installation_id>" si el
                           export tiene más de una organización.
  --grouping <título>      Nombre del conjunto de equipos que se crea para los
                           assignments grupales. Por defecto "Equipos".
  --dry-run                No escribe nada ni llama a GitHub.
`.trim()

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      teacher: { type: 'string', multiple: true, default: [] },
      classroom: { type: 'string', multiple: true, default: [] },
      installation: { type: 'string', multiple: true, default: [] },
      grouping: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help || positionals.length !== 1) {
    console.log(usage)
    return values.help ? 0 : 1
  }

  const dryRun = values['dry-run']
  if (values.teacher.length === 0 && !dryRun) {
    console.error('Falta --teacher: sin docentes el classroom no lo ve nadie.\n')
    console.error(usage)
    return 1
  }

  const plans = planExport(readExport(positionals[0])).filter(
    (plan) => values.classroom.length === 0 || values.classroom.includes(String(plan.sourceId)),
  )

  if (plans.length === 0) {
    console.error('El export no tiene ningún classroom que coincida con --classroom.')
    return 1
  }

  const installations = parseInstallations(values.installation)
  let failed = 0

  for (const plan of plans) {
    describe(plan)

    if (plan.errors.length > 0) {
      console.log('  No se importa: arreglá los errores de arriba en el export.\n')
      failed++
      continue
    }

    if (dryRun) {
      const pending = plan.users.filter((user) => user.uid === null).length
      console.log(
        `  --dry-run: no se escribe nada.${pending > 0 ? ` ${pending} logins necesitan una consulta a GitHub.` : ''}\n`,
      )
      continue
    }

    try {
      const installationId = installations.get(plan.githubId) ?? installations.get(0)
      const installation = installationId ?? (await resolveInstallation(plan.login))
      const users = await resolveUsers(plan, values.teacher, installation)

      const result = await importClassroom(plan, {
        installationId: installation,
        users,
        teachers: values.teacher,
        groupingTitle: values.grouping,
      })

      if (!result.success) {
        console.log(`  ✗ ${result.error}\n`)
        failed++
        continue
      }

      const { counts } = result
      console.log(
        `  ✓ /classrooms/${result.slug} — ${counts.users} usuarios, ${counts.rosterEntries} padrones, ` +
          `${counts.assignments + counts.groupAssignments} assignments, ${counts.teams} equipos, ` +
          `${counts.repositories} repos.\n`,
      )
    } catch (error) {
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
      failed++
    }
  }

  return failed === 0 ? 0 : 1
}

/** What the import is about to do, before it does any of it */
function describe(plan: ClassroomPlan): void {
  const count = (total: number, one: string, many: string) =>
    `${total} ${total === 1 ? one : many}`

  console.log(`${plan.title}  (@${plan.login}, classroom ${plan.sourceId} del export)`)
  console.log(`  /classrooms/${plan.slug}${plan.archived ? ' (archivado)' : ''}`)
  console.log(
    `  ${count(plan.users.length, 'alumno', 'alumnos')} · ` +
      `${count(plan.roster.length, 'padrón', 'padrones')} · ` +
      `${count(plan.assignments.length, 'assignment individual', 'assignments individuales')} · ` +
      `${count(plan.groupAssignments.length, 'assignment grupal', 'assignments grupales')} · ` +
      `${count(plan.teams.length, 'equipo', 'equipos')}`,
  )

  for (const warning of plan.warnings) console.log(`  ! ${warning}`)
  for (const error of plan.errors) console.log(`  ✗ ${error}`)
}

/** `--installation 1234` for every org, or `--installation <org_id>=<installation_id>` */
function parseInstallations(values: string[]): Map<number, number> {
  const installations = new Map<number, number>()

  for (const value of values) {
    const [left, right] = value.split('=')
    const organization = right ? Number(left) : 0
    const installation = Number(right ?? left)

    if (!Number.isInteger(organization) || !Number.isInteger(installation)) {
      throw new Error(`--installation "${value}" no es un número ni "<org_id>=<installation_id>".`)
    }

    installations.set(organization, installation)
  }

  return installations
}

async function resolveInstallation(login: string): Promise<number> {
  try {
    const { data } = await appClient().rest.apps.getOrgInstallation({ org: login })
    return data.id
  } catch {
    throw new Error(
      `La App no está instalada en @${login}, así que no hay installation_id. ` +
        'Instalala y volvé a correr, o pasá --installation.',
    )
  }
}

/**
 * The GitHub id of everyone the classroom needs.
 *
 * For a student the export usually answers it — the id is inside `avatar_url`
 * — and GitHub is only asked about the ones it does not, plus the teachers,
 * who are not in the export at all. The login is kept as the export spells it,
 * because that is the key the plan is written in; everything else comes from
 * the API, which is the source of truth for names and avatars.
 */
async function resolveUsers(
  plan: ClassroomPlan,
  teachers: string[],
  installationId: number,
): Promise<ResolvedUser[]> {
  const resolved: ResolvedUser[] = []
  const client = installationClient(installationId)

  const lookup = async (login: string): Promise<ResolvedUser> => {
    try {
      const { data } = await client.rest.users.getByUsername({ username: login })
      return {
        login,
        uid: data.id,
        name: data.name ?? null,
        avatarUrl: data.avatar_url ?? null,
        htmlUrl: data.html_url ?? null,
      }
    } catch {
      throw new Error(`GitHub no conoce a @${login}. ¿Se borró la cuenta o cambió de nombre?`)
    }
  }

  for (const user of plan.users) {
    resolved.push(user.uid === null ? await lookup(user.login) : { ...user, uid: user.uid })
  }

  const known = new Set(resolved.map((user) => user.login))
  for (const teacher of teachers) {
    if (!known.has(teacher)) resolved.push(await lookup(teacher))
  }

  return resolved
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
