/**
 * Which directory a coding run belongs to, recorded in the main process where
 * the run starts. The accept and undo handlers take the directory from here and
 * only VALIDATE the renderer's claim against it: the renderer is an input, and
 * a mismatch means it and the main process disagree about what is happening.
 *
 * In memory, like the proposal store whose packages it belongs to. Bounded as a
 * whole: when full, the oldest record goes (that run can then no longer be
 * accepted or undone from the UI: it fails closed, it never falls back to the
 * caller's claim). The first record of a run wins and is never replaced.
 *
 * DEBT: not persisted, so undo is unavailable after an app restart ->
 * persist alongside the snapshot manifest once undo-after-restart is wanted.
 */

export const RUN_DIRECTORIES_MAX = 1000

export interface RunDirectoryRegistry {
  record(runId: string, directoryId: string): void
  get(runId: string): string | undefined
}

export function createRunDirectoryRegistry(max: number = RUN_DIRECTORIES_MAX): RunDirectoryRegistry {
  const map = new Map<string, string>()
  return {
    record(runId, directoryId) {
      if (typeof runId !== 'string' || typeof directoryId !== 'string' || runId === '' || directoryId === '') return
      if (map.has(runId)) return
      map.set(runId, directoryId)
      while (map.size > max) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
    get(runId) {
      return map.get(runId)
    }
  }
}

let instance: RunDirectoryRegistry | undefined

export function getRunDirectoryRegistry(): RunDirectoryRegistry {
  instance ??= createRunDirectoryRegistry()
  return instance
}
