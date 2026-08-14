import 'next-auth'
import 'next-auth/jwt'

/**
 * - RefreshFailed:  no se pudo renovar el token OAuth
 * - InvalidSession: el JWT no tiene el id de `users` (fila borrada, o el
 *                   profile de GitHub no trajo id)
 * - TokenRevoked:   GitHub rechazó el token (el docente revocó la App)
 */
type SessionError = 'RefreshFailed' | 'InvalidSession' | 'TokenRevoked'

declare module 'next-auth' {
  interface Session {
    /** Token OAuth user-to-server. No se persiste: vive en la cookie de sesión */
    accessToken: string
    /** Presente cuando la sesión no sirve para operar; la UI fuerza re-login */
    error?: SessionError
    user: {
      /** PK en la tabla `users` */
      id: string
      /** `users.uid` — el ID numérico de GitHub */
      uid: number
      githubLogin: string
    } & DefaultSession['user']
  }

  interface Profile {
    id: number
    login: string
    name: string | null
    avatar_url: string | null
    html_url: string | null
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    userId?: number
    uid?: number
    githubLogin?: string
    error?: SessionError
  }
}
