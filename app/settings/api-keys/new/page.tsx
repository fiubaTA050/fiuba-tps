import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { isUsableSession } from '@/lib/session'
import { PageContainer } from '@/components/PageContainer'

import { NewApiKeyForm } from './NewApiKeyForm'

export const dynamic = 'force-dynamic'

/** Port of github.com/settings/personal-access-tokens/new, trimmed to the one
 * field this table has (label — no expiration, no scope picker, see
 * lib/data/api-keys.ts). "Generate new token" links here from the list. */
export default async function NewApiKeyPage() {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  return (
    <PageContainer>
      <div className="Subhead">
        <h1 className="Subhead-heading">Generar una nueva key</h1>
      </div>

      <NewApiKeyForm />
    </PageContainer>
  )
}
