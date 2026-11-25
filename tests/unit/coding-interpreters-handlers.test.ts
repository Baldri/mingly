/**
 * The interpreter-settings IPC surface: three channels, no fourth verb, and
 * none of them takes a path.
 *
 * The renderer asks for a dialog; the main process produces the path. A
 * channel that accepted a path would let the renderer write one into the
 * configuration that no OS dialog produced, so "name only" is the claim under
 * test, not a style choice.
 *
 * Registration must be synchronous. PR #45 shipped four `wrapHandler` calls
 * that ran one microtask after the caller returned (the enclosing function was
 * `async` only to `await import(...)`), leaving a window in which a channel did
 * not exist. The registration test therefore asserts BEFORE any `await`.
 *
 * Results are envelopes (`success` discriminator), not bare values: wrapHandler
 * answers a rate limit or a thrown error with a truthy `{ success: false }`
 * object, so a bare boolean would read as success exactly when the call failed.
 *
 * Mutation table (measured by hand-inverting the rule in the handler file):
 *
 *   rule inverted                                              red tests
 *   ---------------------------------------------------------  ---------
 *   choose handler forwards the second (path) argument              1  (name-only)
 *   choose handler never calls chooseInterpreter                    2  (unknown-name, name-only)
 *   registration made async, `await import()` before the three      4  (all: nothing is registered
 *     wrapHandler calls                                                 yet when the assertions run)
 *   a fourth `coding-interpreters:*` channel registered             1  (no fourth verb)
 *   choose returns a bare boolean instead of { success, stored }    2  (failed-vs-cancelled, unknown-name)
 *   remove returns a bare boolean instead of an envelope            1  (envelopes)
 *   list stops calling listInterpreters (value replaced)            2  (name-only, envelopes)
 *
  * The name-only test asserts `toHaveBeenCalledTimes(1)` first: a spy asserted
 * with one argument passes just as well when the call never happened.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { ipcHandlers, showOpenDialog } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-test-userdata-interpreters',
    getVersion: () => '0.0.0-test',
    isReady: () => true,
    on: () => undefined,
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>): void => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => {
      ipcHandlers.delete(channel)
    }
  },
  dialog: { showOpenDialog },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: () => Promise.resolve() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

// The real functions, wrapped in spies: the handlers' arguments are observable
// and the unknown-name refusal still comes from the real implementation.
vi.mock('../../src/main/coding/interpreter-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/coding/interpreter-settings')>()
  return {
    ...actual,
    listInterpreters: vi.fn(actual.listInterpreters),
    chooseInterpreter: vi.fn(actual.chooseInterpreter),
    removeInterpreter: vi.fn(actual.removeInterpreter)
  }
})

import { IPC_CHANNELS } from '../../src/shared/types'
import { registerInfrastructureHandlers } from '../../src/main/ipc/infrastructure-handlers'
import {
  listInterpreters,
  chooseInterpreter,
  removeInterpreter
} from '../../src/main/coding/interpreter-settings'

/** Registered on the plain synchronous path — the positive control. */
const SYNC_CHANNEL = IPC_CHANNELS.FILE_ACCESS_LIST_DIRS

const INTERPRETER_CHANNELS = [
  IPC_CHANNELS.CODING_INTERPRETERS_LIST,
  IPC_CHANNELS.CODING_INTERPRETERS_CHOOSE,
  IPC_CHANNELS.CODING_INTERPRETERS_REMOVE
]

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({}, ...args)
}

