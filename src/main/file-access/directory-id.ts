/**
 * The id of a granted directory: an opaque handle derived from the FULL path.
 *
 * The previous form was `Buffer.from(dirPath).toString('base64').substring(0, 16)`.
 * 16 base64 characters encode 12 input bytes, and `/Users/holge` is already 12
 * bytes, so EVERY directory under one macOS home shared a single id (measured
 * outside the process with `base64 | cut -c1-16`; the control `/tmp/x` differs):
 *
 *   L1VzZXJzL2hvbGdl   /Users/holgervonellerts/projects/alpha
 *   L1VzZXJzL2hvbGdl   /Users/holgervonellerts/projects/beta
 *   L1VzZXJzL2hvbGdl   /Users/holgervonellerts/mingly
 *   L3RtcC94           /tmp/x
 *
 * `FileAccessManager.allowedDirs` is a Map on this id, so a second project
 * silently replaced the first, and the coding mode, the run's directory, the
 * project path a run resolves to and the accept/undo validation were all keyed
 * on it as well. The consequence was the wrong project and the wrong mode — a
 * level granted on one project applying to its siblings — never an ungranted
 * write, because the path always comes from a real grant and the content hash
 * plus the exactly-once check refuse an apply into the wrong project.
 *
 * Three properties this function has to keep:
 *
 *  - The WHOLE path goes in. That is the fix; the length is incidental.
 *  - Deterministic. Every grant and every coding mode is persisted under this
 *    id, so a restart that produced different ids would lose all of them.
 *  - Opaque. Nothing may read a path back out of it. The old form could be
 *    base64-decoded into a path prefix, and the id is the one thing the
 *    renderer is given instead of a path (R35) precisely because it is not one.
 */
import { createHash } from 'crypto'

/** Hex characters kept. Same length as the old id; what changed is what goes in. */
const ID_CHARS = 16

export function directoryId(dirPath: string): string {
  return createHash('sha256').update(dirPath).digest('hex').slice(0, ID_CHARS)
}

/**
 * The id a persisted grant should be carried under now, or null when it should
 * keep the one it has.
 *
 * ONE place decides which entries get re-keyed, because two of them have to
 * agree: the migration that rewrites file-access.json and the loader that
 * builds the in-memory Map from it.
 *
 * Only a LOCAL grant is re-keyed. A network grant's id was never path-derived —
 * addNetworkShare writes `${protocol}://${host}/${shareName}`, which is already
 * unambiguous and is the id addNetworkShare and revokeDirectoryAccess use to
 * find the entry again; re-keying it to a hash of the mount point would turn
 * the next add of the same share into a SECOND entry instead of a replacement.
 * An entry with no usable id or path keeps what it has: there is no new id to
 * compute for it, and inventing one or dropping the record would both be worse
 * than leaving a grant that was already unusable.
 */
export function currentDirectoryId(entry: {
  id?: unknown
  path?: unknown
  location?: unknown
}): string | null {
  if (typeof entry.id !== 'string' || entry.id === '') return null
  if (entry.location !== 'local') return null
  if (typeof entry.path !== 'string' || entry.path === '') return null
  const id = directoryId(entry.path)
  return id === entry.id ? null : id
}
