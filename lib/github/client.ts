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
  })
}

/**
 * Client with an installation token. This is the one that does everything
 * privileged. Octokit signs the JWT and requests the token on demand; it
 * expires in 1 h and is not persisted anywhere.
 */
export function installationClient(installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.githubAppId,
      privateKey: env.githubAppPrivateKey,
      installationId,
    },
  })
}

/** Where we send the teacher to install the App on another org */
export function appInstallationUrl(state?: string): string {
  const url = new URL(`https://github.com/apps/${env.githubAppSlug}/installations/new`)
  if (state) url.searchParams.set('state', state)
  return url.toString()
}
