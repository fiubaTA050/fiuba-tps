import { KeyIcon } from '@primer/octicons-react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { listApiKeys } from '@/lib/data/api-keys'
import { isUsableSession } from '@/lib/session'
import { PageContainer } from '@/components/PageContainer'

import { ApiKeyRow } from './ApiKeyRow'
import { REVEALED_KEY_COOKIE, type RevealedKey } from './state'

export const dynamic = 'force-dynamic'

/**
 * Not scoped to a classroom, unlike everything under app/classrooms/: a key
 * belongs to the user, and lets them reach whichever classrooms they teach —
 * see lib/data/api-keys.ts.
 *
 * No equivalent in the original or the live classroom.github.com — the layout
 * (title + "Generate new token" in the Subhead-actions corner, a Box of rows
 * each with an icon, a title and a muted metadata line, the freshly created
 * one expanded with its raw value) instead follows
 * github.com/settings/personal-access-tokens, GitHub's own closest screen.
 */
export default async function ApiKeysPage() {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const apiKeys = await listApiKeys(session)

  const flash = (await cookies()).get(REVEALED_KEY_COOKIE)?.value
  const revealed: RevealedKey | null = flash ? JSON.parse(flash) : null

  return (
    <PageContainer>
      <div className="Subhead">
        <h1 className="Subhead-heading">API keys</h1>
        {apiKeys.length > 0 && (
          <div className="Subhead-actions">
            <Link href="/settings/api-keys/new" className="btn btn-sm">
              Generar key
            </Link>
          </div>
        )}
      </div>

      {apiKeys.length === 0 ? (
        // Port of the empty github.com/settings/personal-access-tokens: no
        // description paragraph and no Subhead button in this state either —
        // the blankslate carries both on its own.
        <div className="blankslate blankslate-large blankslate-spacious">
          <KeyIcon size={24} className="blankslate-icon" />
          <h3 className="mb-2">No generaste ninguna key todavía</h3>
          <p className="color-fg-muted mb-4">
            ¿Necesitás acceder a la API sin abrir el navegador? Generá una key para scripts o para
            el worker de corrección automática.
          </p>
          <Link href="/settings/api-keys/new" className="btn btn-primary btn-large">
            Generar key
          </Link>
        </div>
      ) : (
        <>
          <p className="color-fg-muted mb-3">
            Credenciales para acceder a la API sin iniciar sesión en el navegador — hoy las usa el
            worker de corrección automática.
          </p>

          <div className="Box">
            {apiKeys.map((apiKey) => (
              <ApiKeyRow
                key={apiKey.id}
                apiKey={apiKey}
                revealedKey={revealed?.id === apiKey.id ? revealed.rawKey : null}
              />
            ))}
          </div>
        </>
      )}
    </PageContainer>
  )
}
