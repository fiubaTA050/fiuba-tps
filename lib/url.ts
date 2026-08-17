import 'server-only'

import { headers } from 'next/headers'

/**
 * Port of Rails' `request.base_url`, which InvitationHelper used to build the
 * invitation URL a teacher copies.
 *
 * Read from the request rather than from an env var on purpose: every Vercel
 * preview deployment answers on its own host, and a link that points at
 * production from a preview is worse than no link.
 */
export async function baseUrl(): Promise<string> {
  const requestHeaders = await headers()

  // Vercel terminates TLS at the edge, so the app itself always speaks http.
  // The x-forwarded-* pair is what carries the outside-facing values.
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? 'localhost'
  const protocol = requestHeaders.get('x-forwarded-proto') ?? 'http'

  return `${protocol}://${host}`
}

/** Which of the two invitation flows a link belongs to */
export type InvitationKind = 'assignment' | 'group-assignment'

/** The short path of each, from the original's routes.rb:31-32 */
const SHORT_PATH: Record<InvitationKind, string> = {
  assignment: 'a',
  'group-assignment': 'g',
}

/**
 * Port of `InvitationHelper#invitation_url`, this time including the branch
 * the first pass left out.
 *
 * The teacher copies the short form — `<host>/a/iS5bOvnY` — because it is what
 * gets dictated out loud, pasted into a slide and typed by hand off a
 * projector. The long key stays the canonical one: `/a/:short_key` only looks
 * the invitation up and redirects to it, exactly as `ShortUrlController` does,
 * so every link already handed out keeps working.
 *
 * Falls back to the long form when there is no short key, which is the case
 * for every invitation created before this existed —
 * `InvitationHelper#invitation_key` has the same fallback.
 */
export function invitationUrl(
  origin: string,
  kind: InvitationKind,
  invitation: { invitationKey: string; invitationShortKey: string | null },
): string {
  if (invitation.invitationShortKey) {
    return `${origin}/${SHORT_PATH[kind]}/${invitation.invitationShortKey}`
  }

  return `${origin}/${kind}-invitations/${invitation.invitationKey}`
}
