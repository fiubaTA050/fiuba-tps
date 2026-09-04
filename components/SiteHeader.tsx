import Link from 'next/link'

import { auth, signIn, signOut } from '@/auth'
import { isUsableSession } from '@/lib/session'

/**
 * Port of app/views/shared/_header.html.erb, following the live site's header
 * rather than the archived one, the same call the classroom shell makes: the
 * band is full-bleed (`full-width`, not a container), the mark sits on the very
 * left edge next to the wordmark, and the account menu is an avatar with no
 * caret over an `Overlay` + `ActionList` panel — not primer-dropdown.
 *
 * Divergence: the mark is the FIUBA seal instead of the GitHub logotype, and
 * the wordmark says "FIUBA Classroom" — the seal does not spell the faculty out
 * the way GitHub's mark does. The live header's "GitHub Education" link and its
 * Community discussion / Report a bug / Help items have nothing behind them
 * here and are left out.
 */
export async function SiteHeader() {
  const session = await auth()
  const loggedIn = isUsableSession(session)

  return (
    <header className="site-header">
      <div className="full-width d-md-flex flex-items-center flex-justify-between p-responsive">
        <Link
          href={loggedIn ? '/classrooms' : '/'}
          className="site-title d-flex flex-items-center flex-justify-center flex-md-justify-start mb-2 mb-md-0"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/fiuba.png" alt="" className="site-logo mr-3" height={32} width={32} />
          FIUBA Classroom
        </Link>

        <nav className="site-nav d-sm-flex flex-wrap flex-content-start flex-justify-center">
          <ul className="list-style-none d-flex flex-justify-center flex-items-center">
            {loggedIn ? (
              <li>
                <details className="dropdown details-reset details-overlay d-inline-block position-relative">
                  <summary
                    aria-haspopup="menu"
                    aria-label="Menú de la cuenta"
                    className="d-flex flex-items-center"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      // Never `?? ''`: an empty src makes the browser re-request
                      // the page itself as the image. The token does not always
                      // carry a picture, so fall back to the avatar derived from
                      // the numeric id — stable across renames, unlike the login.
                      src={session.user.image ?? `https://avatars.githubusercontent.com/u/${session.user.uid}`}
                      className="avatar circle"
                      alt={`@${session.user.githubLogin}`}
                      height={32}
                      width={32}
                    />
                  </summary>

                  <div className="ActionMenu-anchor ActionMenu-anchor--right">
                    <div className="Overlay Overlay--size-auto">
                      <div className="Overlay-body Overlay-body--paddingNone">
                        <ul role="menu" className="ActionListWrap ActionListWrap--inset">
                          <li className="ActionList-sectionDivider" role="presentation">
                            <div className="ActionList-sectionDivider-title">
                              Sesión iniciada como:
                            </div>
                            <span className="ActionListItem-description">
                              {session.user.githubLogin}
                            </span>
                          </li>

                          <li role="none" className="ActionListItem">
                            <a
                              href={`https://github.com/${session.user.githubLogin}`}
                              role="menuitem"
                              className="ActionListContent"
                            >
                              <span className="ActionListItem-label">Tu perfil</span>
                            </a>
                          </li>

                          <li role="none" className="ActionListItem">
                            <Link href="/classrooms" role="menuitem" className="ActionListContent">
                              <span className="ActionListItem-label">Tus classrooms</span>
                            </Link>
                          </li>

                          <li role="none" className="ActionListItem">
                            <Link
                              href="/settings/api-keys"
                              role="menuitem"
                              className="ActionListContent"
                            >
                              <span className="ActionListItem-label">API keys</span>
                            </Link>
                          </li>

                          {/* Empty: `.ActionList-sectionDivider:empty` is the hairline */}
                          <li role="presentation" aria-hidden className="ActionList-sectionDivider" />

                          <li role="none" className="ActionListItem">
                            <form
                              action={async () => {
                                'use server'
                                await signOut({ redirectTo: '/' })
                              }}
                            >
                              <button type="submit" role="menuitem" className="ActionListContent">
                                <span className="ActionListItem-label">Cerrar sesión</span>
                              </button>
                            </form>
                          </li>
                        </ul>
                      </div>
                    </div>
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
