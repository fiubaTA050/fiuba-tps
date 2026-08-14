'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { createClassroom } from '@/lib/data/organizations'
import { positiveInteger } from '@/lib/form'
import { isUsableSession } from '@/lib/session'

export type CreateClassroomState = { error: string | null }

/** Port of OrganizationsController#create */
export async function createClassroomAction(
  _previous: CreateClassroomState,
  formData: FormData,
): Promise<CreateClassroomState> {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const title = String(formData.get('title') ?? '')

  // With no org selected the hidden inputs arrive as "", and Number("") is 0,
  // which passes Number.isInteger. Check the raw value.
  const githubId = positiveInteger(formData.get('github_id'))
  const installationId = positiveInteger(formData.get('installation_id'))

  if (githubId === null || installationId === null) {
    return { error: 'Elegí una organización de la lista.' }
  }

  const result = await createClassroom(session, { githubId, installationId, title })

  // flash[:error] + redirect_to new_organization_path
  if (!result.success) return { error: result.error }

  revalidatePath('/classrooms')
  // redirect_to setup_organization_path(@organization)
  redirect(`/classrooms/${result.slug}?created=1`)
}
