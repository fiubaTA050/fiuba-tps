'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { setClassroomArchived } from '@/lib/data/organizations'
import { isUsableSession } from '@/lib/session'

/**
 * Port of OrganizationsController#update with `organization[archived]`, the
 * only edit the classroom card's kebab menu makes.
 *
 * The original answered it with `archive.js.erb`, re-rendering the filtered
 * list over rails-ujs; here revalidating the index is the same thing.
 */
export async function setArchivedAction(formData: FormData) {
  const session = await auth()
  if (!isUsableSession(session)) redirect('/')

  const slug = String(formData.get('slug') ?? '')
  const archived = formData.get('archived') === 'true'

  const result = await setClassroomArchived(session, slug, archived)
  if (!result.success) return

  revalidatePath('/classrooms')
  revalidatePath(`/classrooms/${slug}`)
}
