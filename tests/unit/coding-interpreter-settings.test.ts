/**
 * `validateChosenFile` — the trust boundary for a configured interpreter path,
 * measured against a real filesystem.
 *
 * fs is deliberately NOT mocked. The symlink cases are the heart of this
 * module: for a version-managed tool a symlink is the NORMAL case, and its
 * target is routinely called something else. Measured on this machine,
 * 2026-11-24:
 *
 *   ~/.nvm/versions/node/v24.13.1/bin/npm
 *       -> .../lib/node_modules/npm/bin/npm-cli.js   (basename npm-cli.js)
 *   /opt/homebrew/bin/git
 *       -> /opt/homebrew/Cellar/git/2.53.0/bin/git   (basename git)
 *   ~/Library/Python/3.13/bin/pytest                 (no symlink at all)
 *
 * An fs double cannot have symlinks, so a test written against one would
 * assert against a model of the filesystem instead of the filesystem — and in
 * this repo two separately green pull requests already turned red when
 * combined, because an fs double in one did not know about the realpath usage
 * the other introduced (memory note
 * `zwei-gruene-pr-kombiniert-rot-durch-test-double`).
 *
 * Three instrument rules are encoded below:
 *
 *  1. Every negative case is built so that the check under test is the ONLY one
 *     it can fail. The directory fixture is therefore named `npm`, not
 *     `somedir`: otherwise the basename comparison would refuse it and the
 *     "regular file" check would never run, leaving the test green for a reason
 *     that has nothing to do with directories.
 *  2. The expected interpreter names are written out BY HAND. Looping over the
 *     imported `INTERPRETER_NAMES` alone would make every accept case vacuous
 *     if that list were emptied (memory note
 *     `testinstrument-darf-nicht-aus-dem-pruefling-stammen`).
 *  3. userData is handed to the module through a SYMLINK, so the containment
 *     check has to resolve its own side too. Unless both sides are in the same
 *     normal form the check compares spellings, which is the defect
 *     real-path-guard.ts exists for — measured there on 2026-10-28 for a grant
 *     on /tmp, which on macOS resolves to /private/tmp.
 *
 * Which test pins which rule was MEASURED, not assumed: each rule was inverted
 * in the implementation on its own and this file re-run.
 *
 *   isAbsolute dropped                  -> 1 red: `refuses a relative path`
 *   name compared on the RESOLVED path  -> 1 red: the nvm symlink test
 *   the RESOLVED path returned for storage -> 3 red: the nvm symlink test and,
 *       because os.tmpdir() on macOS lies under /var -> /private/var, the two
 *       other accept tests. On a host whose tmpdir is not symlinked only the
 *       nvm test would catch it, which is why that fixture is a link to a
 *       DIFFERENTLY NAMED file rather than a plain one.
 *   userData left unresolved            -> 3 red: all three userData tests
 *   chosen-side containment dropped     -> 1 red: the link inside userData
 *   target-side containment dropped     -> 1 red: the link pointing into userData
 *   win32 comparison made case-exact    -> 1 red: `folds case on win32`
 *   case folded on EVERY platform       -> 2 red: `does not fold case on darwin`
 *       and the end-to-end `refuses an upper-case NPM on a POSIX host`. That
 *       second one is also the only available proof of the WIRING — that
 *       validateChosenFile's spelling decision really runs through
 *       basenameIsAllowed — because on a POSIX host the win32 branch itself is
 *       unobservable through validateChosenFile.
 *
 * The five containment and resolution rows were measured on 2026-11-24, the two
 * case-folding rows on 2026-11-25, when the name-on-resolved row was
 * re-measured against the moved comparison and still stood. The isAbsolute row
 * is from 2026-11-25 as well, and it is the reason this table is kept: the
 * relative-path test as first written left isAbsolute at ZERO coverage (the
 * mutation turned nothing red), which is exactly what a missing row means. The
 * source was restored from a byte-identical copy after every mutation (`shasum`
 * compared).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import path from 'path'

/** The names this module must accept — written out, never imported. */
const EXPECTED_NAMES = ['npm', 'git', 'pytest']