describe('registerInfrastructureHandlers: interpreter settings', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    vi.mocked(listInterpreters).mockClear()
    vi.mocked(chooseInterpreter).mockClear()
    vi.mocked(removeInterpreter).mockClear()
    showOpenDialog.mockReset()
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  })

  it('registers all three channels synchronously', () => {
    registerInfrastructureHandlers()

    // No await anywhere before these assertions: after one, they would prove
    // nothing about the window #45 left open.
    expect(ipcHandlers.has(SYNC_CHANNEL), `positive control: ${SYNC_CHANNEL}`).toBe(true)
    for (const channel of INTERPRETER_CHANNELS) {
      expect(ipcHandlers.has(channel), channel).toBe(true)
    }
  })

  it('exposes exactly three interpreter channels and no fourth verb', () => {
    registerInfrastructureHandlers()

    expect(ipcHandlers.has(SYNC_CHANNEL), `positive control: ${SYNC_CHANNEL}`).toBe(true)
    const registered = [...ipcHandlers.keys()].filter((c) => c.startsWith('coding-interpreters:'))
    expect(registered.sort()).toEqual([...INTERPRETER_CHANNELS].sort())
  })

  it('the choose handler refuses an unknown name', async () => {
    registerInfrastructureHandlers()

    // Positive control: a known name reaches the dialog through the same
    // route, so "dialog not opened" below cannot be an unreachable handler.
    await invoke(IPC_CHANNELS.CODING_INTERPRETERS_CHOOSE, 'npm')
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    showOpenDialog.mockClear()

    const result = await invoke(IPC_CHANNELS.CODING_INTERPRETERS_CHOOSE, 'rm')

    expect(chooseInterpreter).toHaveBeenLastCalledWith('rm')
    expect(result).toEqual({ success: true, stored: false })
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('no channel accepts a path argument', async () => {
    registerInfrastructureHandlers()

    await invoke(IPC_CHANNELS.CODING_INTERPRETERS_CHOOSE, 'npm', '/evil/npm')
    await invoke(IPC_CHANNELS.CODING_INTERPRETERS_REMOVE, 'npm', '/evil/npm')
    await invoke(IPC_CHANNELS.CODING_INTERPRETERS_LIST, '/evil/npm')

    // Called at all, and with the name alone: toHaveBeenCalledWith compares
    // the whole argument list, so a forwarded second argument fails it.
    expect(chooseInterpreter).toHaveBeenCalledTimes(1)
    expect(chooseInterpreter).toHaveBeenCalledWith('npm')
    expect(removeInterpreter).toHaveBeenCalledTimes(1)
    expect(removeInterpreter).toHaveBeenCalledWith('npm')
    expect(listInterpreters).toHaveBeenCalledTimes(1)
    expect(listInterpreters).toHaveBeenCalledWith()
  })

  it('a failed call is distinguishable from a cancelled dialog', async () => {
    registerInfrastructureHandlers()

    // The call ran and the user cancelled: success, nothing stored.
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const cancelled = await invoke(IPC_CHANNELS.CODING_INTERPRETERS_CHOOSE, 'npm')
    expect(cancelled).toEqual({ success: true, stored: false })

    // The call itself failed: wrapHandler's error envelope, never a bare
    // boolean and never something truthy that reads as success.
    showOpenDialog.mockRejectedValueOnce(new Error('dialog exploded'))
    const failed = await invoke(IPC_CHANNELS.CODING_INTERPRETERS_CHOOSE, 'npm')
    expect(failed).toMatchObject({ success: false, error: 'dialog exploded' })
    expect(failed).not.toHaveProperty('stored')
  })

  it('list and remove return envelopes with a success discriminator', async () => {
    registerInfrastructureHandlers()

    const listed = await invoke(IPC_CHANNELS.CODING_INTERPRETERS_LIST)
    expect(listed).toMatchObject({ success: true })
    expect(Array.isArray((listed as { interpreters: unknown }).interpreters)).toBe(true)

    // An unknown name is a renderer bug, not a state: it is an error.
    const unknown = await invoke(IPC_CHANNELS.CODING_INTERPRETERS_REMOVE, 'rm')
    expect(unknown).toMatchObject({ success: false })
    expect((unknown as { error: string }).error).toEqual(expect.any(String))

    const removed = await invoke(IPC_CHANNELS.CODING_INTERPRETERS_REMOVE, 'npm')
    expect(removed).toEqual({ success: true })
  })
})
