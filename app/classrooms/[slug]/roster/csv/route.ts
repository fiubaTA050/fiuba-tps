import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { rosterCsv } from '@/lib/data/rosters'
import { isUsableSession } from '@/lib/session'

/**
 * Port of RostersController#download_roster, which the original reached as
 * `format.csv` of #show and answered with `send_data`.
 *
 * Divergence: the file is named after the classroom instead of the original's
 * fixed `classroom_roster.csv`, so a teacher downloading two of them does not
 * end up with `classroom_roster (1).csv`. The `grouping` parameter is not here
 * — it added a `group_name` column that only group assignments fill in.
 */
export async function GET(_request: Request, context: RouteContext<'/classrooms/[slug]/roster/csv'>) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const { slug } = await context.params
  const csv = await rosterCsv(session, slug)

  // Not the teacher's classroom, or it has no roster
  if (csv === null) notFound()

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}-roster.csv"`,
    },
  })
}
