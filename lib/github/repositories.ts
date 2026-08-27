import type { Session } from 'next-auth'

import { installationClient, userClient } from '@/lib/github/client'

/**
 * Port of GitHubRepository, trimmed to what the starter code flow needs.
 *
 * The original read these with `creator.github_client` — the teacher's stored
 * OAuth token. Here they go through the installation token (DA-6), which was
 * measured to be enough: it reads any repo inside an org where the App is
 * installed, and any public repo anywhere. The one case it cannot reach is a
 * private repo in an org without the App, and `starterCodeError` says so.
 */

/** Port of GitHubRepository's github_attributes, plus is_template */
export type GitHubRepository = {
  id: number
  fullName: string
  htmlUrl: string
  private: boolean
  isTemplate: boolean
}

/** `owner/name`, the format the original's StarterCode concern validates */
export const REPOSITORY_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

function toRepository(data: {
  // Octokit types the id of a freshly created repo as `number | bigint`.
  // GitHub's ids are well inside Number.MAX_SAFE_INTEGER and the column is a
  // bigint read in `number` mode, so narrowing here is safe and keeps the
  // widening out of every caller.
  id: number | bigint
  full_name: string
  html_url: string
  private: boolean
  is_template?: boolean | null
}): GitHubRepository {
  return {
    id: Number(data.id),
    fullName: data.full_name,
    htmlUrl: data.html_url,
    private: data.private,
    isTemplate: data.is_template ?? false,
  }
}

/**
 * The org's own template repositories, shown as the starter code field's
 * suggestions before anything is typed. No equivalent in the original, whose
 * autocomplete had nothing to offer until you gave it a query; the search
 * itself is ported in lib/github/search.ts.
 *
 * The list is worth its request: a classroom's starter code is usually a repo
 * of its own org, and `fiubaTA050-labs` has 152 repos and exactly one template.
 */
export async function listTemplateRepositories(
  installationId: number,
  orgLogin: string,
): Promise<GitHubRepository[]> {
  const octokit = installationClient(installationId)

  const repositories = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: orgLogin,
    per_page: 100,
    sort: 'updated',
  })

  return repositories.filter((repo) => repo.is_template).map(toRepository)
}

/**
 * Port of GitHubRepository.find_by_name_with_owner!.
 *
 * Returns null when the repo does not exist *or* is invisible to the App —
 * the API answers 404 to both, deliberately, so that a private repo cannot be
 * probed into existence. The caller's message has to cover both readings.
 */
export async function findRepositoryByFullName(
  installationId: number,
  fullName: string,
): Promise<GitHubRepository | null> {
  const [owner, repo] = fullName.split('/')

  try {
    const { data } = await installationClient(installationId).rest.repos.get({ owner, repo })
    return toRepository(data)
  } catch {
    return null
  }
}

/** The same lookup by id, for rendering a stored `starter_code_repo_id` (DA-2) */
export async function findRepositoryById(
  installationId: number,
  repositoryId: number,
): Promise<GitHubRepository | null> {
  try {
    const { data } = await installationClient(installationId).request('GET /repositories/{id}', {
      id: repositoryId,
    })
    return toRepository(data)
  } catch {
    return null
  }
}

/**
 * Port of CreateGitHubRepoService#create_github_repository_from_template!
 *
 * The `owner` of the body is the destination org; the template goes in the
 * path. Measured at ~2 s, and it answers before the repository has any commits
 * — for ~3 s more `GET /commits` still 409s. Nothing waits for that, and the
 * original does not either: with a template `use_importer?` is false, so it
 * goes straight to `completed!`. See docs/creacion-de-repos.md.
 */
export async function createRepositoryFromTemplate(
  installationId: number,
  input: {
    template: { owner: string; name: string }
    owner: string
    name: string
    private: boolean
    description: string
  },
): Promise<GitHubRepository> {
  const { data } = await installationClient(installationId).request(
    'POST /repos/{template_owner}/{template_repo}/generate',
    {
      template_owner: input.template.owner,
      template_repo: input.template.name,
      owner: input.owner,
      name: input.name,
      private: input.private,
      description: input.description,
    },
  )

  return toRepository(data)
}

