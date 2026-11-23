/**
 * Ordered cleanup for application quit.
 *
 * This exists as its own module for one reason: Electron does **not** await a
 * `before-quit` listener. The listener used to be `async`, and three of its
 * seven steps were behind an `await` — including the last one, `closeDatabase()`.
 * After the first `await` the process was free to exit, so the database close
 * was not guaranteed to run at all.
 *
 * That is a data-loss path, not a style issue: writes reach disk through a
 * 100ms debounced timer (`scheduleSave()` in `database/index.ts`), and
 * `closeDatabase()` is what cancels that timer and performs the final
 * synchronous save. Quitting within 100ms of a write, with the close skipped,
 * loses that write.
 *
 * So the contract here is: **`closeDatabase()` runs, whatever else happens.**
 * A failing or hanging MCP/DocMind/deployment shutdown must not take it down,
 * and must not keep the app from quitting either — hence the timeout.
 */

/** Every step the quit path performs, injected so the order is testable. */
export interface QuitCleanupSteps {
  /** Must run before `closeDatabase`: a pass scheduled later finds no database. */
  stopTranscriptionScheduler: () => void
  stopAutoUpdater: () => void
  stopLocalAIBridge: () => void
  disconnectDocMind: () => Promise<unknown>
  shutdownDeploymentManager: () => Promise<unknown>
  shutdownMCPClients: () => Promise<unknown>
  /** Cancels the debounced save timer and writes the database out. */
  closeDatabase: () => void
}

export interface QuitCleanupOptions {
  /** Budget for ALL async steps together. */
  timeoutMs?: number
  onError?: (step: string, error: unknown) => void
}

/**
 * Upper bound for the async shutdowns as a group. Past it the app quits with
 * those steps unfinished — an unresponsive remote MCP server is not a reason to
 * leave a window the user cannot close.
 */
export const QUIT_CLEANUP_TIMEOUT_MS = 5_000

/** Run `work`, resolving regardless of outcome, reporting any failure. */
async function settle(
  step: string,
  work: () => Promise<unknown> | void,
  onError: (step: string, error: unknown) => void,
): Promise<void> {
  try {
    await work()
  } catch (error) {
    onError(step, error)
  }
}

/**
 * Resolve when `work` settles or `timeoutMs` elapses, whichever is first. The
 * timer is always cleared: a pending `setTimeout` would itself keep the event
 * loop alive and delay the quit this function is trying to make possible.
 */
async function withTimeout(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Shut the app's subsystems down in order, then close the database.
 *
 * The async steps stay sequential on purpose — DocMind's MCP connection is
 * handed back before the MCP client manager goes away — but each one is
 * individually contained, so a failure does not skip the ones behind it.
 */
export async function runQuitCleanup(
  steps: QuitCleanupSteps,
  options: QuitCleanupOptions = {},
): Promise<void> {
  const { timeoutMs = QUIT_CLEANUP_TIMEOUT_MS, onError = () => undefined } = options

  try {
    await withTimeout(
      (async () => {
        await settle('stopTranscriptionScheduler', steps.stopTranscriptionScheduler, onError)
        await settle('stopAutoUpdater', steps.stopAutoUpdater, onError)
        await settle('stopLocalAIBridge', steps.stopLocalAIBridge, onError)
        await settle('disconnectDocMind', steps.disconnectDocMind, onError)
        await settle('shutdownDeploymentManager', steps.shutdownDeploymentManager, onError)
        await settle('shutdownMCPClients', steps.shutdownMCPClients, onError)
      })(),
      timeoutMs,
    )
  } finally {
    // The step that must not be skipped — see the module comment.
    try {
      steps.closeDatabase()
    } catch (error) {
      onError('closeDatabase', error)
    }
  }
}