const EXEC_MODE = 0o755
const NO_EXEC_MODE = 0o644

// `app.getPath('userData')` is read inside validateChosenFile, so the mock has
// to stand before the module graph loads.
const dirs = vi.hoisted(() => {
  const { mkdirSync: mkdir, mkdtempSync: mkdtemp, symlinkSync: symlink } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  const root = mkdtemp(join(tmpdir(), 'mingly-interpreter-'))
  const userDataReal = join(root, 'userdata-real')
  mkdir(userDataReal)
  const userDataLink = join(root, 'userdata-link')
  symlink(userDataReal, userDataLink)
  return { root, userDataReal, userDataLink }
})

const showOpenDialog = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dirs.userDataLink : dirs.root)
  },
  dialog: { showOpenDialog }
}))

import {
  allowedBasenames,
  basenameIsAllowed,
  chooseInterpreter,
  listInterpreters,
  removeInterpreter,
  validateChosenFile
} from '../../src/main/coding/interpreter-settings'
import { INTERPRETER_NAMES } from '../../src/main/coding/run-command'
import { SimpleStore } from '../../src/main/utils/simple-store'

/** An executable regular file at `target`, parents created. */
function makeExecutable(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, '#!/bin/sh\nexit 0\n')
  chmodSync(target, EXEC_MODE)
}

function link(from: string, to: string): void {
  mkdirSync(path.dirname(from), { recursive: true })
  symlinkSync(to, from)
}

const at = (...segments: string[]): string => path.join(dirs.root, ...segments)

beforeAll(() => {
  // Plain, directly usable files — one per interpreter name.
  for (const name of EXPECTED_NAMES) makeExecutable(at('bin', name))
  // Valid in every respect except the name the caller passes.
  makeExecutable(at('bin', 'ls'))
  makeExecutable(at('bin', 'node'))
  makeExecutable(at('bin', 'npm.cmd'))
  // The nvm shape: a link called npm whose target is called npm-cli.js.
  makeExecutable(at('nvm', 'lib', 'npm-cli.js'))
  link(at('nvm', 'bin', 'npm'), path.join('..', 'lib', 'npm-cli.js'))
  // A regular file called npm that nobody may execute.
  mkdirSync(at('noexec'), { recursive: true })
  writeFileSync(at('noexec', 'npm'), 'text\n')
  chmodSync(at('noexec', 'npm'), NO_EXEC_MODE)
  // A DIRECTORY called npm (rule 1: the name must pass so the file check runs).
  mkdirSync(at('as-dir', 'npm'), { recursive: true })
  // A link with no target.
  link(at('dangling', 'npm'), at('does-not-exist', 'npm'))
  // An upper-case NPM with no lower-case sibling: on a case-insensitive
  // filesystem a sibling would make this the SAME file and realpath would
  // hand back the other spelling.
  makeExecutable(at('upper', 'NPM'))
  // A space and a non-ASCII character in the chosen path.
  makeExecutable(at('mit Lücke', 'äöü', 'npm'))
  // Inside userData: a plain file, a payload a link outside points at, and a
  // link inside userData whose target is a perfectly good file outside.
  makeExecutable(path.join(dirs.userDataReal, 'npm'))
  makeExecutable(path.join(dirs.userDataReal, 'payload'))
  link(at('points-in', 'npm'), path.join(dirs.userDataReal, 'payload'))
  link(path.join(dirs.userDataReal, 'sub', 'npm'), at('nvm', 'lib', 'npm-cli.js'))
})

afterAll(() => {
  rmSync(dirs.root, { recursive: true, force: true })
})

describe('allowedBasenames', () => {
  it('allows only the bare name on every platform but win32', () => {
    expect(allowedBasenames('npm', 'darwin')).toEqual(['npm'])
    expect(allowedBasenames('npm', 'linux')).toEqual(['npm'])
  })

  it('allows the bare name, .cmd and .exe on win32', () => {
    expect(allowedBasenames('npm', 'win32')).toEqual(['npm', 'npm.cmd', 'npm.exe'])
  })
})

