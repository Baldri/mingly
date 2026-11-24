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
