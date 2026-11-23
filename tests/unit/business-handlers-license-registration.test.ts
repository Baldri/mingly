/**
 * The license IPC channels must exist the moment `registerBusinessHandlers`
 * returns.
 *
 * `registerBusinessHandlers` is synchronous and void. It used to call
 * `registerLicenseHandlers()` without awaiting it, and that function is async
 * only because it does `await import('../services/license-activation')` — so
 * its four `wrapHandler` calls ran a microtask later. Between the two there is
 * a window in which `license:get-info` and its siblings are not registered: a
 * renderer asking in that window gets Electron's "no handler registered"
 * error, and the user sees the free tier.
 *
 * The same missing await swallowed any failure of that dynamic import as an
 * unhandled rejection, which would remove every license channel silently.
 *
 * `ipcMain.handle` is captured rather than mocked away: "it is registered, on
 * this channel, by the time the call returns" is the whole claim.
 *
 * EVERY assertion here sits next to a positive control in the same test — a
 * channel registered on the synchronous path. Without it, a test that fails to
 * load the module at all would look exactly like the defect, and a passing run
 * would prove only that nothing was reachable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-test-userdata',
    getVersion: () => '0.0.0-test',
    isReady: () => true,
    on: () => undefined,
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    handle: (channel: string, handler: unknown): void => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => {
      ipcHandlers.delete(channel)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: () => Promise.resolve() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { IPC_CHANNELS } from '../../src/shared/types'
import { registerBusinessHandlers } from '../../src/main/ipc/business-handlers'

/** Registered on the plain synchronous path — the positive control. */
const SYNC_CHANNEL = IPC_CHANNELS.FEATURE_GATE_GET_LIMITS

/** The four channels the missing await delayed. */
const LICENSE_CHANNELS = [
  IPC_CHANNELS.LICENSE_ACTIVATE,
  IPC_CHANNELS.LICENSE_DEACTIVATE,
  IPC_CHANNELS.LICENSE_GET_INFO,
  IPC_CHANNELS.LICENSE_GET_CHECKOUT_URL
]

describe('registerBusinessHandlers: license channels', () => {
  beforeEach(() => {
    ipcHandlers.clear()
  })

  it('registers them before returning, not a microtask later', () => {
    registerBusinessHandlers()

    // POSITIVE CONTROL first: if this is missing the module never ran and
    // everything below would fail for a reason that is not the defect.
    expect(ipcHandlers.has(SYNC_CHANNEL), `positive control: ${SYNC_CHANNEL}`).toBe(true)

    for (const channel of LICENSE_CHANNELS) {
      expect(ipcHandlers.has(channel), channel).toBe(true)
    }
  })

  it('registers each license channel exactly once', () => {
    // A second registration on the same channel would throw in real Electron
    // ("Attempted to register a second handler"), so a duplicate is not a
    // cosmetic issue. The Map would hide it, so count the calls instead.
    const calls: string[] = []
    const seen = new Map<string, number>()
    for (const channel of ipcHandlers.keys()) calls.push(channel)
    ipcHandlers.clear()
    registerBusinessHandlers()
    for (const channel of ipcHandlers.keys()) {
      seen.set(channel, (seen.get(channel) ?? 0) + 1)
    }
    expect(calls.length).toBe(0)
    for (const channel of LICENSE_CHANNELS) {
      expect(seen.get(channel), channel).toBe(1)
    }
  })
})
