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
