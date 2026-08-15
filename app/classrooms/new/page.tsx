import { LightBulbIcon } from '@primer/octicons-react'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { appInstallationUrl } from '@/lib/github/client'
import { listUserOrganizations } from '@/lib/github/organizations'
import { PageContainer } from '@/components/PageContainer'
import { isUsableSession } from '@/lib/session'

import { NewClassroomForm } from './NewClassroomForm'

export const dynamic = 'force-dynamic'

/** Port of organizations#new */
export default async function NewClassroomPage() {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const organizations = await listUserOrganizations(session)
  const installUrl = appInstallationUrl('/classrooms/new')

  return (
    <PageContainer>
      <div className="Subhead Subhead--spacious">
        <h1 className="Subhead-heading">Nuevo classroom</h1>
      </div>

      {organizations.length === 0 ? (
        // Port of the "no_organizations" blankslate. The original asked the
        // teacher to authorize the OAuth App; here the App must be installed.
        <div className="blankslate blankslate-large blankslate-spacious">
          <h3 className="mb-2">Todavía no instalaste la App en ninguna organización</h3>
          <p className="color-fg-muted mb-4">
            Para crear un classroom hay que instalar FIUBA Classroom en la organización de GitHub
            de la materia. Necesitás ser owner de esa organización.
          </p>
          <a href={installUrl} className="btn btn-primary btn-large" role="button">
            Instalar en una organización
          </a>
        </div>
      ) : (
        <NewClassroomForm organizations={organizations} installUrl={installUrl} />
      )}

      <div className="protip color-fg-muted">
        <LightBulbIcon className="mr-1" />
        ¿No ves tu organización? Instalá la App ahí con{' '}
        <a href={installUrl}>Instalar en otra organización</a>. Sólo aparecen las organizaciones
        donde la App ya está instalada.
      </div>
    </PageContainer>
  )
}
