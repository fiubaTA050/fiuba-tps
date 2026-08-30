import { PeopleIcon, StarIcon } from '@primer/octicons-react'
import Link from 'next/link'

/** Which tab the screen belongs to. The live site has four, this port has two */
export type ClassroomTab = 'assignments' | 'students'

/**
 * The classroom's tab bar, ported from the live classroom.github.com — see
 * ClassroomShell for why the archived Rails app is not the reference here.
 * Its markup, down to the `UnderlineNav-octicon` and the `Counter`:
 *
 *   <nav aria-label="Classroom menu" class="UnderlineNav">
 *     <ul class="UnderlineNav-body list-style-none">
 *       <li class="d-inline-flex">
 *         <a class="UnderlineNav-item" aria-current="page">…<span class="Counter">3</span></a>
 *
 * Two of the four tabs are missing: "TAs and Admins" and "Settings" have
 * nothing behind them in this port, and a tab that leads nowhere is worse than
 * no tab.
 */
export function ClassroomNav({
  slug,
  tab,
  assignmentCount,
  studentCount,
}: {
  slug: string
  tab: ClassroomTab
  assignmentCount: number
  /** null when the classroom has no roster yet: the tab shows no counter */
  studentCount: number | null
}) {
  const base = `/classrooms/${slug}`

  return (
    <nav aria-label="Menú del classroom" className="UnderlineNav">
      <ul className="UnderlineNav-body list-style-none">
        <li className="d-inline-flex">
          {/* `aria-current` is what paints the underline, not a class */}
          <Link
            href={base}
            className="UnderlineNav-item"
            aria-current={tab === 'assignments' ? 'page' : undefined}
          >
            <StarIcon className="UnderlineNav-octicon" />
            <span>Trabajos prácticos</span>
            <span title={String(assignmentCount)} className="Counter">
              {assignmentCount}
            </span>
          </Link>
        </li>

        <li className="d-inline-flex">
          <Link
            href={`${base}/roster`}
            className="UnderlineNav-item"
            aria-current={tab === 'students' ? 'page' : undefined}
          >
            <PeopleIcon className="UnderlineNav-octicon" />
            <span>Alumnos</span>
            {studentCount !== null && (
              <span title={String(studentCount)} className="Counter">
                {studentCount}
              </span>
            )}
          </Link>
        </li>
      </ul>
    </nav>
  )
}