/**
 * Port of CreateGitHubRepoService#create_github_repository!, the branch taken
 * when the assignment has no starter code: an empty repository in the org.
 */
export async function createRepository(
  installationId: number,
  input: { owner: string; name: string; private: boolean; description: string },
): Promise<GitHubRepository> {
  const { data } = await installationClient(installationId).rest.repos.createInOrg({
    org: input.owner,
    name: input.name,
    private: input.private,
    description: input.description,
  })

  return toRepository(data)
}

/**
 * Port of CreateGitHubRepoService#delete_github_repository, the compensating
 * step of its `rescue`: if anything after the creation fails, the half-built
 * repository does not survive to confuse the student or the teacher.
 *
 * Swallows errors exactly as the original does (`rescue GitHub::Error; true`).
 * The delete is best effort — failing it must not mask the error that caused
 * the rollback in the first place.
 */
export async function deleteRepository(
  installationId: number,
  fullName: string,
): Promise<void> {
  const [owner, repo] = fullName.split('/')

  try {
    await installationClient(installationId).rest.repos.delete({ owner, repo })
  } catch {
    // Best effort, see above
  }
}

/**
 * Port of CreateGitHubRepoService#add_user_to_github_repository!, first half:
 *
 *   invitation = github_repository.invite(exercise.slug, repository_permissions)
 *
 * Returns the invitation id, or null when GitHub answers 204 — which means the
 * user already had access and no invitation was created. That happens for a
 * teacher testing their own assignment, since an org owner already reaches
 * every repository.
 */
export async function addCollaborator(
  installationId: number,
  fullName: string,
  username: string,
  permission: 'push' | 'admin',
): Promise<number | null> {
  const [owner, repo] = fullName.split('/')

  const response = await installationClient(installationId).rest.repos.addCollaborator({
    owner,
    repo,
    username,
    permission,
  })

  // 201 carries the invitation, 204 means they were already a collaborator
  return response.status === 201 ? (response.data?.id ?? null) : null
}

/**
 * The other direction, for a teacher moving a student off a team.
 *
 * The original never needs this: access there comes from the GitHub team, so
 * removing somebody from the team removes it everywhere at once
 * (`Group#remove_from_github_team`). With collaborators the access is per
 * repository and has to be taken back the same way.
 *
 * Also revokes a collaborator invitation that was never accepted, which
 * `removeCollaborator` does on its own — otherwise a student could accept an
 * email invitation to a repository they were already moved off.
 */
export async function removeCollaborator(
  installationId: number,
  fullName: string,
  username: string,
): Promise<void> {
  const [owner, repo] = fullName.split('/')

  try {
    await installationClient(installationId).rest.repos.removeCollaborator({
      owner,
      repo,
      username,
    })
  } catch (error) {
    // The repository is gone, or they were never a collaborator. Both are the
    // state we were after.
    if (isNotFound(error)) return
    throw error
  }
}

/**
 * Port of the second half:
 *
 *   exercise.collaborator.github_user.accept_repository_invitation(invitation.id)
 *
 * This is the one call that needs the **student's** token, which is why the
 * whole flow runs in a request their browser makes (docs/creacion-de-repos.md).
 * Without it the student gets an email from GitHub and has to click it.
 *
 * Idempotent by consequence: accepting an invitation that is already accepted
 * or gone answers 404, and there is nothing to do about that but carry on.
 */
