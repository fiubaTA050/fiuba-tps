import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMembershipForUser = vi.fn()

vi.mock('@/lib/github/client', () => ({
  installationClient: () => ({ rest: { orgs: { getMembershipForUser } } }),
  appClient: () => ({}),
  userClient: () => ({}),
  appInstallationUrl: () => '',
}))

const { isOrganizationAdmin } = await import('@/lib/github/organizations')

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Port of spec/models/github_organization_spec.rb "#admin?".
 *
 *   membership.role == "admin" && membership.state == "active"
 */
describe('isOrganizationAdmin', () => {
  it('verifies if the user is an admin of the organization', async () => {
    getMembershipForUser.mockResolvedValue({ data: { role: 'admin', state: 'active' } })
    expect(await isOrganizationAdmin(99, 'fiubaTA050-labs', 'eespina-fiuba')).toBe(true)
  })

  it('returns false for a plain member', async () => {
    getMembershipForUser.mockResolvedValue({ data: { role: 'member', state: 'active' } })
    expect(await isOrganizationAdmin(99, 'fiubaTA050-labs', 'eespina-fiuba')).toBe(false)
  })

  // An admin who never accepted the invitation cannot act on the org yet
  it('returns false for an admin whose membership is still pending', async () => {
    getMembershipForUser.mockResolvedValue({ data: { role: 'admin', state: 'pending' } })
    expect(await isOrganizationAdmin(99, 'fiubaTA050-labs', 'eespina-fiuba')).toBe(false)
  })

  // rescue GitHub::Error -> false. A 404 means they are not a member.
  it('returns false when the API errors, like the original rescue', async () => {
    getMembershipForUser.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }))
    expect(await isOrganizationAdmin(99, 'fiubaTA050-labs', 'nadie')).toBe(false)
  })
})
