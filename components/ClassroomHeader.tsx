import { AlertIcon } from '@primer/octicons-react'
import Link from 'next/link'

import type { ClassroomListItem } from '@/lib/data/organizations'

/**
 * Port of organizations/_organization_banner.html.erb.
 *
 * The original painted it as a full-width banner with a GeoPattern background
 * generated from the classroom title; here it is the page's Subhead, so the
 * classroom pages keep the same shape as the rest of the port. The counters
 * the banner carried (individual and group assignments) are left out until
 * group assignments exist to count.
 *
 * `linked` is false on the classroom's own page: linking a heading to the page
 * you are already on is noise.
 */
export function ClassroomHeader({
  classroom,
  linked = true,
}: {
  classroom: ClassroomListItem
  linked?: boolean
}) {
  return (
    <div className="Subhead Subhead--spacious">
      <div className="d-flex flex-items-center flex-auto">
        {classroom.organization ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={classroom.organization.avatarUrl}
            className="avatar mr-3"
            height={48}
            width={48}
            alt={`@${classroom.organization.login}`}
          />
        ) : (
          <span className="color-fg-attention mr-3">
            <AlertIcon size={32} />
          </span>
        )}

        <div>
          <h1 className="Subhead-heading">
            {linked ? (
              <Link href={`/classrooms/${classroom.slug}`}>{classroom.title}</Link>
            ) : (
              classroom.title
            )}
          </h1>
          {/* DA-2: the org login comes from GitHub, it is not stored */}
          <p className="color-fg-muted mb-0">
            {classroom.organization ? (
              <a href={`https://github.com/${classroom.organization.login}`}>
                @{classroom.organization.login}
              </a>
            ) : (
              'Organización inaccesible'
            )}
          </p>
        </div>
      </div>

      {classroom.archivedAt && (
        <div className="Subhead-actions">
          <span className="Label Label--gray">Archivado</span>
        </div>
      )}
    </div>
  )
}
