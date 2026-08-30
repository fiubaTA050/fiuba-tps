import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { organizationSlug, parameterize } from '@/lib/data/slug'

/**
 * Reads an export produced by `github-education-resources/classroom-export-utility`
 * and turns it into a plan `lib/data/import.ts` can write.
 *
 * The utility is a thin dump of the public Classroom API — one file per
 * endpoint — so the ceiling of what can be imported is that API's, not the
 * utility's:
 *
 *   classrooms.json                                 GET /classrooms
 *   classroom-<id>/classroom.json                   GET /classrooms/:id
 *   classroom-<id>/assignments.json                 GET /classrooms/:id/assignments
 *   .../assignment-<id>/assignment.json             GET /assignments/:id
 *   .../assignment-<id>/accepted-assignments.json   GET /assignments/:id/accepted_assignments
 *   .../assignment-<id>/grades.csv                  GET /assignments/:id/grades
 *
 * Six things our schema needs are not in there, and this module says so rather
 * than inventing them:
 *
 *  - `organizations.installation_id`. Not a Classroom concept at all; the
 *    caller resolves it from the GitHub App and passes it in.
 *  - `organizations_users`, the teachers. No endpoint exposes them, so the
 *    caller names them (`--teacher`).
 *  - `users.uid`. The trap of this format: `students[].id` is Classroom's own
 *    id, **not** the GitHub one — for @espinaemmanuel the export says 3268030
 *    where the GitHub id is 517713. The real one is only in `avatar_url`
 *    (`/u/<uid>`), which is what `githubUid` below reads; when even that is
 *    missing the caller looks the login up.
 *  - The roster. There is no endpoint; the padrón survives only as the
 *    `roster_identifier` column of grades.csv, so it covers the students who
 *    accepted something and nobody else.
 *  - Team names. `accepted-assignments.json` has the repository and its
 *    members but not the team, which lives in grades.csv's `group_name`.
 *    Measured on the real export: `parameterize(group_name)` reproduces the
 *    repository suffix exactly, so the slug is derived and cross-checked.
 *  - The long invitation `key`. Only the short link is exported
 *    (`https://classroom.github.com/a/Mccf8hyl`), so the key is generated at
 *    write time and the short one kept, which is what makes the link a teacher
 *    already handed out work against our own host.
 *
 * Dropped on purpose, because there is nothing here to hold them: `deadline`,
 * `points_awarded`/`points_available`/`passing` (autograding), `editor`,
 * `language`, `feedback_pull_requests_enabled`. `commit_count` and `submitted`
 * are dropped too, but for the opposite reason — the dashboard computes both
 * live from GitHub, and net of the initial commit, so the export's numbers are
 * not even comparable.
 */

/** `GET /classrooms/:id` — `organizations` plus the GitHub org behind it */
type ExportOrganization = {
  id: number
  login: string
  node_id: string
  html_url: string
  name: string | null
  avatar_url: string
}

type ExportClassroom = {
  id: number
  name: string
  archived: boolean
  url: string
  organization?: ExportOrganization
}

type ExportRepository = {
  id: number
  name: string
  full_name: string
  html_url: string
  node_id: string
  private: boolean
  default_branch: string
}

type ExportAssignment = {
  id: number
  public_repo: boolean
  title: string
  type: 'individual' | 'group'
  invite_link: string
  invitations_enabled: boolean
  slug: string
  students_are_repo_admins: boolean
  feedback_pull_requests_enabled: boolean
  max_teams: number | null
  max_members: number | null
  deadline: string | null
  starter_code_repository?: ExportRepository | null
}

/** `students[].id` is Classroom's id. The GitHub one is inside `avatar_url` */
type ExportStudent = {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
  html_url: string | null
}

type ExportAcceptedAssignment = {
  id: number
  submitted: boolean
  commit_count: number
  students: ExportStudent[]
  repository: ExportRepository | null
}

type GradeRow = {
  github_username: string
  roster_identifier: string
  student_repository_name: string
  group_name?: string
}

export type ExportBundle = {
  classroom: ExportClassroom
  assignments: {
    assignment: ExportAssignment
    accepted: ExportAcceptedAssignment[]
    grades: GradeRow[]
  }[]
}

/** A user the import has to create or refresh. `uid` is null when only the API can say */
export type PlanUser = {
  login: string
  uid: number | null
  name: string | null
  avatarUrl: string | null
  htmlUrl: string | null
}

export type PlanRosterEntry = {
  identifier: string
  /** Null leaves the entry unlinked, which is a normal state for a roster */
  login: string | null
}

