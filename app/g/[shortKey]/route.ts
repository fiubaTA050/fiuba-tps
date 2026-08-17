import { notFound, redirect } from 'next/navigation'

import { findKeyByShortKey } from '@/lib/data/group-invitations'

/** Port of `ShortUrlController#group_assignment_invitation`, `get "/g/:short_key"` */
export async function GET(_request: Request, context: RouteContext<'/g/[shortKey]'>) {
  const { shortKey } = await context.params
  const key = await findKeyByShortKey(shortKey)

  if (!key) notFound()

  redirect(`/group-assignment-invitations/${key}`)
}
