'use server'

import { randomUUID } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import {
  addStudents,
  createRoster,
  deleteEntry,
  deleteRoster,
  linkAccountToEntry,
  renameEntry,
  unlinkAccountFromEntry,
} from '@/lib/data/rosters'
import { positiveInteger } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

import { EMPTY_STATE, type RosterActionState } from './state'

/**
 * Port of the actions of Orgs::RostersController.
 *
 * The original answered every one of them with a redirect back to the roster
 * and a flash. Here the mutating ones return the message to the form that sent
 * them — `useActionState` keeps it next to the input it belongs to — and only
 * the two that change which page you should be on redirect.
 */
/** Port of RostersController#create */
export async function createRosterAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')

  const result = await createRoster(session, classroomSlug, {
    identifierName: String(formData.get('identifier_name') ?? ''),
    identifiers: String(formData.get('identifiers') ?? ''),
  })

  // render :new — the form comes back with the message
  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}`)
  redirect(`/classrooms/${classroomSlug}/roster?created=1`)
}

/**
 * Port of RostersController#add_students, whose three outcomes the original
 * split across flash[:warning] and two different flash[:success] messages.
 */
export async function addStudentsAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')

  const result = await addStudents(session, classroomSlug, String(formData.get('identifiers') ?? ''))

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}/roster`)
  revalidatePath(`/classrooms/${classroomSlug}`)

  const submission = randomUUID()

  if (result.created === 0) {
    return { error: null, notice: 'No se agregó ningún alumno.', submission }
  }

  if (result.created < result.requested) {
    return {
      error: null,
      notice: `Se agregaron ${result.created} alumnos. Se omitieron los repetidos.`,
      submission,
    }
  }

  return {
    error: null,
    notice: result.created === 1 ? 'Alumno agregado.' : `Se agregaron ${result.created} alumnos.`,
    submission,
  }
}

/**
 * Port of RostersController#link, raised from the "Cuentas de GitHub sin
 * vincular" tab. The assignment dashboard raises the same controller action
 * and has its own copy, because its revalidation needs the assignment slug
 * this route knows nothing about.
 */
export async function linkAccountAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const entryId = positiveInteger(formData.get('entry_id'))
  const userId = positiveInteger(formData.get('user_id'))

  // The original raises ActiveRecordError on both and rescues into one message
  if (entryId === null || userId === null) {
    return { error: 'No pudimos vincular esa cuenta. Probá de nuevo.', notice: null }
  }

  const result = await linkAccountToEntry(session, classroomSlug, entryId, userId)

  if (!result.success) return { error: result.error, notice: null }

  // The page is force-dynamic, so this is what moves the account out of the
  // tab and onto its identifier's row without the teacher reloading
  revalidatePath(`/classrooms/${classroomSlug}/roster`)
  return EMPTY_STATE
}

/** Port of RostersController#unlink */
export async function unlinkAccountAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const entryId = positiveInteger(formData.get('entry_id'))

  if (entryId === null) return { error: 'No encontramos a ese alumno en el roster.', notice: null }

  const result = await unlinkAccountFromEntry(session, classroomSlug, entryId)

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}/roster`)
  return EMPTY_STATE
}

/** Port of RostersController#edit_entry */
export async function renameEntryAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const entryId = positiveInteger(formData.get('entry_id'))

  if (entryId === null) return { error: 'No encontramos a ese alumno en el roster.', notice: null }

  const result = await renameEntry(
    session,
    classroomSlug,
    entryId,
    String(formData.get('identifier') ?? ''),
  )

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}/roster`)
  return EMPTY_STATE
}

/** Port of RostersController#delete_entry */
export async function deleteEntryAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')
  const entryId = positiveInteger(formData.get('entry_id'))

  if (entryId === null) return { error: 'No encontramos a ese alumno en el roster.', notice: null }

  const result = await deleteEntry(session, classroomSlug, entryId)

  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}/roster`)
  revalidatePath(`/classrooms/${classroomSlug}`)
  return EMPTY_STATE
}

/** Port of RostersController#remove_organization */
export async function deleteRosterAction(
  _previous: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const classroomSlug = String(formData.get('classroom_slug') ?? '')

  const result = await deleteRoster(session, classroomSlug)
  if (!result.success) return { error: result.error, notice: null }

  revalidatePath(`/classrooms/${classroomSlug}`)
  // redirect_to organization_path(current_organization)
  redirect(`/classrooms/${classroomSlug}`)
}
