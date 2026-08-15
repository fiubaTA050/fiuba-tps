import { installationClient } from '@/lib/github/client'

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
  id: number
  full_name: string
  html_url: string
  private: boolean
  is_template?: boolean | null
}): GitHubRepository {
  return {
    id: data.id,
    fullName: data.full_name,
    htmlUrl: data.html_url,
    private: data.private,
    isTemplate: data.is_template ?? false,
  }
}

/**
 * The org's own template repositories, to offer without making the teacher
 * type anything. No equivalent in the original, which only had the
 * Search-API autocomplete of `AutocompleteController`.
 *
 * That autocomplete does not survive the port: it ran on the teacher's OAuth
 * token, and a GitHub App's user-to-server token only sees resources the App
 * is installed on, so porting it verbatim would silently return a fraction of
 * what the original found. Listing the classroom's own org covers the usual
 * case, and `findRepositoryByFullName` covers everything else.
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
