import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import type { Session } from 'next-auth'

import { env } from '@/lib/env'

/**
 * The two clients of DA-6's token model.
 *
 * The original had a single one: `Organization#github_client`, which took the
 * persisted OAuth token of a random teacher of the org. Here it is split in
 * two, and neither of the two tokens is stored.
 */

/**
 * Client with the signed-in user's token. Only to read who they are and which
 * installations they can see. Never for privileged operations.
 */
export function userClient(session: Session): Octokit {
  return new Octokit({ auth: session.accessToken })
}

/**
 * Octokit logs every 4xx as a warning. A 404 is an expected answer for the
 * callers that probe whether an installation or a membership still exists, and
 * letting those through buries real errors in the noise — which is how a real
 * auth failure went unnoticed in the dev log once already.
 */
const quietOn404 = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => {
    if (!message.includes(' - 404 ')) console.warn(message)
  },
  error: console.error,
}

/**
 * Client authenticated as the GitHub App (JWT signed with the private key).
 * For App-level endpoints, not for touching an org's resources.
 */
export function appClient(): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.githubAppId,
      privateKey: env.githubAppPrivateKey,
    },
    log: quietOn404,
  })
}

/**
 * One client per installation, reused.
 *
 * Octokit mints the installation token lazily and holds it until it is about
 * to expire — but only within one instance. Building a fresh one per call, as
 * this used to, meant a `POST /app/installations/:id/access_tokens` round trip
 * in front of *every* API call.
 *
 * That was measured, not guessed: the create-repo route makes four GitHub
 * calls and took 5.9 s, of which the token mints were the difference against
 * the ~3 s the calls themselves cost (docs/creacion-de-repos.md).
 *
 * Module scope rather than per request, on purpose — a warm serverless
 * instance should reuse the token across requests, which is the whole point.
 * The map is bounded by the number of orgs the App is installed on, and the
 * token never leaves the process: it is not written anywhere, which is what
 * DA-6 asks for.
 */
const clients = new Map<number, Octokit>()

/**
 * Client with an installation token. This is the one that does everything
 * privileged. Octokit signs the JWT and requests the token on demand; it
 * expires in 1 h and is not persisted anywhere.
 */
export function installationClient(installationId: number): Octokit {
  const cached = clients.get(installationId)
  if (cached) return cached

  const client = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.githubAppId,
      privateKey: env.githubAppPrivateKey,
      installationId,
    },
    // isOrganizationAdmin reads a 404 as "not a member", by design
    log: quietOn404,
  })

  clients.set(installationId, client)
  return client
}

/** Where we send the teacher to install the App on another org */
export function appInstallationUrl(state?: string): string {
  const url = new URL(`https://github.com/apps/${env.githubAppSlug}/installations/new`)
  if (state) url.searchParams.set('state', state)
  return url.toString()
}
