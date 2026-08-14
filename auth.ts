import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import { eq } from 'drizzle-orm'

import { users } from '@/db/schema'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

/**
 * Port of SessionsController#create + User#assign_from_auth_hash.
 *
 * Unlike the original, the OAuth token is never stored (DA-6): it lives in the
 * session JWT cookie. `users` holds identity only.
 *
 * client_id/secret belong to the **GitHub App**, not a separate OAuth App.
 * That makes the user token a user-to-server token, which is what enables
 * `GET /user/installations`. See README.
 */

/** GitHub App user-to-server tokens expire after 8 h */
async function refreshAccessToken(refreshToken: string) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  const data = await response.json()
  if (!response.ok || data.error) {
    throw new Error(data.error_description ?? 'GitHub token refresh failed')
  }

  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 28800),
  }
}

// Lazy config: `next build` imports this module to collect routes, with no
// credentials set. The `env` getters run on the first request instead.
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  providers: [
    GitHub({
      clientId: env.githubClientId,
      clientSecret: env.githubClientSecret,
    }),
  ],

  session: { strategy: 'jwt' },

  pages: { signIn: '/', error: '/' },

  callbacks: {
    /** User.find_by_auth_hash || User.new, then assign_from_auth_hash */
    async signIn({ profile }) {
      if (!profile?.id) return false

      const values = {
        uid: Number(profile.id),
        githubLogin: profile.login as string,
        githubName: (profile.name as string | null) ?? null,
        githubAvatarUrl: (profile.avatar_url as string | null) ?? null,
        githubHtmlUrl: (profile.html_url as string | null) ?? null,
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      }

      await db
        .insert(users)
        .values(values)
        .onConflictDoUpdate({ target: users.uid, set: values })

      return true
    },

    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token
        token.refreshToken = account.refresh_token
        token.expiresAt = account.expires_at
        token.githubLogin = profile?.login as string
        token.uid = Number(profile?.id)

        const [row] = await db.select({ id: users.id }).from(users).where(eq(users.uid, token.uid))
        token.userId = row?.id
      }

      // No declared expiry means the App has "Expire user authorization
      // tokens" turned off, so there is nothing to refresh.
      if (typeof token.expiresAt !== 'number') return token

      // 60 s of slack so we never hand out a token that expires mid-flight
      if (Date.now() < (token.expiresAt - 60) * 1000) return token

      if (typeof token.refreshToken !== 'string') {
        return { ...token, error: 'RefreshFailed' as const }
      }

      try {
        const refreshed = await refreshAccessToken(token.refreshToken)
        return { ...token, ...refreshed, error: undefined }
      } catch {
        // The UI treats `error` as an unusable session and forces re-login
        return { ...token, error: 'RefreshFailed' as const }
      }
    },

    async session({ session, token }) {
      session.accessToken = token.accessToken as string
      session.user.uid = token.uid as number
      session.user.githubLogin = token.githubLogin as string

      // Without `userId` there is nobody to attribute classrooms to. Coercing
      // it yields user_id = 0: `listClassrooms` would return empty as if the
      // teacher had none, and INSERTs would violate the foreign key. Fail
      // closed and let the UI force a re-login.
      if (typeof token.userId !== 'number') {
        session.user.id = ''
        session.error = 'InvalidSession'
        return session
      }

      session.user.id = String(token.userId)
      session.error = token.error
      return session
    },
  },
}))
