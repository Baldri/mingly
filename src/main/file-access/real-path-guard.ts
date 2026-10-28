/**
 * Real-path containment guard for the granted-directory model.
 *
 * isPathSafe (src/shared/file-access-types.ts) is a pure string predicate: it
 * resolves '..' but follows no symlink, because it is shared code that must
 * not pull node:fs into the renderer bundle (FileAccessTab.tsx imports the
 * types from there). That leaves a gap at every call site which validates a
 * path and then hands the SAME path to the filesystem: a symlink inside a
 * granted directory is inside the grant by its spelling and outside it in
 * fact.
 *
 * Measured 2026-10-28 against a real filesystem, not a mock: a granted
 * directory holding `harmless.txt -> ../outside/secret.txt` passed
 * isPathSafe and read the outside file; so did a symlinked subdirectory.
 *
 * Both sides have to be resolved, not just the requested path. A grant stores
 * whatever the directory picker returned, and that may itself be a symlink —
 * on macOS /tmp is a symlink to /private/tmp. Resolving only the requested
 * path turns a legitimate read into "access denied": measured for a grant on
 * /tmp/x, where the realpath of a genuine file inside it
 * (/private/tmp/x/echt.txt) is not within the stored grant string '/tmp/x'.
 *
 * What this does NOT close: the check and the subsequent open are two
 * operations, so a symlink swapped in between them still wins the race.
 * Closing that needs an openat2/RESOLVE_BENEATH-style primitive, which node
 * does not expose; O_NOFOLLOW only refuses a symlink as the final component.
 */

import fs from 'fs/promises'
import path from 'path'
import { isPathSafe } from '../../shared/file-access-types'

/**
 * Resolve `target` through symlinks, tolerating a tail that does not exist.
 *
 * A file about to be created has no realpath of its own, and createFile may
 * also be asked for a path whose parent directories are still missing. The
 * deepest existing ancestor is resolved and the missing segments are appended
 * to it, so the answer is a real path for the part that exists and a literal
 * one for the part that cannot have a symlink yet.
 */
export async function resolveRealPath(target: string): Promise<string> {
  const absolute = path.resolve(target)
  const missing: string[] = []
  let current = absolute

  for (;;) {
    try {
      const real = await fs.realpath(current)
      return missing.length === 0 ? real : path.join(real, ...missing)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        // Nothing along the path exists, so there is no symlink to follow.
        return absolute
      }
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

/** Is `requestedPath` really inside `allowedDir`, with symlinks resolved on both sides? */
export async function isRealPathWithin(requestedPath: string, allowedDir: string): Promise<boolean> {
  const [realRequested, realAllowed] = await Promise.all([
    resolveRealPath(requestedPath),
    resolveRealPath(allowedDir)
  ])
  return isPathSafe(realRequested, realAllowed)
}

/** Is `requestedPath` really inside ANY of `allowedDirs`? */
export async function isRealPathWithinAny(
  requestedPath: string,
  allowedDirs: string[]
): Promise<boolean> {
  if (allowedDirs.length === 0) {
    return false
  }
  const realRequested = await resolveRealPath(requestedPath)
  const realAllowed = await Promise.all(allowedDirs.map((dir) => resolveRealPath(dir)))
  return realAllowed.some((dir) => isPathSafe(realRequested, dir))
}