describe('basenameIsAllowed', () => {
  it('folds case on win32', () => {
    // Windows filesystems are case-insensitive: NPM.CMD and npm.cmd are the
    // same file there, so refusing one spelling is not strictness, only
    // inconsistency about which spelling the dialog happened to return.
    expect(basenameIsAllowed('npm', 'NPM.CMD', 'win32')).toBe(true)
    expect(basenameIsAllowed('npm', 'Npm.Cmd', 'win32')).toBe(true)
    expect(basenameIsAllowed('npm', 'NPM', 'win32')).toBe(true)
  })

  it('does not fold case on darwin', () => {
    // The negative control. Without it the win32 case does not show that the
    // distinction hangs on the PLATFORM rather than on case folding everywhere.
    expect(basenameIsAllowed('npm', 'NPM', 'darwin')).toBe(false)
    expect(basenameIsAllowed('npm', 'npm', 'darwin')).toBe(true)
  })

  it('still refuses another program on win32', () => {
    // Folding case is not a free pass: an implementation that lower-cased and
    // then matched loosely would pass both tests above and fail this one.
    expect(basenameIsAllowed('npm', 'ls.cmd', 'win32')).toBe(false)
    expect(basenameIsAllowed('npm', 'npm.bat', 'win32')).toBe(false)
  })
})

