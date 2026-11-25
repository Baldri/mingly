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

import { app, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { isPathSafe } from '../../shared/file-access-types'
import type { InterpreterChooseOutcome, InterpreterState } from '../../shared/coding-interpreter-types'
import { SimpleStore } from '../utils/simple-store'
import { INTERPRETER_NAMES, readInterpreterPaths } from './run-command'

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
 * How a chosen basename is COMPARED against this list is `basenameIsAllowed`.
 */
export function allowedBasenames(name: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [name, `${name}.cmd`, `${name}.exe`]
  return [name]
}

/**
 * Does `basename` name the program `name` on `platform`?
 *
 * The one comparison rule, and the only one `validateChosenFile` uses, so the
 * spelling question is decided in a single place.
 *
 * ON WIN32 THE COMPARISON FOLDS CASE. Windows filesystems are
 * case-insensitive: `NPM.CMD` and `npm.cmd` are the SAME FILE there, so
 * accepting one spelling and refusing the other is not stricter, only
 * inconsistent about which spelling the dialog happened to return. The set of
 * files that get through does not change, and nothing else is relaxed — the
 * file must still be absolute, regular, executable, one of the allowed names
 * and outside userData.
 *
 * Off win32 the comparison stays exact, because there two spellings really can
 * be two different files and strictness costs nothing.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: the fold must not depend on the
 * user's locale (in a Turkish locale 'I' lower-cases to a dotless 'ı', which
 * would stop `NPM.CMD` from matching).
 */
export function basenameIsAllowed(name: string, basename: string, platform: NodeJS.Platform): boolean {
  const allowed = allowedBasenames(name, platform)
  if (platform !== 'win32') return allowed.includes(basename)
  const folded = basename.toLowerCase()
  return allowed.some((candidate) => candidate.toLowerCase() === folded)
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
 * check fails. No reason string, and the refusal is not broken down: the
 * surface reports THAT a pick was refused, never WHICH check refused it. The
 * settings page says so in one generic sentence, which is all a user needs and
 * all the design's anti-goals permit.
 *
 * The order of the checks is part of the contract. The name comparison runs
 * before the resolution (see the module header), and everything that touches
 * the filesystem runs after the cheap string checks.
 */
export function validateChosenFile(name: string, chosenPath: string): string | null {
  // Only the three names the run tool knows; the list is not duplicated here.
  if (!INTERPRETER_NAMES.some((known) => known === name)) return null
  if (!path.isAbsolute(chosenPath)) return null
  if (!basenameIsAllowed(name, path.basename(chosenPath), process.platform)) return null

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

// ---------------------------------------------------------------------------
// Read, write and remove
//
// `coding-interpreters.json` has exactly two keys, `paths` and `confirmedAt`.
// An entry without a usable marker simply stays in `paths` and is not honoured;
// nothing is parked. This is deliberate and differs from FileAccessManager,
// which must mutate a list at startup — here the entry can just sit there.
// ---------------------------------------------------------------------------

const STORE_FILE = 'coding-interpreters.json'

export function isKnownName(name: string): boolean {
  return INTERPRETER_NAMES.some((known) => known === name)
}

/** A stored map as a plain record; anything else reads as empty. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

/**
 * One entry per interpreter name, in `INTERPRETER_NAMES` order, for the
 * settings page. `confirmed` is decided by `readInterpreterPaths`, the same
 * reader the run tool uses, so the page cannot claim an entry is honoured when
 * the run tool would drop it. The `existsSync` is acceptable here because this
 * runs when the settings page opens, not on every command.
 */
export function listInterpreters(): InterpreterState[] {
  const store = SimpleStore.create(STORE_FILE)
  const stored = recordOf(store.get('paths', {}))
  const honoured = readInterpreterPaths(store)
  return INTERPRETER_NAMES.map((name) => {
    const value = Object.prototype.hasOwnProperty.call(stored, name) ? stored[name] : undefined
    const storedPath = typeof value === 'string' ? value : null
    return {
      name,
      path: storedPath,
      confirmed: Object.prototype.hasOwnProperty.call(honoured, name),
      found: storedPath !== null && fs.existsSync(storedPath)
    }
  })
}

/**
 * Let the user pick the program for `name` and store it if the trust boundary
 * accepts it. Says WHICH of the three things happened.
 *
 * The dialog is opened without a parent window, the way FileAccessManager does
 * it. A cancelled dialog is not an error and writes nothing; neither does a
 * pick `validateChosenFile` refuses — but those two are not the same event, and
 * a single boolean could not tell them apart. A refused pick is the one the
 * user has to be told about: they did choose a file and it was not taken.
 *
 * An unknown name reports `'refused'` for lack of a better word, but no caller
 * sees it: the IPC handler answers an unknown name with an error envelope
 * before it gets here, because that is a renderer bug and not a user outcome.
 * Nothing here decides what may be stored; `validateChosenFile` does.
 */
export async function chooseInterpreter(name: string): Promise<InterpreterChooseOutcome> {
  if (!isKnownName(name)) return 'refused'

  const store = SimpleStore.create(STORE_FILE)

  // Only `current` is read before the dialog, and only for `defaultPath`. The
  // maps that get written back are read AFTER it: the dialog has no parent
  // window, so the settings page stays usable while it is open, and a snapshot
  // taken here would overwrite a removal or a second choice made meanwhile —
  // resurrecting a revoked interpreter along with its confirmation marker.
  const stored = recordOf(store.get('paths', {}))
  const current = Object.prototype.hasOwnProperty.call(stored, name) ? stored[name] : undefined
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    title: `Select ${name}`,
    message: `Select the program Mingly should run as ${name}`
  }
  if (typeof current === 'string' && path.isAbsolute(current)) {
    options.defaultPath = path.dirname(current)
  }

  const result = await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return 'cancelled'

  const accepted = validateChosenFile(name, result.filePaths[0])
  if (accepted === null) return 'refused'

  // No `await` between this read and the writes below.
  const paths = recordOf(store.get('paths', {}))
  const confirmedAt = recordOf(store.get('confirmedAt', {}))

  // The path first: without its marker it is inert, so an interrupted write
  // never leaves an honoured entry the user did not confirm.
  paths[name] = accepted
  store.set('paths', paths)
  confirmedAt[name] = Date.now()
  store.set('confirmedAt', confirmedAt)
  return 'stored'
}

/** Clear the entry for `name` from both maps. False for a name that is not an interpreter. */
export function removeInterpreter(name: string): boolean {
  if (!isKnownName(name)) return false

  const store = SimpleStore.create(STORE_FILE)
  const paths = recordOf(store.get('paths', {}))
  const confirmedAt = recordOf(store.get('confirmedAt', {}))
  delete paths[name]
  delete confirmedAt[name]
  // The marker first: the reverse order could leave a marker next to a path
  // that is about to be replaced.
  store.set('confirmedAt', confirmedAt)
  store.set('paths', paths)
  return true
}
