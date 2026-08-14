import Link from 'next/link'

import { auth, signIn, signOut } from '@/auth'
import { isUsableSession } from '@/lib/session'

/** Port of app/views/shared/_header.html.erb */
export async function SiteHeader() {
  const session = await auth()
  const loggedIn = isUsableSession(session)

  return (
    <header className="site-header">
      <div className="container-lg d-md-flex flex-items-center flex-justify-between p-responsive py-3">
        <Link
          href={loggedIn ? '/classrooms' : '/'}
          className="site-title d-block text-center mb-2 mb-md-0"
        >
          FIUBA Classroom
        </Link>

        <nav className="site-nav d-sm-flex flex-wrap flex-content-start flex-justify-center">
          <ul className="list-style-none d-flex flex-justify-center flex-items-center">
            {loggedIn ? (
              <li className="ml-3">
                <details className="dropdown details-reset details-overlay d-inline-block">
                  <summary aria-haspopup="true" className="d-flex flex-items-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={session.user.image ?? ''}
                      className="avatar"
                      alt={`@${session.user.githubLogin}`}
                      height={20}
                      width={20}
                    />
                    <div className="dropdown-caret ml-1" />
                  </summary>

                  <div role="menu" className="dropdown-menu dropdown-menu-sw mt-2" style={{ width: 180 }}>
                    <span className="dropdown-item" role="menuitem">
                      Sesión iniciada como
                      <strong className="d-block">{session.user.githubLogin}</strong>
                    </span>

                    <div role="none" className="dropdown-divider" />

                    <Link href="/classrooms" className="dropdown-item" role="menuitem">
                      Tus classrooms
                    </Link>

                    <div role="none" className="dropdown-divider" />

                    <form
                      action={async () => {
                        'use server'
                        await signOut({ redirectTo: '/' })
                      }}
                    >
                      <button type="submit" className="dropdown-item btn-link" role="menuitem">
                        Cerrar sesión
                      </button>
                    </form>
                  </div>
                </details>
              </li>
            ) : (
              <li className="ml-3">
                <form
                  action={async () => {
                    'use server'
                    await signIn('github', { redirectTo: '/classrooms' })
                  }}
                >
                  <button type="submit" className="btn-link">
                    Iniciar sesión
                  </button>
                </form>
              </li>
            )}
          </ul>
        </nav>
      </div>
    </header>
  )
}
