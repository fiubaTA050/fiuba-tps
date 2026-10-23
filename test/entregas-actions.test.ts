import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The `kind` that tells a group assignment's entrega apart travels as a hidden
 * form field and a query param, and anything but `group` falls back to the
 * individual path (`parseAssignmentKind`). A form that dropped it would send a
 * team's justification to the individual tables, which answer "No encontramos
 * esa entrega" — and every data-layer test would still pass. These pin the
 * hand-off from the request to the data layer; the data layer itself is
 * tested against a real database in test/group-submissions.test.ts.
 */

const session = { user: { id: '1', uid: 1, githubLogin: 'profe' }, expires: '' }

vi.mock('@/auth', () => ({ auth: async () => session }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/data/rosters', () => ({ linkAccountToEntry: vi.fn() }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`)
  },
}))

const data = {
  setSubmissionExemption: vi.fn(async () => ({ success: true })),
  justifyLateSubmission: vi.fn(async () => ({ success: true })),
  revokeLateSubmissionJustification: vi.fn(async () => ({ success: true })),
  saveSubmissionFeedback: vi.fn(async () => ({ success: true })),
  findSubmissionHistory: vi.fn(async () => []),
  confirmSubmission: vi.fn(async () => ({
    success: true,
    sha: 'a'.repeat(40),
    unchanged: false,
    warning: null,
  })),
}
vi.mock('@/lib/data/submissions', () => data)

const { saveSubmissionFeedbackAction, setLateJustificationAction, setSubmissionExemptionAction } =
  await import('@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions')
const { GET } = await import(
  '@/app/api/classrooms/[slug]/assignments/[assignmentSlug]/submissions/[repoId]/route'
)
const { confirmSubmissionAction } = await import('@/app/assignment-invitations/[key]/actions')
const { confirmGroupSubmissionAction } = await import(
  '@/app/group-assignment-invitations/[key]/actions'
)

const EMPTY = { error: null, notice: null }

function form(fields: Record<string, string>): FormData {
  const formData = new FormData()
  for (const [name, value] of Object.entries(fields)) formData.set(name, value)
  return formData
}

const target = {
  classroom_slug: 'tps',
  assignment_slug: 'tp2',
  github_repo_id: '77',
  submission_id: '5',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the dashboard actions', () => {
  it('extend a team\'s entrega on the group path and revalidate the group dashboard', async () => {
    await setSubmissionExemptionAction(
      EMPTY,
      form({ ...target, checkpoint_id: '3', exempt: '1', kind: 'group' }),
    )

    expect(data.setSubmissionExemption).toHaveBeenCalledWith(session, 'tps', 'tp2', 3, 77, true, 'group')
    expect(revalidatePath).toHaveBeenCalledWith('/classrooms/tps/group-assignments/tp2')
  })

  it('justify, and take back, a team\'s late entrega on the group path', async () => {
    await setLateJustificationAction(EMPTY, form({ ...target, justify: '1', reason: 'GitHub caído', kind: 'group' }))
    await setLateJustificationAction(EMPTY, form({ ...target, justify: '0', kind: 'group' }))

    expect(data.justifyLateSubmission).toHaveBeenCalledWith(session, 'tps', 'tp2', 77, 5, 'GitHub caído', 'group')
    expect(data.revokeLateSubmissionJustification).toHaveBeenCalledWith(session, 'tps', 'tp2', 77, 5, 'group')
    expect(revalidatePath).toHaveBeenCalledWith('/classrooms/tps/group-assignments/tp2/submissions/77/5')
  })

  it('save a devolución on the group path', async () => {
    await saveSubmissionFeedbackAction(EMPTY, form({ ...target, body: 'Bien', based_on: '', kind: 'group' }))

    expect(data.saveSubmissionFeedback).toHaveBeenCalledWith(session, 'tps', 'tp2', 77, 5, 'Bien', null, 'group')
  })

  it('stay on the individual path when the form posts no kind', async () => {
    await saveSubmissionFeedbackAction(EMPTY, form({ ...target, body: 'Bien', based_on: '' }))

    expect(data.saveSubmissionFeedback).toHaveBeenCalledWith(
      session,
      'tps',
      'tp2',
      77,
      5,
      'Bien',
      null,
      'individual',
    )
    expect(revalidatePath).toHaveBeenCalledWith('/classrooms/tps/assignments/tp2')
  })
})

describe('the submission history route', () => {
  async function get(query: string) {
    return GET(new Request(`http://localhost/api/x?${query}`), {
      params: Promise.resolve({ slug: 'tps', assignmentSlug: 'tp2', repoId: '77' }),
    })
  }

  it('reads a team\'s history with kind=group', async () => {
    const response = await get('checkpointId=3&kind=group')

    expect(response.status).toBe(200)
    expect(data.findSubmissionHistory).toHaveBeenCalledWith(session, 'tps', 'tp2', 77, 3, 'group')
  })

  it('reads a student\'s history without it', async () => {
    await get('checkpointId=3')

    expect(data.findSubmissionHistory).toHaveBeenCalledWith(session, 'tps', 'tp2', 77, 3, 'individual')
  })
})

describe('the confirm actions', () => {
  const fields = { key: 'k', checkpoint_id: '3', ref: 'main', ai_declaration: 'Ninguna' }

  it('confirm for the team on the group invitation', async () => {
    const state = await confirmGroupSubmissionAction(EMPTY, form(fields))

    expect(data.confirmSubmission).toHaveBeenCalledWith(session, 'k', 3, 'main', 'Ninguna', 'group')
    expect(revalidatePath).toHaveBeenCalledWith('/group-assignment-invitations/k/setup')
    expect(state.notice).toBe('Entrega del equipo confirmada: aaaaaaa.')
  })

  it('confirm for the student on the individual invitation', async () => {
    const state = await confirmSubmissionAction(EMPTY, form(fields))

    expect(data.confirmSubmission).toHaveBeenCalledWith(session, 'k', 3, 'main', 'Ninguna', 'individual')
    expect(revalidatePath).toHaveBeenCalledWith('/assignment-invitations/k/setup')
    expect(state.notice).toBe('Entrega confirmada: aaaaaaa.')
  })
})
