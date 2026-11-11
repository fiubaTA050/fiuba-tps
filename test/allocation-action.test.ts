import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `setAllocationAction` is called straight from the client with an object,
 * not a form, and a server action is a public POST endpoint: whatever it
 * receives is untyped. These pin what it lets through to the data layer,
 * which is tested against a real database in test/teaching-assistants.test.ts.
 */

const session = { user: { id: '1', uid: 1, githubLogin: 'profe' }, expires: '' }

vi.mock('@/auth', () => ({ auth: async () => session }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`)
  },
}))

const setAllocation = vi.fn(async () => ({ success: true }) as const)
vi.mock('@/lib/data/teaching-assistants', () => ({
  setAllocation: (...args: unknown[]) => setAllocation(...(args as [])),
}))

const { setAllocationAction } = await import(
  '@/app/classrooms/[slug]/assignments/[assignmentSlug]/actions'
)

const valid = {
  classroomSlug: 'sd-2026-1',
  assignmentSlug: 'tp1',
  kind: 'group',
  teachingAssistantId: 3,
  targetIds: [10, 11],
  allocate: true,
}

beforeEach(() => {
  setAllocation.mockClear()
})

describe('setAllocationAction', () => {
  it('hands a well-formed call to the data layer, kind included', async () => {
    expect(await setAllocationAction(valid)).toEqual({ error: null })
    expect(setAllocation).toHaveBeenCalledWith(session, 'sd-2026-1', 'tp1', 'group', {
      teachingAssistantId: 3,
      targetIds: [10, 11],
      allocate: true,
    })
  })

  it('refuses ids that are not positive integers, without touching the data layer', async () => {
    const bad: unknown[] = [
      { ...valid, teachingAssistantId: 0 },
      { ...valid, teachingAssistantId: 'x' },
      { ...valid, targetIds: [10, -1] },
      { ...valid, targetIds: [10, 1.5] },
      { ...valid, targetIds: [10, null] },
    ]
    for (const input of bad) {
      expect(await setAllocationAction(input as typeof valid)).toEqual({
        error: 'No pudimos asignar al ayudante. Recargá la página.',
      })
    }
    expect(setAllocation).not.toHaveBeenCalled()
  })

  it('reads anything but a literal true as taking off, and anything but group as individual', async () => {
    await setAllocationAction({
      ...valid,
      kind: 'whatever',
      allocate: 'true' as unknown as boolean,
    })

    expect(setAllocation).toHaveBeenCalledWith(session, 'sd-2026-1', 'tp1', 'individual', {
      teachingAssistantId: 3,
      targetIds: [10, 11],
      allocate: false,
    })
  })

  it('treats a targetIds that is not an array as nothing to do', async () => {
    await setAllocationAction({ ...valid, targetIds: 'oops' as unknown as number[] })

    expect(setAllocation).toHaveBeenCalledWith(
      session,
      'sd-2026-1',
      'tp1',
      'group',
      expect.objectContaining({ targetIds: [] }),
    )
  })

  it('passes the data layer’s refusal through as the error', async () => {
    setAllocation.mockResolvedValueOnce({
      success: false,
      error: 'Ese ayudante ya no está en el classroom.',
    } as never)

    expect(await setAllocationAction(valid)).toEqual({
      error: 'Ese ayudante ya no está en el classroom.',
    })
  })
})
