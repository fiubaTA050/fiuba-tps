import type { Session } from 'next-auth'

import { userClient } from '@/lib/github/client'
import type { GitHubRepository } from '@/lib/github/repositories'

/**
 * Port of lib/github/search.rb.
 *
 * Like the original this runs on the **teacher's** token, not an installation
 * token: what they can pick as starter code should be what they can see. That
 * a GitHub App's user-to-server token can still do this was measured, not
 * assumed — it returns all of public GitHub plus the private repos the teacher
 * reaches, slightly more than an anonymous search rather than less.
 */

/** The original's default options, unchanged */
const PER_PAGE = 10

/**
 * Port of GitHub::Search#build_github_repositories_query.
 *
 *   keyword = query.gsub(%r{^#{REPOSITORY_REGEX}\/}, "") + " in:name fork:true"
 *   return keyword unless query.include?("/")
 *   "#{keyword} user:#{query.split("/").first}"
 *
 * With `template:true` added: the source importer is gone, so a repo that is
 * not a template cannot be used as starter code and offering it would only
 * produce a rejection on submit. GitHub applies the qualifier server-side —
 * `is:template` is silently ignored, `template:true` is the one that filters.
 */
export function buildRepositoryQuery(input: string): string {
  const keyword = `${input.replace(/^[^/]*\//, '')} in:name fork:true template:true`
  if (!input.includes('/')) return keyword

  return `${keyword} user:${input.split('/')[0]}`
}

/**
 * Port of GitHub::Search#search_github_repositories.
 *
 * Returns the message instead of raising, like the original's `[results,
 * error_message]` pair: a failed search should grey out the dropdown, never
 * break the form.
 */
export async function searchTemplateRepositories(
  session: Session,
  query: string,
): Promise<{ repositories: GitHubRepository[]; error: string | null }> {
  if (query.trim().length === 0) return { repositories: [], error: null }

  try {
    const { data } = await userClient(session).rest.search.repos({
      q: buildRepositoryQuery(query.trim()),
      sort: 'updated',
      per_page: PER_PAGE,
    })

    return {
      repositories: data.items.map((item) => ({
        id: item.id,
        fullName: item.full_name,
        htmlUrl: item.html_url,
        private: item.private,
        // Search results carry it, so confirming a hit is a template costs no
        // extra request — the reason the filtering above is affordable at all.
        isTemplate: item.is_template ?? false,
        // Only ever a starter code candidate, where the branch is not read
        defaultBranch: item.default_branch,
      })),
      error: null,
    }
  } catch (error) {
    // The search API allows 30 requests a minute, well below the rest, and a
    // classroom full of teachers typing can reach it. Saying so is more useful
    // than an empty dropdown.
    const status = (error as { status?: number }).status
    return {
      repositories: [],
      error:
        status === 403
          ? 'GitHub está limitando las búsquedas. Esperá unos segundos.'
          : 'No pudimos buscar en GitHub. Escribí owner/nombre.',
    }
  }
}