export async function acceptRepositoryInvitation(
  session: Session,
  invitationId: number,
): Promise<void> {
  try {
    await userClient(session).rest.repos.acceptInvitationForAuthenticatedUser({
      invitation_id: invitationId,
    })
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
}

/** Whether a repository name is already taken, for Exercise#generate_repo_name */
export async function repositoryExists(
  installationId: number,
  fullName: string,
): Promise<boolean> {
  const [owner, repo] = fullName.split('/')

  try {
    await installationClient(installationId).rest.repos.get({ owner, repo })
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

/**
 * GitHub's secondary rate limit, which is what a whole cohort clicking the
 * invitation link at once runs into: 80 content-creating requests per minute,
 * 500 per hour, answered with 403 or 429.
 *
 * Returns how many seconds to wait, or null when the error is something else.
 * The original had no equivalent — it read `Octokit::TooManyRequests` as a
 * plain failure and retried three times blindly, which under a stampede is
 * exactly the wrong move.
 *
 * `retry-after` is the documented signal; when it is missing GitHub's own
 * guidance is to wait at least a minute.
 */
export function secondaryRateLimitDelay(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null

  const status = (error as { status?: number }).status
  if (status !== 403 && status !== 429) return null

  const headers = (error as { response?: { headers?: Record<string, string> } }).response?.headers

  const retryAfter = Number(headers?.['retry-after'])
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter)

  // A 403 is also how GitHub answers a plain permission problem, which must not
  // be mistaken for a wait. Only the documented message means "slow down".
  const message = (error as { message?: string }).message ?? ''
  if (!/secondary rate limit|abuse detection/i.test(message)) return null

  return 60
}

/**
 * What the assignment dashboard shows for one student's repository: where it
 * is, and how far along it is. DA-2 again — only `github_repo_id` is stored,
 * everything here is read at render time.
 */
export type RepositorySnapshot = {
  id: number
  fullName: string
  htmlUrl: string
  /** Null when the repository has no commits at all */
  latestCommitAt: Date | null
  /**
   * The student's **own** commits: what the repository carries, minus the one
   * it was born with. Zero means nothing was handed in — see
   * `listRepositorySnapshots` on why the baseline is what it is.
   */
  commitCount: number
}

/**
 * GraphQL refuses more than 100 node ids in one `nodes(ids:)`, and small
 * batches run in parallel on GitHub's side: measured on TA050, 80 repositories
 * cost 5.5 s asked in one query and 0.6 s asked in batches of 5. The limit is
 * not the field but the wait for one repository's commit history.
 */
const SNAPSHOT_BATCH = 5

/**
 * The GraphQL node id of a repository, derived from the numeric id we store.
 *
 * GitHub's next-gen ids are `R_` followed by base64url of msgpack `[0, id]` —
 * measured against the API: repository 1064428436 is `R_kgDOP3HjlA`, which is
 * what `Repository.id` returns for it today. Deriving it is what lets this ask
 * for repositories by id without a name, a migration or a stored column.
 */
function repositoryNodeId(databaseId: number): string {
  // msgpack: 0x92 = 2-element array, 0x00 = the Repository type tag, then the
  // id as the narrowest unsigned int that holds it
  if (databaseId <= 0xffffffff) {
    const packed = Buffer.alloc(7)
    packed[0] = 0x92
    packed[1] = 0x00
    packed[2] = 0xce // uint32
    packed.writeUInt32BE(databaseId, 3)
    return `R_${packed.toString('base64url')}`
  }

  // Not reachable yet — GitHub's repository ids are around 1.1e9 — but the
  // encoding is the msgpack one and this is what it becomes past 2^32
  const packed = Buffer.alloc(11)
  packed[0] = 0x92
  packed[1] = 0x00
  packed[2] = 0xcf // uint64
  packed.writeBigUInt64BE(BigInt(databaseId), 3)
  return `R_${packed.toString('base64url')}`
}

type SnapshotNode = {
  databaseId: number | null
  nameWithOwner: string
  url: string
  defaultBranchRef: {
    target: { committedDate?: string; history?: { totalCount: number } } | null
  } | null
} | null

const SNAPSHOT_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      databaseId
      nameWithOwner
      url
      defaultBranchRef {
        target {
          ... on Commit { committedDate history { totalCount } }
        }
      }
    }
  }
}`

/**
 * The snapshots of a set of repositories, asked for by id.
 *
 * The dashboard needs the name, the URL, the commit count and the date of the
 * last commit for every student of the assignment. Asked one repository at a
 * time that is 49 round trips inside the teacher's request for one cohort of
 * TA050 — the shape the GitHub token caching note already flagged, and the
 * reason `docs/creacion-de-repos.md` cares about call counts at all.
 *
 * This used to walk the organization's repositories page by page, newest push
 * first, stopping once every wanted id had turned up, on the belief that
 * `nodes(ids:)` was unusable because it wants global node ids and we store
 * numeric ones. It is usable: the node id is derivable (`repositoryNodeId`).
 * The walk was the whole cost of the screen — it paid for the commit history
 * of all 127 repositories of `fiubaTA050-labs` to read 13 of them, 5.1 s per
 * page, and a cohort whose repositories had not been pushed to recently needed
 * two pages. Asking by id is 0.6 s for the same 13, and does not grow with the
 * organization. It also fixes a quiet bug: the walk gave up after ten pages,
 * so an old repository in a growing organization would eventually render as
 * unreachable without anyone having deleted it.
 *
 * GraphQL and not REST because `GET /repositories/{id}` carries neither the
 * commit count nor the last commit date, and both are one field here.
 *
 * Ids that never turn up are simply absent from the map: the repository was
 * deleted or moved out of the org, which is the NullGitHubRepository case the
 * callers already render as unreachable. GitHub answers a batch holding one
 * such id with an error *and* the data for the rest, which is why the catch
 * reads `error.data` instead of dropping the batch.
 *
 * `baselineCommits` is what every repository of the assignment starts with,
 * subtracted so the count is the student's own work. **Deliberately not the
 * original's formula.** `AssignmentRepoable#number_of_commits`
 * (app/models/concerns/assignment_repoable.rb:39) subtracts the *starter code
 * repository's* commit count, which is right only on its importer path, where
 * the starter's history is copied into the student's repo. This port always
 * generates from a template (`POST /repos/.../generate`, no
 * `include_all_branches`), and GitHub squashes a template into a single
 * "Initial commit" whatever its history is — measured on TA050: a starter of
 * 2 commits produces a student repo of exactly 1. Subtracting the starter's 2
 * would have given -1. So the baseline is 1 with starter code and 0 without.
 */
