/**
 * What the settings page needs to know about one interpreter (`npm`, `git`,
 * `pytest`). Produced in the main process by `listInterpreters`, consumed by
 * the renderer.
 *
 * `path` is whatever is stored, or null. `confirmed` says whether the entry is
 * honoured by the run tool (absolute path plus a confirmation marker); an entry
 * can sit in the store without being honoured. `found` says whether the stored
 * path exists on disk right now.
 */
export interface InterpreterState {
  name: string
  path: string | null
  confirmed: boolean
  found: boolean
}

/**
 * What the three interpreter IPC channels resolve to. Same shape as the error
 * envelope `wrapHandler` produces (`{ success: false, error }`), so a caller
 * branches on `success` alone: a failed call (rate limit, thrown error) can
 * never be mistaken for a regular outcome, and a cancelled dialog
 * (`success: true, stored: false`) can never be mistaken for a failure.
 */
export interface InterpreterIpcError {
  success: false
  error: string
  retryAfterMs?: number
}

export type InterpreterListResult =
  | { success: true; interpreters: InterpreterState[] }
  | InterpreterIpcError

/** `stored` is false when the dialog was cancelled or the pick was refused. */
export type InterpreterChooseResult = { success: true; stored: boolean } | InterpreterIpcError

export type InterpreterRemoveResult = { success: true } | InterpreterIpcError
