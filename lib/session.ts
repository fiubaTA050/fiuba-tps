import type { Session } from 'next-auth'

/**
 * A session is usable only if it has a GitHub token, has the id of the `users`
 * row, and carries no error.
 *
 * Pages send you to `/` when this is false, and `/` only redirects to
 * `/classrooms` when it is true. That asymmetry is what avoids the loop: with
 * a revoked token the session exists but is not usable, so the landing shows
 * the re-login notice instead of bouncing straight back.
 */
export function isUsableSession(session: Session | null): session is Session {
  return Boolean(session && !session.error && session.user?.id)
}
