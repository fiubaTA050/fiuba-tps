import { AlertIcon } from '@primer/octicons-react'

import type { GitHubOrganizationAccount } from '@/lib/github/organizations'

/**
 * The frame of the student's screens. Port of `layouts/invitations.html.erb`
 * plus `organizations/_organization_invitation_banner.html.erb`.
 *
 * The student is not a teacher of anything, so this deliberately is *not*
 * `ClassroomShell`: no breadcrumb back to /classrooms, no tab bar, no counters
 * — every one of those leads somewhere a student is not allowed to go. The
 * original made the same distinction by giving the invitation controllers
 * their own layout, whose only chrome is the header and a band naming the
 * classroom.
 *
 * The band is the one from ClassroomShell rather than the original's
 * GeoPattern banner, for the same reason recorded there: the live
 * classroom.github.com dropped GeoPattern, and two different-looking bands in
 * one app would be worse than either.
 */
export function InvitationShell({
  classroomTitle,
  organization,
  children,
}: {
  classroomTitle: string
  /** null when the org is unreachable — the NullGitHubOrganization case */
  organization: GitHubOrganizationAccount | null
  children: React.ReactNode
}) {
  return (
    <>
      <div className="color-bg-subtle border-bottom">
        <div className="p-responsive">
          <div className="container-lg d-flex flex-items-center py-3 py-md-4">
            {organization ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={organization.avatarUrl}
                className="avatar mr-3"
                height={48}
                width={48}
                alt={`@${organization.login}`}
              />
            ) : (
              <span className="color-fg-attention mr-3">
                <AlertIcon size={32} />
              </span>
            )}

            <div>
              {/* Not a link: the classroom page is the teacher's, and a
                  student following it would get a 404 from findClassroom */}
              <h1>{classroomTitle}</h1>
              <p className="f5 pb-1 mb-0">
                {organization ? (
                  <a
                    className="color-fg-muted no-underline"
                    href={`https://github.com/${organization.login}`}
                  >
                    {organization.login}
                  </a>
                ) : (
                  <span className="color-fg-muted">Organización inaccesible</span>
                )}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="container-lg p-responsive py-4">{children}</div>
    </>
  )
}