export async function listRepositorySnapshots(
  installationId: number,
  wanted: Iterable<number>,
  baselineCommits = 0,
): Promise<Map<number, RepositorySnapshot>> {
  const ids = [...new Set(wanted)]
  const snapshots = new Map<number, RepositorySnapshot>()
  if (ids.length === 0) return snapshots

  const octokit = installationClient(installationId)

  const batches: number[][] = []
  for (let index = 0; index < ids.length; index += SNAPSHOT_BATCH) {
    batches.push(ids.slice(index, index + SNAPSHOT_BATCH))
  }

  await Promise.all(
    batches.map(async (batch) => {
      let nodes: SnapshotNode[]

      try {
        const data = await octokit.graphql<{ nodes: SnapshotNode[] }>(SNAPSHOT_QUERY, {
          ids: batch.map(repositoryNodeId),
        })
        nodes = data.nodes
      } catch (error) {
        // A deleted repository makes the whole batch an error, but GitHub still
        // returns every other node. Anything else — the org vanished, the App
        // lost access — leaves the batch out, which the callers already read as
        // unreachable.
        nodes = partialNodes(error)
      }

      for (const node of nodes) {
        if (!node?.databaseId) continue

        const commit = node.defaultBranchRef?.target
        // Clamped: a student who rewrites history can leave fewer commits than
        // the repository was born with, and a negative count means nothing
        const commitCount = Math.max(0, (commit?.history?.totalCount ?? 0) - baselineCommits)

        snapshots.set(node.databaseId, {
          id: node.databaseId,
          fullName: node.nameWithOwner,
          htmlUrl: node.url,
          latestCommitAt: commit?.committedDate ? new Date(commit.committedDate) : null,
          commitCount,
        })
      }
    }),
  )

  return snapshots
}

/** The nodes a GraphqlResponseError still carries alongside its errors */
function partialNodes(error: unknown): SnapshotNode[] {
  const nodes = (error as { data?: { nodes?: SnapshotNode[] } })?.data?.nodes
  return Array.isArray(nodes) ? nodes : []
}

/**
 * Port of GitHubRepository#empty?.
 *
 * Like the original, an API error counts as empty: `rescue GitHub::Error;
 * return true`. GitHub answers 404 to the contents of a repo with no commits,
 * so the error *is* the signal here rather than a failure to interpret.
 */
export async function isRepositoryEmpty(
  installationId: number,
  fullName: string,
): Promise<boolean> {
  const [owner, repo] = fullName.split('/')

  try {
    const { data } = await installationClient(installationId).rest.repos.getContent({
      owner,
      repo,
      path: '',
    })
    return Array.isArray(data) && data.length === 0
  } catch {
    return true
  }
}
