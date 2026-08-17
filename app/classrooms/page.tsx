import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { listClassrooms } from '@/lib/data/organizations'
import { PageContainer } from '@/components/PageContainer'
import { isUsableSession } from '@/lib/session'

import { ClassroomList } from './ClassroomList'

export const dynamic = 'force-dynamic'

/** Port of organizations#index + _organization_card_layout.html.erb */
export default async function ClassroomsPage() {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classrooms = await listClassrooms(session)

  if (classrooms.length === 0) {
    return (
      <PageContainer>
        <div className="blankslate blankslate-large blankslate-spacious">
          <h3 className="mb-2">Todavía no tenés classrooms</h3>
          <p className="color-fg-muted mb-4">
            Un classroom es una organización de GitHub donde viven los repos de la materia.
          </p>
          <Link href="/classrooms/new" className="btn btn-primary btn-large" role="button">
            Crear tu primer classroom
          </Link>
        </div>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <h1 className="mt-3 mb-3">Tus classrooms</h1>
      <ClassroomList classrooms={classrooms} />
    </PageContainer>
  )
}
