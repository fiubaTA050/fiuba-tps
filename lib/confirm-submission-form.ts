import 'server-only'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import type { AssignmentKind } from '@/lib/assignment-paths'
import { confirmSubmission } from '@/lib/data/submissions'
import { positiveInteger, type InvitationActionState } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

/**
 * The body of both "Confirmar entrega" server actions, the student's and the
 * team's: they differ only in the invitation they hang under and in whose
 * entrega the notice says it was. See docs/entregas.md.
 *
 * Not a server action itself: those live in `'use server'` files, which may
 * only export async actions, and this one takes arguments a form cannot post.
 */
export async function confirmSubmissionFromForm(
  formData: FormData,
  kind: AssignmentKind,
): Promise<InvitationActionState> {
  const key = String(formData.get('key') ?? '')
  const invitationPath =
    kind === 'group' ? `/group-assignment-invitations/${key}` : `/assignment-invitations/${key}`

  const session = await auth()
  if (!isUsableSession(session)) redirect(invitationPath)

  const checkpointId = positiveInteger(formData.get('checkpoint_id'))
  if (checkpointId === null) {
    return { error: 'No encontramos esa entrega.', notice: null }
  }

  const result = await confirmSubmission(
    session,
    key,
    checkpointId,
    String(formData.get('ref') ?? ''),
    String(formData.get('ai_declaration') ?? ''),
    kind,
  )

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`${invitationPath}/setup`)

  if (result.unchanged) {
    return { error: null, notice: 'Esa entrega ya estaba confirmada: no cambió nada.' }
  }

  const confirmed = `${kind === 'group' ? 'Entrega del equipo confirmada' : 'Entrega confirmada'}: ${result.sha.slice(0, 7)}.`

  // The warning rides along with the confirmation rather than replacing it —
  // the entrega *was* recorded, and saying only the caveat reads as a failure
  return { error: null, notice: result.warning ? `${confirmed} ${result.warning}` : confirmed }
}
