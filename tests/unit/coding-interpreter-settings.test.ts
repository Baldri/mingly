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

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
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

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dirs.userDataLink : dirs.root)
  }
}))

import {
  allowedBasenames,
  basenameIsAllowed,
  validateChosenFile
} from '../../src/main/coding/interpreter-settings'
import { INTERPRETER_NAMES } from '../../src/main/coding/run-command'

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