type PlanAssignmentBase = {
  /** The original's assignment id. Only for the report */
  sourceId: number
  title: string
  slug: string
  publicRepo: boolean
  invitationsEnabled: boolean
  studentsAreRepoAdmins: boolean
  starterCodeRepoId: number | null
  /** The eight characters of the exported invite link, kept so old links work */
  shortKey: string | null
}

export type PlanAssignment = PlanAssignmentBase & {
  acceptances: { login: string; repoId: number | null }[]
}

export type PlanGroupAssignment = PlanAssignmentBase & {
  maxMembers: number | null
  maxTeams: number | null
  acceptances: { teamSlug: string; repoId: number | null }[]
}

export type PlanTeam = { title: string; slug: string; members: string[] }

export type ClassroomPlan = {
  /** The original's classroom id, so the report matches the export directory */
  sourceId: number
  githubId: number
  login: string
  title: string
  slug: string
  archived: boolean
  users: PlanUser[]
  roster: PlanRosterEntry[]
  teams: PlanTeam[]
  assignments: PlanAssignment[]
  groupAssignments: PlanGroupAssignment[]
  /** Imported anyway, with something lost or guessed */
  warnings: string[]
  /** Not importable. The caller skips this classroom */
  errors: string[]
}

/** Reads the whole export directory. Throws if it is not one */
export function readExport(directory: string): ExportBundle[] {
  const index = join(directory, 'classrooms.json')
  if (!existsSync(index)) {
    throw new Error(
      `${directory} no parece un export de classroom-export-utility: falta classrooms.json.`,
    )
  }

  return readJson<ExportClassroom[]>(index).map((entry) => {
    const path = join(directory, `classroom-${entry.id}`)
    if (!existsSync(path)) {
      throw new Error(`Falta el directorio ${path} que classrooms.json anuncia.`)
    }

    const classroom = readJson<ExportClassroom>(join(path, 'classroom.json'))
    const assignments = readJson<ExportAssignment[]>(join(path, 'assignments.json'))

    // From the directory rather than from assignments.json, so an assignment
    // whose own directory is missing is a loud failure instead of a silent gap
    const directories = readdirSync(path)
      .filter((name) => /^assignment-\d+$/.test(name))
      .sort()

    return {
      classroom,
      assignments: directories.map((name) => {
        const assignmentPath = join(path, name)
        const assignment = readJson<ExportAssignment>(join(assignmentPath, 'assignment.json'))
        const accepted = readJson<ExportAcceptedAssignment[]>(
          join(assignmentPath, 'accepted-assignments.json'),
        )
        const grades = join(assignmentPath, 'grades.csv')

        return {
          // assignments.json carries the same object; the per-assignment file
          // is the one with `starter_code_repository`
          assignment: { ...assignments.find((a) => a.id === assignment.id), ...assignment },
          accepted,
          grades: existsSync(grades) ? parseCsv<GradeRow>(readFileSync(grades, 'utf8')) : [],
        }
      }),
    }
  })
}

/**
 * Plans every classroom of the export, plus the checks that only make sense
 * across classrooms.
 */
export function planExport(bundles: ExportBundle[]): ClassroomPlan[] {
  const plans = bundles.map(planClassroom)

  // An assignment slug is a repository prefix, and repository names belong to
  // the GitHub organization, which hosts one classroom per term — the rule
  // lib/data/assignment-fields.ts enforces on creation. The database indexes
  // are per classroom, so a collision imports fine and only bites the teacher
  // later, on the next edit. Warn on both plans.
  const bySlug = new Map<string, ClassroomPlan[]>()
  for (const plan of plans) {
    for (const assignment of [...plan.assignments, ...plan.groupAssignments]) {
      const key = `${plan.githubId}/${assignment.slug}`
      bySlug.set(key, [...(bySlug.get(key) ?? []), plan])
    }
  }

  for (const [key, owners] of bySlug) {
    if (owners.length < 2) continue
    const slug = key.split('/')[1]
    for (const plan of owners) {
      plan.warnings.push(
        `El slug "${slug}" se repite en ${owners.length} classrooms de @${plan.login}. ` +
          'Se importa igual, pero editarlos va a chocar con la unicidad por organización.',
      )
    }
  }

  return plans
}

