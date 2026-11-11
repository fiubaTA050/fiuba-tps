'use server'

import { randomUUID } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { EMPTY_STATE, type RosterActionState } from '@/app/classrooms/[slug]/roster/state'
import { addTeachingAssistant, removeTeachingAssistant } from '@/lib/data/teaching-assistants'
import { positiveInteger } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

/**
 * The actions of the "Docentes" tab. The original has one, `remove_user`, for
 * its teachers; here teachers are managed on github.com and these act on the
 * teaching assistants. See docs/teaching-assistants.md.
 */

/** "Agregar ayudante" */
export async function addTeachingAssistantAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const result = await addTeachingAssistant(
    session,
    classroomSlug,
    String(formData.get('login') ?? ''),
  )

  if (!result.success) return { error: result.error, notice: null }

  // The tab's counter lives in the shell, on every page of the classroom
  revalidatePath(`/classrooms/${classroomSlug}`, 'layout')
  return {
    error: null,
    notice: `@${result.login} ahora es ayudante del classroom.`,
    // Tells the form to empty its field, even for two notices in a row
    submission: randomUUID(),
  }
}

/** "Sacar", from the confirmation dialog of one TA */
export async function removeTeachingAssistantAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const teachingAssistantId = positiveInteger(formData.get('teaching_assistant_id'))
  if (teachingAssistantId === null) {
    return { error: 'Ese ayudante ya no está en el classroom.', notice: null }
  }

  const result = await removeTeachingAssistant(session, classroomSlug, teachingAssistantId)
  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}`, 'layout')
  return EMPTY_STATE
}
