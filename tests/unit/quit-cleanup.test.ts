import { describe, it, expect, vi } from 'vitest'
import { runQuitCleanup, type QuitCleanupSteps } from '../../src/main/quit-cleanup'

/**
 * `closeDatabase()` is the step that persists. Writes reach disk through a
 * 100ms debounced timer; `closeDatabase()` cancels that timer and performs the
 * final synchronous save. Any shutdown path that skips it loses everything
 * written in the last 100ms — so "closeDatabase ran" is the invariant these
 * tests guard, not "every shutdown step succeeded".
 */
function makeSteps(overrides: Partial<QuitCleanupSteps> = {}) {
  const order: string[] = []
  const track = <T>(name: string, result: T) => () => {
    order.push(name)
    return result
  }
  const steps: QuitCleanupSteps = {
    stopTranscriptionScheduler: track('stopTranscriptionScheduler', undefined),
    stopAutoUpdater: track('stopAutoUpdater', undefined),
    stopLocalAIBridge: track('stopLocalAIBridge', undefined),
    disconnectDocMind: track('disconnectDocMind', Promise.resolve()),
    shutdownDeploymentManager: track('shutdownDeploymentManager', Promise.resolve()),
    shutdownMCPClients: track('shutdownMCPClients', Promise.resolve()),
    closeDatabase: track('closeDatabase', undefined),
    ...overrides,
  }
  return { steps, order }
}

describe('runQuitCleanup', () => {
  it('runs every step and closes the database last', async () => {
    const { steps, order } = makeSteps()
    await runQuitCleanup(steps)

    expect(order).toEqual([
      'stopTranscriptionScheduler',
      'stopAutoUpdater',
      'stopLocalAIBridge',
      'disconnectDocMind',
      'shutdownDeploymentManager',
      'shutdownMCPClients',
      'closeDatabase',
    ])
  })

  it('stops the transcription scheduler before closing the database', async () => {
    const { steps, order } = makeSteps()
    await runQuitCleanup(steps)

    expect(order.indexOf('stopTranscriptionScheduler')).toBeLessThan(order.indexOf('closeDatabase'))
  })

  it('still closes the database when an async step rejects', async () => {
    const closeDatabase = vi.fn()
    const onError = vi.fn()
    const { steps } = makeSteps({
      disconnectDocMind: () => Promise.reject(new Error('MCP socket already gone')),
      closeDatabase,
    })

    await runQuitCleanup(steps, { onError })

    expect(closeDatabase).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('disconnectDocMind', expect.any(Error))
  })

  it('runs the later async steps even when an earlier one rejects', async () => {
    const { steps, order } = makeSteps({
      disconnectDocMind: () => Promise.reject(new Error('boom')),
    })

    await runQuitCleanup(steps, { onError: () => undefined })

    expect(order).toContain('shutdownMCPClients')
    expect(order).toContain('closeDatabase')
  })

  it('still closes the database when an async step never settles', async () => {
    const closeDatabase = vi.fn()
    const { steps } = makeSteps({
      shutdownMCPClients: () => new Promise<void>(() => undefined),
      closeDatabase,
    })

    await runQuitCleanup(steps, { timeoutMs: 20, onError: () => undefined })

    expect(closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('still closes the database when a synchronous step throws', async () => {
    const closeDatabase = vi.fn()
    const { steps } = makeSteps({
      stopAutoUpdater: () => {
        throw new Error('updater already disposed')
      },
      closeDatabase,
    })

    await runQuitCleanup(steps, { onError: () => undefined })

    expect(closeDatabase).toHaveBeenCalledTimes(1)
  })
})
