import { MarkGithubIcon } from '@primer/octicons-react'
import { redirect } from 'next/navigation'

import { auth, signIn } from '@/auth'
import { isUsableSession } from '@/lib/session'

/**
 * Step 1: sign in with GitHub. Port of the pages#home blankslate.
 *
 * Only redirects when the session is usable. A revoked token leaves a session
 * that exists but cannot call GitHub, and bouncing it to /classrooms would
 * loop: that page sends it right back here.
 */
export default async function HomePage(props: PageProps<'/'>) {
  const session = await auth()
  const reauth = (await props.searchParams).reauth === '1'

  if (!reauth && isUsableSession(session)) redirect('/classrooms')

  return (
    <div className="blankslate blankslate-large blankslate-spacious">
      <h1 className="h1 mb-3">FIUBA Classroom</h1>
      <p className="f3 color-fg-muted mb-4">
        Gestión de trabajos prácticos sobre repositorios de GitHub.
      </p>

      {reauth && (
        <div className="flash flash-warn mb-4">
          Se cortó el acceso a GitHub. Puede que hayas revocado la App o que la sesión haya
          vencido: volvé a iniciar sesión.
        </div>
      )}

      <form
        action={async () => {
          'use server'
          await signIn('github', { redirectTo: '/classrooms' })
        }}
      >
        <button type="submit" className="btn btn-primary btn-large">
          <MarkGithubIcon className="mr-2" />
          Iniciar sesión con GitHub
        </button>
      </form>
    </div>
  )
}
