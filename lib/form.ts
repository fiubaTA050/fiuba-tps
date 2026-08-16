/**
 * Reads a FormData field that must hold a positive integer, such as a GitHub
 * id arriving from a hidden input.
 *
 * The raw value has to be checked, not just the parsed number: an unselected
 * hidden input arrives as "", and `Number("")` is 0, which passes
 * `Number.isInteger`.
 */
export function positiveInteger(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * A limit field: blank is "no limit", anything else goes through as typed.
 *
 * Deliberately not `positiveInteger`, which would turn a 0 into null and hand
 * the teacher a silent "no limit" instead of the message that says why 0 is not
 * a limit. `validateLimits` in the data layer is what rejects it.
 */
export function limitField(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

/** What the invitation forms hand back to `useActionState`, mirroring the flashes */
export type InvitationActionState = {
  error: string | null
  notice: string | null
}

export const EMPTY_STATE: InvitationActionState = { error: null, notice: null }
