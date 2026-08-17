import { AlertIcon } from '@primer/octicons-react'
import Link from 'next/link'
import type { Session } from 'next-auth'

import { Breadcrumb } from '@/components/Breadcrumb'
import { ClassroomNav, type ClassroomTab } from '@/components/ClassroomNav'
import { countAssignments } from '@/lib/data/assignments'
import type { ClassroomListItem } from '@/lib/data/organizations'
import { rosterSummary } from '@/lib/data/rosters'

/**
 * The frame around a classroom screen: breadcrumb, title band, tabs.
 *
 * This is where the port stops following the archived Rails app. There a
 * classroom was topped by a full-width GeoPattern banner
 * (`organizations/_organization_banner.html.erb`) and navigated through a side
 * menu; the live classroom.github.com replaced both with this, and it is the
 * UI the cátedra uses every day. The markup is its markup — the
 * `color-bg-subtle border-bottom` band, `container-lg p-responsive` — taken
 * from a saved copy of the Assignments dashboard.
 *
 * Composed by each page rather than being a layout, because not every screen
 * under a classroom wears it: the new-assignment page carries only the
 * breadcrumb, exactly as the live site does. A layout applies to its whole
 * subtree and cannot opt one route out.
 */
export async function ClassroomShell({
  session,
  classroom,
  tab,
  children,
}: {
  session: Session
  classroom: ClassroomListItem
  tab: ClassroomTab
  children: React.ReactNode
}) {
  // Both are indexed counts, and `findClassroom` — the expensive part of the
  // page, two GitHub calls — is already memoised per request
  const [assignmentCount, roster] = await Promise.all([
    countAssignments(session, classroom.slug),
    rosterSummary(session, classroom.slug),
  ])

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'Classrooms', href: '/classrooms' },
          { label: classroom.title, href: `/classrooms/${classroom.slug}` },
        ]}
      />

      <div className="color-bg-subtle border-bottom">
        <div className="p-responsive">
          <div className="pt-3 pt-md-4">
            <div className="container-lg">
              {/* Title and the org login under it, nothing else: the live band
                  carries no avatar, and the archived GeoPattern banner it
                  replaced is not coming back either */}
              <h1 className="d-flex flex-items-center">
                <Link
                  href={`/classrooms/${classroom.slug}`}
                  className="color-fg-default no-underline"
                >
                  {classroom.title}
                </Link>
                {classroom.archivedAt && <span className="Label Label--gray ml-2">Archivado</span>}
              </h1>
              {/* DA-2: the login comes from GitHub at render time */}
              <p className="f5 pb-1 mb-0">
                {classroom.organization ? (
                  <a
                    className="color-fg-muted no-underline"
                    href={`https://github.com/${classroom.organization.login}`}
                  >
                    {classroom.organization.login}
                  </a>
                ) : (
                  <span className="color-fg-attention d-inline-flex flex-items-center">
                    <AlertIcon className="mr-1" />
                    Organización inaccesible
                  </span>
                )}
              </p>
            </div>

            <div className="container-lg mt-3 position-relative">
              <ClassroomNav
                slug={classroom.slug}
                tab={tab}
                assignmentCount={assignmentCount}
                studentCount={roster?.count ?? null}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="container-lg p-responsive py-4">{children}</div>
    </>
  )
}