export function planClassroom(bundle: ExportBundle): ClassroomPlan {
  const warnings: string[] = []
  const errors: string[] = []

  const organization = bundle.classroom.organization
  if (!organization) {
    throw new Error(
      `El classroom ${bundle.classroom.id} no trae la organización de GitHub en classroom.json.`,
    )
  }

  const title = bundle.classroom.name
  const slug = organizationSlug(organization.id, title)

  // The original's slug is the tail of `url`, and our parameterize reproduces
  // it — measured on the real export. Warn rather than adopt theirs: the slug
  // has to be the one our own writers would produce, or the next rename breaks.
  const exported = bundle.classroom.url.split('/').pop()
  if (exported && exported !== slug) {
    warnings.push(`La URL del classroom cambia: /classrooms/${exported} pasa a /classrooms/${slug}.`)
  }

  const users = new Map<string, PlanUser>()
  const collect = (student: ExportStudent) => {
    const existing = users.get(student.login)
    const uid = githubUid(student.avatar_url)

    if (!existing) {
      users.set(student.login, {
        login: student.login,
        uid,
        name: student.name,
        avatarUrl: student.avatar_url,
        htmlUrl: student.html_url,
      })
    } else if (existing.uid === null && uid !== null) {
      existing.uid = uid
    }
  }

  const assignments: PlanAssignment[] = []
  const groupAssignments: PlanGroupAssignment[] = []
  const teams = new Map<string, PlanTeam>()
  /** login -> team slug, to catch what the schema cannot hold */
  const teamOf = new Map<string, string>()

  for (const { assignment, accepted, grades } of bundle.assignments) {
    for (const entry of accepted) entry.students.forEach(collect)

    if (assignment.deadline) {
      warnings.push(
        `"${assignment.title}" tenía deadline ${assignment.deadline}: no se importa, no hay deadlines acá.`,
      )
    }
    if (assignment.feedback_pull_requests_enabled) {
      warnings.push(
        `"${assignment.title}" tenía feedback pull requests: no se importa, no está portado.`,
      )
    }

    const base: PlanAssignmentBase = {
      sourceId: assignment.id,
      title: assignment.title,
      slug: assignment.slug,
      publicRepo: assignment.public_repo,
      invitationsEnabled: assignment.invitations_enabled,
      studentsAreRepoAdmins: assignment.students_are_repo_admins,
      starterCodeRepoId: assignment.starter_code_repository?.id ?? null,
      shortKey: shortKeyOf(assignment.invite_link),
    }

    if (assignment.type === 'individual') {
      assignments.push({
        ...base,
        acceptances: accepted.flatMap((entry) => {
          if (entry.students.length !== 1) {
            warnings.push(
              `"${assignment.title}" tiene una aceptación individual con ${entry.students.length} alumnos: se saltea.`,
            )
            return []
          }
          if (!entry.repository) {
            warnings.push(
              `@${entry.students[0].login} aceptó "${assignment.title}" sin repo: queda aceptado, sin repositorio.`,
            )
          }
          return [{ login: entry.students[0].login, repoId: entry.repository?.id ?? null }]
        }),
      })
      continue
    }

    // The team name is only in grades.csv, keyed by the repository name
    const named = new Map<string, string>()
    for (const row of grades) {
      if (row.group_name) named.set(row.student_repository_name, row.group_name)
    }

    groupAssignments.push({
      ...base,
      maxMembers: assignment.max_members,
      maxTeams: assignment.max_teams,
      acceptances: accepted.flatMap((entry) => {
        const repositoryName = entry.repository?.name ?? ''
        const suffix = repositoryName.startsWith(`${assignment.slug}-`)
          ? repositoryName.slice(assignment.slug.length + 1)
          : ''
        const name = named.get(repositoryName)

        if (!name && !suffix) {
          warnings.push(
            `Una aceptación grupal de "${assignment.title}" no tiene ni nombre de equipo ni repo: se saltea.`,
          )
          return []
        }

        // parameterize(group_name) reproduces the repository suffix on the
        // real export; when it does not, the repository is the authority —
        // it is the name the students already see.
        const teamTitle = name ?? suffix
        const teamSlug = suffix || parameterize(teamTitle)
        if (name && suffix && parameterize(name) !== suffix) {
          warnings.push(
            `El equipo "${name}" no coincide con su repo ${repositoryName}: se usa el slug "${teamSlug}".`,
          )
        }

        const team = teams.get(teamSlug) ?? { title: teamTitle, slug: teamSlug, members: [] }
        for (const student of entry.students) {
          const previous = teamOf.get(student.login)

          // groups_users is unique on (grouping_id, user_id) and groups on
          // (organization_id, slug): a student who changed teams between two
          // group assignments of the same classroom has no representation
          // here, and renaming their teams to fit would be inventing data.
          if (previous && previous !== teamSlug) {
            errors.push(
              `@${student.login} está en dos equipos del mismo classroom ("${previous}" y "${teamSlug}"). ` +
                'Nuestro modelo tiene un equipo por alumno por classroom.',
            )
            continue
          }

          teamOf.set(student.login, teamSlug)
          if (!team.members.includes(student.login)) team.members.push(student.login)
        }
        teams.set(teamSlug, team)

        if (!entry.repository) {
          warnings.push(
            `El equipo "${teamTitle}" aceptó "${assignment.title}" sin repo: queda aceptado, sin repositorio.`,
          )
        }

        return [{ teamSlug, repoId: entry.repository?.id ?? null }]
      }),
    })
  }

  return {
    sourceId: bundle.classroom.id,
    githubId: organization.id,
    login: organization.login,
    title,
    slug,
    archived: bundle.classroom.archived,
    users: [...users.values()],
    roster: planRoster(bundle, warnings),
    teams: [...teams.values()],
    assignments,
    groupAssignments,
    warnings,
    errors,
  }
}

