/** What the invitation forms hand back to `useActionState`, mirroring the flashes */
export type InvitationActionState = {
  error: string | null
  notice: string | null
}

export const EMPTY_STATE: InvitationActionState = { error: null, notice: null }
