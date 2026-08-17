import { notFound, redirect } from 'next/navigation'

import { findKeyByShortKey } from '@/lib/data/invitations'

/**
 * Port of `ShortUrlController#assignment_invitation` and of the
 * `get "/a/:short_key"` route.
 *
 * Looks the invitation up and redirects to the canonical path, so the short
 * link is only an alias: everything after it — the session, the roster, the
 * repository — is the flow that was already there.
 *
 * `skip_before_action :authenticate_user!` in the original, and the same here:
 * this runs before the student has signed in, which is the whole point.
 */
export async function GET(_request: Request, context: RouteContext<'/a/[shortKey]'>) {
  const { shortKey } = await context.params
  const key = await findKeyByShortKey(shortKey)

  // `not_found unless invitation`
  if (!key) notFound()

  redirect(`/assignment-invitations/${key}`)
}
