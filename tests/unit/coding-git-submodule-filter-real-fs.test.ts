/**
 * A submodule's own config names a program — real git, real filesystem.
 *
 * `gitConfigIsSafe` (run-command.ts) refuses a repository whose config defines
 * a `filter`, an `include` or a key ending in `command`. It asks
 * `git config --list --name-only --show-scope --no-includes`, and that listing
 * covers the scopes of the SUPERPROJECT: `local` and `worktree`. A submodule
 * keeps its own config in `.git/modules/<name>/config`, which is none of them —
 * so a `filter.<name>.clean` living there is invisible to the probe, while
 * `git status` and `git diff` reach into the submodule worktree and run it.
 *
 * Measured on git 2.53.0 before the fix: each of the three allowlisted git
 * commands executed the submodule's clean driver four times per run.
 *
 * git is NOT mocked here, and that is the point. The defect is a statement
 * about what git does with a config this app never read; a mock would only
 * replay the belief under test. Everything runs in a fresh mkdtemp directory.
 *
 * TWO INSTRUMENT RULES are encoded as assertions below, because both of them
 * silently produced a false "all clear" while this test was being written:
 *
 *  1. The worktree content must have the SAME BYTE LENGTH as the indexed
 *     content. git compares the size from the index entry first; if it differs,
 *     the file is modified and is never hashed — no hashing, no
 *     `convert_to_git`, no clean filter. `hello` vs `hello-changed` made every
 *     case look clean, the positive control included.
 *  2. The fixture is rebuilt for EVERY test. A `git status` writes the
 *     refreshed stat cache back, so a second run against the same fixture
 *     hashes less (measured: 4 filter calls, then 1).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { planCommand, type CommandPlan } from '../../src/main/coding/command-allowlist'

/**
 * The argv prefix as it is EXPECTED to be, written out by hand. Never imported
 * from the module under test: a shared constant would make this test agree with
 * whatever the code does.
 *
 * `core.hooksPath` joined it afterwards, for a defect of its own: a hook at
 * `.git/hooks/<name>` needs no config entry, so gitConfigIsSafe cannot see it
 * either. Asserted in tests/unit/coding-git-hook-real-fs.test.ts. It is listed
 * here because this test pins the WHOLE prefix, and `/dev/null` is spelled out
 * rather than taken from `os.devNull` because this file does not run on Windows.
 */
const EXPECTED_GIT_PREFIX = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'core.hooksPath=/dev/null',
  '--no-pager'
]

/** The prefix BEFORE this fix — the positive control runs with it. */
const UNPROTECTED_GIT_PREFIX = ['-c', 'core.fsmonitor=false', '--no-pager']

/**
 * The absolute path to git. planCommand accepts an interpreter only as an
 * absolute path (it never consults PATH), so a bare "git" is refused before the
 * submodule question is ever reached — which made the first version of this
 * test fail for a reason that had nothing to do with the defect.
 */
const GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf-8' }).trim()

const roots: string[] = []

/** git with no influence from the developer's or the runner's own config. */
function gitEnv(marker: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    MINGLY_TEST_MARKER: marker
  }
}

function git(cwd: string, args: string[], marker: string): string {
  return execFileSync(GIT, args, { cwd, env: gitEnv(marker), encoding: 'utf-8' })
}

interface Fixture {
  /** The granted project: a superproject with one submodule. */
  superDir: string
  /** Every line the clean driver appends lands here. */
  marker: string
}

/**
 * A superproject whose submodule carries a clean filter in its OWN config, with
 * a dirty file that git can only classify by hashing it.
 */
function buildFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-submodule-filter-'))
  roots.push(root)
  const marker = path.join(root, 'marker.txt')

  // The "program" the submodule's config names. Node rather than a shell
  // script: no shebang, no chmod, and it is on PATH wherever vitest runs.
  const spy = path.join(root, 'spy.js')
  fs.writeFileSync(
    spy,
    `const fs = require('fs')\n` +
      `fs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n')\n` +
      `process.stdin.pipe(process.stdout)\n`
  )

  // --- the submodule's source repository ---
  const src = path.join(root, 'sub-src')
  fs.mkdirSync(src)
  git(src, ['init', '-q', '-b', 'main', '.'], marker)
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello\n')
  fs.writeFileSync(path.join(src, '.gitattributes'), 'a.txt filter=spy\n')
  git(src, ['add', '-A'], marker)
  git(src, ['commit', '-q', '-m', 'init'], marker)

  // --- the superproject the user grants ---
  const superDir = path.join(root, 'project')
  fs.mkdirSync(superDir)
  git(superDir, ['init', '-q', '-b', 'main', '.'], marker)
  fs.writeFileSync(path.join(superDir, 'r.txt'), 'root\n')
  git(superDir, ['add', '-A'], marker)
  git(superDir, ['commit', '-q', '-m', 'init'], marker)
  git(
    superDir,
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'sub'],
    marker
  )
  git(superDir, ['commit', '-q', '-m', 'add submodule'], marker)

  // The filter driver goes ONLY into the submodule's own config. This is the
  // whole point: `git -C sub config` writes to .git/modules/sub/config, a scope
  // the superproject's config listing does not report.
  git(path.join(superDir, 'sub'), ['config', 'filter.spy.clean', `node ${spy}`], marker)

  // Dirty the submodule's file at CONSTANT LENGTH so git must hash it.
  const subFile = path.join(superDir, 'sub', 'a.txt')
  const indexed = fs.readFileSync(subFile)
  fs.writeFileSync(subFile, 'HELLO\n')
  expect(fs.readFileSync(subFile).length).toBe(indexed.length)

  return { superDir, marker }
}

/** How many times the submodule's clean driver ran. */
function filterRuns(marker: string): number {
  if (!fs.existsSync(marker)) return 0
  return fs.readFileSync(marker, 'utf-8').split('\n').filter(Boolean).length
}

function plannedArgs(line: string, superDir: string): string[] {
  const plan: CommandPlan = planCommand(line, superDir, { git: GIT })
  if (plan.kind !== 'run') throw new Error(`expected a runnable plan for "${line}"`)
  return plan.args
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

// chmod, shebangs and the path spelling of the filter command all differ on
// Windows, and the project runs its test matrix on ubuntu and macos.
describe.skipIf(process.platform === 'win32')(
  'a submodule config that names a program (real git)',
  () => {
    let fx: Fixture

    beforeEach(() => {
      fx = buildFixture()
    })

    it('POSITIVE CONTROL: the driver does run without the submodule switches', () => {
      // If this ever goes quiet, the fixture is broken and every assertion
      // below is worthless rather than reassuring.
      execFileSync(GIT, [...UNPROTECTED_GIT_PREFIX, 'status', '--short'], {
        cwd: fx.superDir,
        env: gitEnv(fx.marker),
        encoding: 'utf-8'
      })
      expect(filterRuns(fx.marker)).toBeGreaterThan(0)
    })

    it('the config probe cannot see the filter: it is not in a superproject scope', () => {
      // Why the fix cannot live in gitConfigIsSafe. This is a statement about
      // git, and it holds before and after the fix.
      const listing = git(
        fx.superDir,
        ['config', '--list', '--name-only', '--show-scope', '--no-includes'],
        fx.marker
      )
      expect(listing).not.toMatch(/filter\./)
    })

    it.each([
      ['git status'],
      ['git status --short'],
      ['git diff --stat'],
      ['git diff --name-only']
    ])('%s does not run the submodule driver', (line) => {
      const args = plannedArgs(line, fx.superDir)
      execFileSync(GIT, args, {
        cwd: fx.superDir,
        env: gitEnv(fx.marker),
        encoding: 'utf-8'
      })
      expect(filterRuns(fx.marker)).toBe(0)
    })

    it.each([
      ['git status'],
      ['git status --short'],
      ['git diff --stat'],
      ['git diff --name-only']
    ])('%s carries the submodule switches in its argv', (line) => {
      const args = plannedArgs(line, fx.superDir)
      expect(args.slice(0, EXPECTED_GIT_PREFIX.length)).toEqual(EXPECTED_GIT_PREFIX)
      expect(args).toContain('--ignore-submodules=all')
    })
  }
)
