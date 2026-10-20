/**
 * Task-space name collision (upstream v2.1.0): a name held by a user-owned space
 * is a duplicate-name failure, not a space the agent silently selects and then
 * drives while the user still owns it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { useOrCreateTaskSpace } from '../src/runtime/helpers.ts'

/** The `globalThis.ego` surface this case drives. */
interface EgoStub {
  listTaskSpaces: () => Promise<unknown>
}

const scope = globalThis as { ego?: EgoStub }

afterEach(() => {
  delete scope.ego
})

describe('task space name collision', () => {
  it('rejects a name held by a user-owned space', async () => {
    scope.ego = {
      listTaskSpaces: async () => ({ taskSpaces: [{ id: 7, name: 'mine', ownership: 'user' }] }),
    }
    const failure = await useOrCreateTaskSpace('mine')
      .then(() => undefined, (error: unknown) => error as Error & { error_code?: string })
    expect(failure?.error_code).toBe('EGO_TASK_SPACE_NAME_IN_USE')
    expect(failure?.message).toMatch(/already exists and belongs to the user/)
  })
})
