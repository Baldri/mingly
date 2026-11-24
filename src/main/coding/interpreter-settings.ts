/**
 * The trust boundary for an interpreter path: may this file be stored as the
 * program for `npm`, `git` or `pytest`?
 *
 * Everything downstream trusts the verdict. The store writer, the IPC surface
 * and the settings UI do not validate again, and `readInterpreterPaths`
 * (run-command.ts) only re-checks that a stored entry is absolute and carries a
 * confirmation marker — it cannot tell whether the file is still the one that
 * was validated. This function is therefore the only place that looks at the
 * file itself.
 *
 * THE NAME IS COMPARED ON THE CHOSEN PATH, NEVER ON THE RESOLVED ONE, and the
 * CHOSEN path is what gets stored. For a version-managed tool a symlink is the
 * normal case, not an attack, and its target is routinely called something
 * else. Measured 2026-11-24:
 *
 *   ~/.nvm/versions/node/v24.13.1/bin/npm
 *       -> .../lib/node_modules/npm/bin/npm-cli.js   (basename npm-cli.js)
 *   /opt/homebrew/bin/git
 *       -> /opt/homebrew/Cellar/git/2.53.0/bin/git   (basename git)
 *   ~/Library/Python/3.13/bin/pytest                 (no symlink at all)
 *
 * Resolving first and then comparing the name would reject this machine's own
 * npm. Storing the resolved path would be just as wrong for a second reason:
 * `childEnv` (run-command.ts) puts `path.dirname()` of the stored value on the
 * child's PATH, and `.../lib/node_modules/npm/bin` holds no `node`, so npm
 * could not start.
 *
 * `realpathSync` keeps a narrower job here than in the file-access code: it
 * says WHAT sits at the end of the chain (a regular file, executable) and it
 * supplies one of the two sides of the userData containment check. It is not
 * the identity check.
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { isPathSafe } from '../../shared/file-access-types'
import { INTERPRETER_NAMES } from './run-command'

/**
 * The basenames a chosen file may carry for `name`.
 *
 * The platform is an argument rather than a read of `process.platform`, so both
 * branches can be measured on one host: stubbing `process.platform` inside
 * vitest is fragile, and a win32-only test would simply never run on a macOS
 * or Linux machine. `validateChosenFile` passes the real platform.
 *
 * Windows needs the extensions because the shim a package manager installs
 * there IS `npm.cmd`; `shell: false` means the extension is not appended for us.
 */
export function allowedBasenames(name: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [name, `${name}.cmd`, `${name}.exe`]
  return [name]
}

function realPathOf(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

function statOf(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function isExecutable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The real path of this app's own data directory, or null if it cannot be resolved. */
function realUserDataPath(): string | null {
  try {
    return fs.realpathSync(app.getPath('userData'))
  } catch {
    return null
  }
}

/**
 * Validate a file the user picked in an OS dialog as the program for `name`.
 *
 * Returns the path to STORE — always `chosenPath`, unchanged — or null if any
 * check fails. No reason string: the caller has no use for one and the surface
 * only reports success or failure.
 *
 * The order of the checks is part of the contract. The name comparison runs
 * before the resolution (see the module header), and everything that touches
 * the filesystem runs after the cheap string checks.
 */
export function validateChosenFile(name: string, chosenPath: string): string | null {
  // Only the three names the run tool knows; the list is not duplicated here.
  if (!INTERPRETER_NAMES.some((known) => known === name)) return null
  if (!path.isAbsolute(chosenPath)) return null
  if (!allowedBasenames(name, process.platform).includes(path.basename(chosenPath))) return null

  const target = realPathOf(chosenPath)
  if (target === null) return null

  // A directory, a socket or a FIFO is not a program, and a directory called
  // `npm` passes every check above.
  const stat = statOf(target)
  if (stat === null || !stat.isFile()) return null

  if (!isExecutable(target)) return null

  // Containment, both sides resolved. Unless both sides are in the same normal
  // form the check compares spellings and misses a file that really lies inside
  // userData — the defect real-path-guard.ts exists for, measured there on
  // 2026-10-28 for a grant on /tmp, which on macOS resolves to /private/tmp.
  //
  // The chosen side is resolved only as far as its DIRECTORY chain, with the
  // final link left standing: the chosen path's own realpath IS `target`, so
  // comparing that a second time would check nothing new — and it would miss a
  // link that sits INSIDE userData and points out. A file there must not become
  // an interpreter whatever it points at: userData is the one directory this app
  // writes into on the renderer's behalf (SimpleStore keeps its JSON there).
  //
  // isPathSafe is the repo's single containment predicate. Its known weakness
  // at the filesystem root cannot be reached here: `app.getPath('userData')`
  // never resolves to '/'.
  const realUserData = realUserDataPath()
  const chosenDir = realPathOf(path.dirname(chosenPath))
  if (realUserData === null || chosenDir === null) return null
  const chosenWithRealParent = path.join(chosenDir, path.basename(chosenPath))
  if (isPathSafe(chosenWithRealParent, realUserData)) return null
  if (isPathSafe(target, realUserData)) return null

  return chosenPath
}
