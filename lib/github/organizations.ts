import { redirect } from 'next/navigation'
import type { Session } from 'next-auth'
import { cache } from 'react'

import { appClient, installationClient, userClient } from '@/lib/github/client'

function isUnauthorized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 401
}

/**
 * A GitHub org where the App is installed, without asking about anybody's
 * role in it. This is all the student's screens ever need.
 */
export type GitHubOrganizationAccount = {
  githubId: number
  login: string
  name: string | null
  avatarUrl: string
  installationId: number
}

/** The same org, resolved against one user. */
export type GitHubOrganization = GitHubOrganizationAccount & {
  /** Port of GitHubOrganization#admin? */
  admin: boolean
}

/**
 * Port of OrganizationsController#set_users_github_organizations.
 *
 * The original listed `current_user.github_user.organization_memberships`:
 * every org the user belongs to, tagged with the role. Here the source is
 * `GET /user/installations`, so the list already comes restricted to the orgs
 * where the App is installed — which is exactly the condition of step 3 of
 * the flow. Orgs without the App do not show up, and you reach them through
 * the "Instalar en otra organización" button.
 *
 * Requires the user's token to be user-to-server (GitHub App OAuth).
 */
export async function listUserOrganizations(session: Session): Promise<GitHubOrganization[]> {
  const octokit = userClient(session)

  let installations
  try {
    installations = await octokit.paginate(octokit.rest.apps.listInstallationsForAuthenticatedUser, {
      per_page: 100,
    })
  } catch (error) {
    // The teacher's token can die without expiring: revoking the App from
    // GitHub is enough. Without this the 401 surfaces as a 500 and the screen
    // is left with no way back to the login.
    if (isUnauthorized(error)) redirect('/?reauth=1')
    throw error
  }

  const organizations = installations.filter(
    (installation) =>
      installation.account &&
      'login' in installation.account &&
      // `GET /user/installations` also returns the installation on the
      // teacher's personal account. It cannot be a classroom, and if listed,
      // getMembershipForUser would 404 and the card would read "not owner".
      installation.account.type === 'Organization',
  )

  // The admin check uses the installation token, not the user's: that way we
  // do not depend on the teacher's token having org permissions.
  return Promise.all(
    organizations.map(async (installation) => {
      const account = installation.account as {
        id: number
        login: string
        name?: string | null
        avatar_url: string
      }

      return {
        githubId: account.id,
        login: account.login,
        name: account.name ?? null,
        avatarUrl: account.avatar_url,
        installationId: installation.id,
        admin: await isOrganizationAdmin(installation.id, account.login, session.user.githubLogin),
      }
    }),
  )
}

/**
 * Data for the org behind one specific installation, without walking all of
 * them. It goes through the App-level API (JWT), so it does not depend on the
 * teacher's token. Returns null if the installation no longer exists — the
 * original's NullGitHubOrganization pattern.
 *
 * Memoised per request: the classroom shell renders in the layout and every
 * page under it renders again, and each call is two GitHub round trips. The
 * arguments are primitives, which is what makes React's cache hit — it
 * compares them by identity, and `auth()` returns a fresh session object every
 * time, so keying on the session would never dedupe.
 */
export const findOrganizationByInstallation = cache(async function findOrganizationByInstallation(
  installationId: number,
  userLogin: string,
): Promise<GitHubOrganization | null> {
  const account = await findInstallationAccount(installationId)
  if (!account) return null

  return { ...account, admin: await isOrganizationAdmin(installationId, account.login, userLogin) }
})

/**
 * The same lookup with the role question left out, for the screens that only
 * name the organization.
 *
 * It matters on the student's invitation pages: `isOrganizationAdmin` is a
 * second round trip, and for a student it is one that 404s — they are not a
 * member of the org yet, and will not be until a repository exists. Asking
 * would spend a call per page view to compute a flag nothing reads, and bury
 * the log in 404s that mean nothing.
 */
export const findInstallationAccount = cache(async function findInstallationAccount(
  installationId: number,
): Promise<GitHubOrganizationAccount | null> {
  try {
    const { data: installation } = await appClient().rest.apps.getInstallation({
      installation_id: installationId,
    })

    const account = installation.account
    if (!account || !('login' in account) || account.type !== 'Organization') return null

    return {
      githubId: account.id,
      login: account.login,
      name: account.name ?? null,
      avatarUrl: account.avatar_url,
      installationId,
    }
  } catch {
    return null
  }
})

/**
 * Port of GitHubOrganization#admin?:
 *
 *   membership.role == "admin" && membership.state == "active"
 *
 * Like the original, any API error is read as "not an admin" instead of
 * propagating: a 404 here means they are not a member.
 */
export async function isOrganizationAdmin(
  installationId: number,
  orgLogin: string,
  userLogin: string,
): Promise<boolean> {
  try {
    const { data: membership } = await installationClient(
      installationId,
    ).rest.orgs.getMembershipForUser({ org: orgLogin, username: userLogin })

    return membership.role === 'admin' && membership.state === 'active'
  } catch {
    return false
  }
}

/**
 * Port of Organization::Creator#update_default_repository_permission_to_none!
 *
 * "Set the default repository permission so that students don't accidentally
 * see other repos." If this fails, the original aborts creating the
 * classroom; so does this. Requires the Organization → Administration: write
 * permission on the App.
 */
export async function setDefaultRepositoryPermissionToNone(
  installationId: number,
  orgLogin: string,
): Promise<void> {
  await installationClient(installationId).rest.orgs.update({
    org: orgLogin,
    default_repository_permission: 'none',
  })
}
