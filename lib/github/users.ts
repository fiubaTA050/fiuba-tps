import type { Session } from 'next-auth'

import { userClient } from '@/lib/github/client'
import { isNotFound } from '@/lib/github/repositories'

/** A GitHub account as `GET /users/{username}` describes it */
export type GitHubUserAccount = {
  /** The numeric id: what gets stored (DA-2) */
  id: number
  login: string
  name: string | null
  avatarUrl: string
  htmlUrl: string
}

/**
 * Looks an account up by login, to turn what a teacher types into the id
 * stored for a teaching assistant. Null when there is no such account, or it
 * is an organization or a bot rather than a person.
 *
 * Through the teacher's own token, not the classroom's installation: the
 * endpoint is public, so nothing privileged is asked of `userClient`, and a
 * stale `installation_id` would fail the token mint with a 404 that this
 * function would read as "no such account".
 */
export async function findGitHubUserByLogin(
  session: Session,
  login: string,
): Promise<GitHubUserAccount | null> {
  try {
    const { data } = await userClient(session).rest.users.getByUsername({ username: login })
    if (data.type !== 'User') return null

    return {
      id: data.id,
      login: data.login,
      name: data.name ?? null,
      avatarUrl: data.avatar_url,
      htmlUrl: data.html_url,
    }
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/**
 * The current login of an account, by its numeric id — `GET /user/{id}`, the
 * documented lookup that survives a rename. The collaborator endpoints only
 * take a login, and the one in `users` is only as fresh as the account's
 * last sign-in. Null when the account no longer exists.
 */
export async function findGitHubLoginById(
  session: Session,
  accountId: number,
): Promise<string | null> {
  try {
    const { data } = await userClient(session).request('GET /user/{account_id}', {
      account_id: accountId,
    })
    return data.login
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}