describe('validateChosenFile', () => {
  it('knows exactly the three interpreter names', () => {
    expect([...INTERPRETER_NAMES]).toEqual(EXPECTED_NAMES)
  })

  it('accepts a plain executable file for every interpreter name', () => {
    for (const name of EXPECTED_NAMES) {
      expect(validateChosenFile(name, at('bin', name))).toBe(at('bin', name))
    }
  })

  it('refuses an unknown interpreter name', () => {
    // The file itself is beyond reproach: absolute, named node, executable.
    expect(validateChosenFile('node', at('bin', 'node'))).toBeNull()
  })

  it('refuses a relative path', () => {
    // The relative spelling must point at a file that would otherwise be
    // ACCEPTED, so that isAbsolute is the only check it can fail. A relative
    // path into nowhere (the first version of this test used `bin/npm`, which
    // does not exist under the test runner's cwd) is refused by realpath
    // instead, and the test then stays green with isAbsolute deleted —
    // measured, 20/20 passed. Same instrument rule as the directory fixture.
    const relative = path.relative(process.cwd(), at('bin', 'npm'))
    // Positive control, in the same run: the spelling is really relative and
    // really reaches the accepted file. Without it, "refused" could just mean
    // "nothing there".
    expect(path.isAbsolute(relative)).toBe(false)
    expect(realpathSync(relative)).toBe(realpathSync(at('bin', 'npm')))

    expect(validateChosenFile('npm', relative)).toBeNull()
  })

  it('refuses a basename that does not match', () => {
    expect(validateChosenFile('npm', at('bin', 'ls'))).toBeNull()
  })

  it('refuses a directory', () => {
    expect(validateChosenFile('npm', at('as-dir', 'npm'))).toBeNull()
  })

  it('refuses a file that is not executable', () => {
    expect(validateChosenFile('npm', at('noexec', 'npm'))).toBeNull()
  })

  it('refuses a link with no target instead of throwing', () => {
    expect(validateChosenFile('npm', at('dangling', 'npm'))).toBeNull()
  })

  it('refuses npm.cmd on a POSIX host', () => {
    // This suite runs on POSIX only, as coding-git-hook-real-fs.test.ts states
    // for itself. The win32 halves of the rule are pinned on allowedBasenames
    // and basenameIsAllowed.
    expect(validateChosenFile('npm', at('bin', 'npm.cmd'))).toBeNull()
  })

  it('refuses an upper-case NPM on a POSIX host', () => {
    // The wiring: case folding must not reach the trust boundary off win32.
    expect(validateChosenFile('npm', at('upper', 'NPM'))).toBeNull()
  })

  // Pins the name comparison AND the stored value against the chosen path.
  it('accepts a symlink whose target has another basename, and returns the LINK', () => {
    expect(validateChosenFile('npm', at('nvm', 'bin', 'npm'))).toBe(at('nvm', 'bin', 'npm'))
  })

  // Pins that the stored value is the chosen path, byte for byte.
  it('accepts a path with a space and a non-ASCII character, unchanged', () => {
    const chosen = at('mit Lücke', 'äöü', 'npm')
    expect(validateChosenFile('npm', chosen)).toBe(chosen)
  })

  it('refuses a chosen path inside userData', () => {
    expect(validateChosenFile('npm', path.join(dirs.userDataReal, 'npm'))).toBeNull()
  })

  it('refuses a symlink pointing into userData', () => {
    expect(validateChosenFile('npm', at('points-in', 'npm'))).toBeNull()
  })

  // The target is a legitimate file outside userData, so only the chosen side
  // of the containment check can refuse this one.
  it('refuses a symlink that sits inside userData and points out', () => {
    expect(validateChosenFile('npm', path.join(dirs.userDataReal, 'sub', 'npm'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Reading, writing and removing — the layer around the trust boundary.
//
// Mutation table, measured 2026-11-25 (each rule inverted alone, file re-run,
// source restored afterwards):
//   `canceled` not checked                  -> 1 red: `writes nothing when the dialog is cancelled`
//   validation result ignored               -> 2 red: refused-result test and its untouched-entry twin
//   unknown-name guard removed in choose    -> 1 red: `refuses an unknown name without opening a dialog`
//   confirmedAt not written                 -> 1 red: `writes paths[name] and confirmedAt[name]`
//   found no longer asks the filesystem     -> 1 red: `reports found:false when ... no longer exists`
//   confirmed taken from the path alone     -> 2 red: no-marker and unusable-marker tests
//   remove leaves confirmedAt behind        -> 1 red: `removeInterpreter clears both keys`
//   defaultPath always passed               -> 1 red: the no-defaultPath dialog test
//   (2026-11-25, fix round 1) store maps read BEFORE the dialog await:
//   both maps                               -> 2 red: removal-during-dialog and lost-choice tests
//   only confirmedAt                        -> 2 red (same two)
//   only paths                              -> 2 red (same two)
//   Both tests were red against the unfixed source first (2 failed | 37 passed).
// ---------------------------------------------------------------------------

const STORE_FILE = path.join(dirs.userDataReal, 'coding-interpreters.json')
const NOW = 1764000000000

/** Seed the store file as it would sit on disk, then force a fresh load. */
function seedStore(content: unknown): void {
  writeFileSync(STORE_FILE, JSON.stringify(content))
  SimpleStore._resetForTesting()
}

function storeOnDisk(): { paths?: Record<string, string>; confirmedAt?: Record<string, number> } {
  return JSON.parse(readFileSync(STORE_FILE, 'utf-8'))
}

function dialogReturns(filePaths: string[], canceled = false): void {
  showOpenDialog.mockResolvedValueOnce({ canceled, filePaths })
}

describe('interpreter settings: read, write, remove', () => {
  beforeEach(() => {
    rmSync(STORE_FILE, { force: true })
    SimpleStore._resetForTesting()
    showOpenDialog.mockReset()
  })

  it('lists all three names, unset when the store is empty', () => {
    expect(listInterpreters()).toEqual([
      { name: 'npm', path: null, confirmed: false, found: false },
      { name: 'git', path: null, confirmed: false, found: false },
      { name: 'pytest', path: null, confirmed: false, found: false }
    ])
  })

  it('reports an entry with a marker as confirmed and found', () => {
    seedStore({ paths: { git: at('bin', 'git') }, confirmedAt: { git: NOW } })
    expect(listInterpreters().find((s) => s.name === 'git')).toEqual({
      name: 'git', path: at('bin', 'git'), confirmed: true, found: true
    })
  })

  it('reports an entry without a marker as confirmed:false but keeps its path', () => {
    seedStore({ paths: { npm: at('bin', 'npm') } })
    expect(listInterpreters().find((s) => s.name === 'npm')).toEqual({
      name: 'npm', path: at('bin', 'npm'), confirmed: false, found: true
    })
  })

  it('reports confirmed:false for an unusable marker', () => {
    seedStore({ paths: { npm: at('bin', 'npm') }, confirmedAt: { npm: 'yesterday' } })
    expect(listInterpreters().find((s) => s.name === 'npm')?.confirmed).toBe(false)
  })

  it('reports found:false when the stored path no longer exists', () => {
    const gone = at('gone', 'pytest')
    seedStore({ paths: { pytest: gone }, confirmedAt: { pytest: NOW } })
    expect(existsSync(gone)).toBe(false)
    expect(listInterpreters().find((s) => s.name === 'pytest')).toEqual({
      name: 'pytest', path: gone, confirmed: true, found: false
    })
  })

  it('writes paths[name] and confirmedAt[name] on a valid choice', async () => {
    dialogReturns([at('bin', 'npm')])
    const before = Date.now()
    await expect(chooseInterpreter('npm')).resolves.toBe(true)
    const disk = storeOnDisk()
    expect(disk.paths).toEqual({ npm: at('bin', 'npm') })
    expect(disk.confirmedAt?.npm).toBeGreaterThanOrEqual(before)
    expect(disk.confirmedAt?.npm).toBeLessThanOrEqual(Date.now())
    expect(Object.keys(disk).sort()).toEqual(['confirmedAt', 'paths'])
    expect(listInterpreters()[0]).toEqual({ name: 'npm', path: at('bin', 'npm'), confirmed: true, found: true })
  })

  it('keeps the other entries when one name is chosen', async () => {
    seedStore({ paths: { git: at('bin', 'git') }, confirmedAt: { git: NOW } })
    dialogReturns([at('bin', 'npm')])
    await chooseInterpreter('npm')
    const disk = storeOnDisk()
    expect(disk.paths).toEqual({ git: at('bin', 'git'), npm: at('bin', 'npm') })
    expect(disk.confirmedAt?.git).toBe(NOW)
  })

  it('opens the dialog with openFile, no parent window and no defaultPath when nothing is stored', async () => {
    dialogReturns([], true)
    await chooseInterpreter('git')
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    const args = showOpenDialog.mock.calls[0]
    expect(args).toHaveLength(1) // no BrowserWindow first argument
    expect(args[0].properties).toEqual(['openFile'])
    expect(typeof args[0].title).toBe('string')
    expect(typeof args[0].message).toBe('string')
    expect('defaultPath' in args[0]).toBe(false)
  })

  it('starts the dialog in the directory of the stored entry', async () => {
    seedStore({ paths: { git: at('bin', 'git') } })
    dialogReturns([], true)
    await chooseInterpreter('git')
    expect(showOpenDialog.mock.calls[0][0].defaultPath).toBe(at('bin'))
  })

  it('writes nothing when the dialog is cancelled', async () => {
    // Positive control: the same call with a valid pick DOES write, so the
    // empty file below is not a spy or a store that never worked.
    dialogReturns([at('bin', 'npm')])
    await chooseInterpreter('npm')
    expect(existsSync(STORE_FILE)).toBe(true)
    rmSync(STORE_FILE)
    SimpleStore._resetForTesting()

    // A cancelled dialog that still carries a valid-looking path.
    dialogReturns([at('bin', 'npm')], true)
    await expect(chooseInterpreter('npm')).resolves.toBe(false)
    expect(showOpenDialog).toHaveBeenCalledTimes(2)
    expect(existsSync(STORE_FILE)).toBe(false)
  })

  it('writes nothing when the dialog returns no file', async () => {
    dialogReturns([])
    await expect(chooseInterpreter('npm')).resolves.toBe(false)
    expect(existsSync(STORE_FILE)).toBe(false)
  })

  it('writes nothing when validation refuses the dialog result', async () => {
    // `ls` is executable and absolute, but not an npm.
    expect(validateChosenFile('npm', at('bin', 'ls'))).toBeNull()
    dialogReturns([at('bin', 'ls')])
    await expect(chooseInterpreter('npm')).resolves.toBe(false)
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect(existsSync(STORE_FILE)).toBe(false)
  })

  it('leaves an existing entry untouched when the new choice is refused', async () => {
    seedStore({ paths: { npm: at('bin', 'npm') }, confirmedAt: { npm: NOW } })
    dialogReturns([at('bin', 'ls')])
    await expect(chooseInterpreter('npm')).resolves.toBe(false)
    expect(storeOnDisk()).toEqual({ paths: { npm: at('bin', 'npm') }, confirmedAt: { npm: NOW } })
  })

  // The dialog is deliberately not tied to a window, so the settings page stays
  // usable while it is open. Whatever happens in that gap must survive: the
  // mock performs the interleaved action itself, which pins the window
  // deterministically.
  it('does not undo a removal made while the dialog was open', async () => {
    seedStore({
      paths: { git: at('bin', 'git') },
      confirmedAt: { git: NOW }
    })
    showOpenDialog.mockImplementationOnce(async () => {
      expect(removeInterpreter('git')).toBe(true) // the revocation, mid-dialog
      return { canceled: false, filePaths: [at('bin', 'npm')] }
    })
    await expect(chooseInterpreter('npm')).resolves.toBe(true)
    const disk = storeOnDisk()
    expect(disk.paths).toEqual({ npm: at('bin', 'npm') })
    expect(Object.keys(disk.confirmedAt ?? {})).toEqual(['npm'])
    expect(listInterpreters().find((e) => e.name === 'git')?.confirmed).toBe(false)
  })

  it('does not lose a choice completed while another dialog was open', async () => {
    showOpenDialog.mockImplementationOnce(async () => {
      // A second choice runs to completion inside the first one's dialog.
      dialogReturns([at('bin', 'npm')])
      await expect(chooseInterpreter('npm')).resolves.toBe(true)
      return { canceled: false, filePaths: [at('bin', 'git')] }
    })
    await expect(chooseInterpreter('git')).resolves.toBe(true)
    const disk = storeOnDisk()
    expect(disk.paths).toEqual({ npm: at('bin', 'npm'), git: at('bin', 'git') })
    expect(Object.keys(disk.confirmedAt ?? {}).sort()).toEqual(['git', 'npm'])
  })

  it('refuses an unknown name without opening a dialog', async () => {
    await expect(chooseInterpreter('rm')).resolves.toBe(false)
    expect(showOpenDialog).not.toHaveBeenCalled()
    expect(existsSync(STORE_FILE)).toBe(false)
  })

  it('removeInterpreter clears both keys and only that name', () => {
    seedStore({
      paths: { npm: at('bin', 'npm'), git: at('bin', 'git') },
      confirmedAt: { npm: NOW, git: NOW }
    })
    expect(removeInterpreter('npm')).toBe(true)
    expect(storeOnDisk()).toEqual({ paths: { git: at('bin', 'git') }, confirmedAt: { git: NOW } })
    expect(listInterpreters()[0]).toEqual({ name: 'npm', path: null, confirmed: false, found: false })
  })

  it('removeInterpreter also clears an unconfirmed entry', () => {
    seedStore({ paths: { npm: at('bin', 'npm') } })
    expect(removeInterpreter('npm')).toBe(true)
    expect(storeOnDisk().paths).toEqual({})
  })

  it('removeInterpreter refuses an unknown name and writes nothing', () => {
    expect(removeInterpreter('rm')).toBe(false)
    expect(existsSync(STORE_FILE)).toBe(false)
  })
})
