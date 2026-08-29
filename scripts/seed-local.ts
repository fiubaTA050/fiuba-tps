import { parseArgs } from 'node:util'

import { eq } from 'drizzle-orm'

import {
  assignmentInvitations,
  assignmentRepos,
  assignments,
  inviteStatuses,
  organizations,
  organizationsUsers,
  users,
} from '@/db/schema'
import { db } from '@/lib/db'
import { appClient, installationClient } from '@/lib/github/client'

/**
 * Puts a classroom, an assignment and one student repository into a **local**
 * database, so the app can be driven end to end without touching the cátedra's
 * Supabase.
 *
 *   npm run dev:seed -- --org fiubaTA050-labs --login <tu-usuario>
 *   npm run dev:seed -- --down
 *
 * Two things it does not fake, because they cannot be faked:
 *
 *  - **The GitHub calls are real.** There is no local mode for an installation
 *    token, so the repository the student hands in against has to exist. This
 *    creates a throwaway one in the organization — `zzz-seed-<login>` — with a
 *    second commit, a branch and a tag, and `--down` deletes it. Pointing the
 *    seed at a student's repository instead would be a mistake: the setup
 *    screen calls `addCollaborator` on whatever repository it finds.
 *  - **The classroom row is written directly**, rather than through
 *    `createClassroom`, which would set the organization's default repository
 *    permission to `none` — a real change to the real organization's settings.
 *
 * The user row carries the real GitHub uid, so signing in at localhost with
 * that account lands on this same row (`auth.ts` upserts on `users.uid`).
 */

const { values } = parseArgs({
  options: {
    org: { type: 'string', default: 'fiubaTA050-labs' },
    login: { type: 'string' },
    down: { type: 'boolean', default: false },
  },
})

// The one guard that matters. Everything below writes without asking, and the
// point of the script is to keep production out of it.
const databaseUrl = process.env.DATABASE_URL ?? ''
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) {
  console.error(
    'Esto sólo corre contra una base local. Levantá `docker compose up -d` y pasá\n' +
      'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/fiuba_tps',
  )
  process.exit(1)
}

const ORG = values.org!
const SLUG = 'seed-local'
const ASSIGNMENT_SLUG = 'seed-entregas'
const KEY = 'seed-entregas-key'

const { data: installations } = await appClient().rest.apps.listInstallations()
const installation = installations.find(
  (row) => row.account && 'login' in row.account && row.account.login === ORG,
)

if (!installation) {
  console.error(`La App no está instalada en ${ORG}.`)
  process.exit(1)
}

const octokit = installationClient(installation.id)

if (values.down) {
  const [classroom] = await db.select().from(organizations).where(eq(organizations.slug, SLUG))

  if (classroom) {
    const [repo] = await db
      .select({ githubRepoId: assignmentRepos.githubRepoId })
      .from(assignmentRepos)
      .innerJoin(assignments, eq(assignments.id, assignmentRepos.assignmentId))
      .where(eq(assignments.organizationId, classroom.id))

    if (repo) {
      try {
        const { data } = await octokit.request('GET /repositories/{id}', { id: repo.githubRepoId })
        await octokit.rest.repos.delete({ owner: data.owner.login, repo: data.name })
        console.log(`borrado ${data.full_name}`)
      } catch {
        console.log('el repositorio ya no estaba')
      }
    }

    // The classroom cascades to the assignment, the invitation, the statuses,
    // the repo row and its submissions
    await db.delete(organizations).where(eq(organizations.id, classroom.id))
    console.log('borradas las filas del seed')
  } else {
    console.log('no había nada que borrar')
  }

  process.exit(0)
}

if (!values.login) {
  console.error('Falta --login <tu-usuario-de-github>.')
  process.exit(1)
}

const { data: account } = await octokit.rest.users.getByUsername({ username: values.login })
const name = `zzz-seed-${values.login.toLowerCase()}`

const { data: repo } = await octokit.rest.repos.createInOrg({
  org: ORG,
  name,
  private: true,
  auto_init: true,
  description: 'temporal, creado por npm run dev:seed',
})

// `auto_init` answers before the initial commit is queryable — the same ~3 s
// window docs/creacion-de-repos.md measured for the template path
await new Promise((resolve) => setTimeout(resolve, 3000))

await octokit.rest.repos.createOrUpdateFileContents({
  owner: ORG,
  repo: name,
  path: 'entrega.md',
  message: 'Resuelve el punto 3',
  content: Buffer.from('# entrega\n').toString('base64'),
})

const { data: head } = await octokit.rest.git.getRef({
  owner: ORG,
  repo: name,
  ref: `heads/${repo.default_branch}`,
})

// A branch off the default one, so "ese commit no está en main" can be seen,
// and a tag, which is what students actually hand in with
await octokit.rest.git.createRef({
  owner: ORG,
  repo: name,
  ref: 'refs/heads/otra',
  sha: head.object.sha,
})
await octokit.rest.repos.createOrUpdateFileContents({
  owner: ORG,
  repo: name,
  path: 'aparte.md',
  message: 'Algo fuera de la rama default',
  content: Buffer.from('aparte\n').toString('base64'),
  branch: 'otra',
})
await octokit.rest.git.createRef({
  owner: ORG,
  repo: name,
  ref: 'refs/tags/Entrega',
  sha: head.object.sha,
})

const [user] = await db
  .insert(users)
  .values({
    uid: account.id,
    githubLogin: account.login,
    githubName: account.name,
    githubAvatarUrl: account.avatar_url,
    githubHtmlUrl: account.html_url,
  })
  .onConflictDoUpdate({ target: users.uid, set: { githubLogin: account.login } })
  .returning({ id: users.id })

const [classroom] = await db
  .insert(organizations)
  .values({
    githubId: installation.account!.id,
    installationId: installation.id,
    title: 'Classroom local',
    slug: SLUG,
  })
  .returning({ id: organizations.id })

await db
  .insert(organizationsUsers)
  .values({ organizationId: classroom.id, userId: user.id })
  .onConflictDoNothing()

const [assignment] = await db
  .insert(assignments)
  .values({
    title: 'Entregas (seed)',
    slug: ASSIGNMENT_SLUG,
    organizationId: classroom.id,
    creatorId: user.id,
    publicRepo: false,
  })
  .returning({ id: assignments.id })

const [invitation] = await db
  .insert(assignmentInvitations)
  .values({ key: KEY, assignmentId: assignment.id })
  .returning({ id: assignmentInvitations.id })

await db
  .insert(inviteStatuses)
  .values({ status: 'completed', assignmentInvitationId: invitation.id, userId: user.id })

await db
  .insert(assignmentRepos)
  .values({ githubRepoId: repo.id, assignmentId: assignment.id, userId: user.id })

console.log(`
Listo. Entrá a http://localhost:3000 y logueate con @${account.login}.

  Docente  http://localhost:3000/classrooms/${SLUG}/assignments/${ASSIGNMENT_SLUG}/edit
           marcá "Los alumnos pueden confirmar su entrega" y poné una fecha

  Alumno   http://localhost:3000/assignment-invitations/${KEY}/setup
           probá con: ${repo.default_branch} · Entrega (tag) · otra (fuera de la rama default)

  Repo     ${repo.html_url}

Para borrar todo, incluido el repositorio:  npm run dev:seed -- --down
`)

process.exit(0)
