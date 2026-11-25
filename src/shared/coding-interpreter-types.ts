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
 * (`success: true, outcome: 'cancelled'`) can never be mistaken for a failure.
 */
export interface InterpreterIpcError {
  success: false
  error: string
  retryAfterMs?: number
}

export type InterpreterListResult =
  | { success: true; interpreters: InterpreterState[] }
  | InterpreterIpcError

/**
 * What one `choose` produced. THREE outcomes, not two.
 *
 * `stored` wrote the path; `cancelled` means the user closed the dialog;
 * `refused` means the user did pick a file and `validateChosenFile` did not
 * accept it. A boolean cannot carry that: it folded `refused` into `cancelled`,
 * and the settings page then showed a refused pick NOTHING AT ALL — no error,
 * no change, no hint. With a validation that requires the basename to be
 * exactly `npm`, that is the likely case, not an edge case.
 *
 * A refused pick rides in the SUCCESS envelope. The call ran and its outcome
 * was a refusal; `{ success: false }` stays reserved for a call that FAILED
 * (rate limit, thrown error), which is the distinction ruling R12 exists to
 * create. Collapsing the two would destroy it.
 */
export type InterpreterChooseOutcome = 'stored' | 'cancelled' | 'refused'

export type InterpreterChooseResult =
  | { success: true; outcome: InterpreterChooseOutcome }
  | InterpreterIpcError

export type InterpreterRemoveResult = { success: true } | InterpreterIpcError
