/**
 * The shape every roster form's `useActionState` carries.
 *
 * Its own module rather than actions.ts: a "use server" file may only export
 * async functions, so `EMPTY_STATE` living there fails at runtime, when the
 * form posts.
 */
export type RosterActionState = {
  error: string | null
  notice: string | null
  /**
   * Identifies the submission the notice came from. The add-students form
   * empties its textarea when this changes, and two identical notices in a row
   * ("Alumno agregado." twice) still count as two.
   */
  submission?: string
}

export const EMPTY_STATE: RosterActionState = { error: null, notice: null }