/**
 * The roster, reconstructed from the `roster_identifier` column of every
 * grades.csv of the classroom. Two consequences worth saying out loud, both
 * reported: a student who never accepted anything is not in the export at all,
 * and the identifier arrives as `109525\tURBANO, SOL GUADALUPE` — padrón, tab,
 * name. The tab becomes a space and the rest is kept verbatim, because the
 * name is what a teacher recognises in the roster table.
 */
function planRoster(bundle: ExportBundle, warnings: string[]): PlanRosterEntry[] {
  const entries: PlanRosterEntry[] = []
  const byIdentifier = new Map<string, PlanRosterEntry>()
  /** The identifier already linked to each login: the (roster_id, user_id) index is unique */
  const linked = new Map<string, string>()
  const missing = new Set<string>()

  for (const { grades } of bundle.assignments) {
    for (const row of grades) {
      const identifier = row.roster_identifier.replace(/\t/g, ' ').trim()
      const login = row.github_username.trim()

      if (!identifier) {
        if (login) missing.add(login)
        continue
      }

      const existing = byIdentifier.get(identifier)
      if (existing) {
        if (login && existing.login && existing.login !== login) {
          warnings.push(
            `El padrón "${identifier}" aparece con @${existing.login} y con @${login}: se linkea el primero.`,
          )
        }
        continue
      }

      const claimed = linked.get(login)
      if (login && claimed) {
        // Both padrones are kept — losing one loses a student — but only the
        // first stays linked, which is what the partial unique index allows.
        warnings.push(
          `@${login} aparece con dos padrones ("${claimed}" y "${identifier}"): el segundo queda sin linkear.`,
        )
      }

      const entry: PlanRosterEntry = { identifier, login: login && !claimed ? login : null }
      if (entry.login) linked.set(login, identifier)

      byIdentifier.set(identifier, entry)
      entries.push(entry)
    }
  }

  if (missing.size > 0) {
    warnings.push(
      `${missing.size} alumnos aceptaron sin padrón (${[...missing].map((l) => `@${l}`).join(', ')}): ` +
        'quedan como usuarios, fuera de la lista.',
    )
  }

  return entries
}

/**
 * The GitHub user id, out of the avatar URL.
 *
 * `avatars.githubusercontent.com/u/<id>?v=4` is the shape the API returns for
 * every account, and it is the only place in this export where the real id
 * appears — `students[].id` is Classroom's own.
 */
export function githubUid(avatarUrl: string | null): number | null {
  const match = avatarUrl?.match(/\/u\/(\d+)/)
  return match ? Number(match[1]) : null
}

/** `https://classroom.github.com/a/Mccf8hyl` -> `Mccf8hyl` */
function shortKeyOf(inviteLink: string | undefined): string | null {
  const match = inviteLink?.match(/\/[ag]\/([A-Za-z0-9_-]+)\/?$/)
  return match ? match[1] : null
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * RFC 4180, which grades.csv needs for real: `roster_identifier` is a quoted
 * field with a comma *and* a tab inside it ("109525\tURBANO, SOL GUADALUPE").
 */
export function parseCsv<T>(text: string): T[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const character = text[i]

    if (quoted) {
      if (character !== '"') {
        field += character
      } else if (text[i + 1] === '"') {
        // "" inside a quoted field is one literal quote
        field += '"'
        i++
      } else {
        quoted = false
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else {
      field += character
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const [header, ...body] = rows
  if (!header) return []

  return body
    .filter((columns) => columns.some((value) => value !== ''))
    .map(
      (columns) =>
        Object.fromEntries(header.map((name, index) => [name, columns[index] ?? ''])) as T,
    )
}
