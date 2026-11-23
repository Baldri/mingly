/**
 * A git hook at the DEFAULT location runs during the allowlisted git commands —
 * real git, real filesystem.
 *
 * `gitConfigIsSafe` (run-command.ts) refuses a repository whose config names a
 * program: a `filter` section, an `include`/`includeIf` section, or a key ending
 * in `command`. A hook does not need any of that. It is a file at
 * `.git/hooks/<name>`, found by its PATH, with no config entry anywhere — so the
 * probe cannot catch it whatever keys it refuses. This is a sharper gap than the
 * submodule one in coding-git-submodule-filter-real-fs.test.ts: there the driver
 * lived in a config scope the probe did not ask about, here there is no config
 * to ask about at all.
 *
 * The hook that fires is `post-index-change`: `git status` and `git diff` both
 * refresh the stat cache and write the index back when a file's mtime moved
 * while its content stayed equal. Measured on git 2.53.0 before the fix: one
 * hook run per allowlisted command, `diff --stat` included.
 *
 * git is NOT mocked. The defect is a statement about what git executes, and a
 * mock would only replay the belief under test. Everything runs in a fresh
 * mkdtemp directory.
 *
 * FOUR INSTRUMENT RULES are encoded as assertions below. The first two silently
 * produced a false result while this test was being written:
 *
 *  1. The index refresh is CONSUMED by the first command that runs. The fixture
 *     therefore settles the "is the file clean" question BEFORE the hook exists
 *     and moves the mtime AFTER — otherwise the check itself absorbs the
 *     refresh, the hook has nothing to fire on, and every assertion below passes
 *     for the wrong reason. `buildFixture` ends by asserting it is at zero runs.
 *  2. The positive control must not take its subcommand from the module under
 *     test. Slicing a prefix of the EXPECTED length off `plannedArgs` cuts real
 *     arguments while the fix is absent, which starts git without a subcommand:
 *     red, but for a reason that has nothing to do with hooks. The control
 *     spells the subcommand out from the command line itself.
 *  3. The fixture is rebuilt for EVERY test, for the same reason as rule 1.
 *  4. `--no-optional-locks` is NOT the fix, and one test pins why: measured, it
 *     silences `status` but NOT `diff`. It is the plausible-looking half
 *     measure, so the asymmetry is recorded rather than left to be rediscovered.
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
 * whatever the code does. `/dev/null` is spelled out rather than taken from
 * `os.devNull` for the same reason — this file does not run on Windows.
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
const UNPROTECTED_GIT_PREFIX = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '--no-pager'
]

/**
 * The absolute path to git. planCommand accepts an interpreter only as an
 * absolute path (it never consults PATH), so a bare "git" is refused before the
 * hook question is ever reached.
 */
const GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf-8' }).trim()

/** Every allowlisted git command, each of which refreshes the index. */
const ALLOWED_GIT_LINES = [
  'git status',
  'git status --short',
  'git diff --stat',
  'git diff --name-only'
] as const

const roots: string[] = []

/** git with no influence from the developer's or the runner's own config. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid'
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync(GIT, args, { cwd, env: gitEnv(), encoding: 'utf-8' })
}

interface Fixture {
  /** The granted project. */
  dir: string
  /** Every hook run appends a line here. */
  marker: string
}

/**
 * A repository with a `post-index-change` hook that records each time it runs,
 * and a file whose mtime moved while its bytes stayed the same.
 *
 * `hooksPath` puts the hook in a directory the repository CONFIGURES instead of
 * the default one, which is the husky arrangement — used below to show both
 * that the fix still covers it and that such a repository keeps working.
 */
function buildFixture(hooksPath?: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-git-hook-'))
  roots.push(root)
  const dir = path.join(root, 'project')
  fs.mkdirSync(dir)
  const marker = path.join(root, 'marker.txt')

  git(dir, ['init', '-q', '-b', 'main', '.'])
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'hello\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])

  // Rule 1: settle the cleanliness question HERE, while no hook exists. This
  // command consumes the index refresh the commit left behind; the mtime is
  // moved afterwards so there is exactly one refresh left for the test.
  expect(git(dir, ['status', '--porcelain'])).toBe('')

  const hookDir = hooksPath ? path.join(dir, hooksPath) : path.join(dir, '.git', 'hooks')
  fs.mkdirSync(hookDir, { recursive: true })
  if (hooksPath) git(dir, ['config', 'core.hooksPath', hooksPath])

  const hook = path.join(hookDir, 'post-index-change')
  fs.writeFileSync(hook, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n`)
  fs.chmodSync(hook, 0o755)

  // Same bytes, older mtime: this and only this makes git rewrite the index to
  // refresh its stat cache, which is what fires post-index-change.
  const stale = new Date(2000, 0, 1)
  fs.utimesSync(file, stale, stale)

  // Rule 1, as an assertion: nothing has fired yet, so a count above zero in a
  // test is the test's own doing.
  expect(hookRuns(marker)).toBe(0)
  return { dir, marker }
}

/** How many times the hook ran. */
function hookRuns(marker: string): number {
  if (!fs.existsSync(marker)) return 0
  return fs.readFileSync(marker, 'utf-8').split('\n').filter(Boolean).length
}

function plannedArgs(line: string, dir: string): string[] {
  const plan: CommandPlan = planCommand(line, dir, { git: GIT })
  if (plan.kind !== 'run') throw new Error(`expected a runnable plan for "${line}"`)
  return plan.args
}

function runGit(args: string[], cwd: string): string {
  return execFileSync(GIT, args, { cwd, env: gitEnv(), encoding: 'utf-8' })
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

// Hook shebangs and the executable bit do not carry to Windows, and the project
// runs its test matrix on ubuntu and macos.
describe.skipIf(process.platform === 'win32')('a git hook at the default location', () => {
  let fx: Fixture

  beforeEach(() => {
    fx = buildFixture()
  })

  it.each(ALLOWED_GIT_LINES)(
    'POSITIVE CONTROL: %s runs the hook without the hooksPath switch',
    (line) => {
      // Rule 2: the subcommand comes from the command line, not from the
      // planner. Per command rather than once for the suite, because
      // `--no-optional-locks` silences `status` while leaving `diff` open — a
      // single control would hide half the defect.
      const sub = line.split(' ').slice(1)
      runGit([...UNPROTECTED_GIT_PREFIX, ...sub], fx.dir)
      expect(hookRuns(fx.marker)).toBeGreaterThan(0)
    }
  )

  it('the config probe cannot see the hook: it has no config entry at all', () => {
    // Why the fix cannot live in gitConfigIsSafe. A statement about git that
    // holds before and after the fix.
    const listing = git(fx.dir, [
      'config',
      '--list',
      '--name-only',
      '--show-scope',
      '--no-includes'
    ])
    expect(listing).not.toMatch(/hookspath/i)
    expect(fs.existsSync(path.join(fx.dir, '.git', 'hooks', 'post-index-change'))).toBe(true)
  })

  it.each(ALLOWED_GIT_LINES)('%s does not run the hook', (line) => {
    runGit(plannedArgs(line, fx.dir), fx.dir)
    expect(hookRuns(fx.marker)).toBe(0)
  })

  it.each(ALLOWED_GIT_LINES)('%s carries the hooksPath switch in its argv', (line) => {
    const args = plannedArgs(line, fx.dir)
    expect(args.slice(0, EXPECTED_GIT_PREFIX.length)).toEqual(EXPECTED_GIT_PREFIX)
  })

  it('--no-optional-locks is NOT a substitute: it silences status but not diff', () => {
    // Measured, and pinned here because it is the plausible-looking half
    // measure. A fresh fixture per command, as the first one absorbs the
    // refresh (rule 3).
    const statusFx = buildFixture()
    runGit([...UNPROTECTED_GIT_PREFIX, '--no-optional-locks', 'status', '--short'], statusFx.dir)
    expect(hookRuns(statusFx.marker)).toBe(0)

    const diffFx = buildFixture()
    runGit([...UNPROTECTED_GIT_PREFIX, '--no-optional-locks', 'diff', '--stat'], diffFx.dir)
    expect(hookRuns(diffFx.marker)).toBeGreaterThan(0)
  })

  it('a repository that configures its own hooksPath is still denied the hook', () => {
    // The husky arrangement: core.hooksPath set in the repository's own config.
    // A command-line `-c` outranks it, measured.
    const husky = buildFixture('.husky')
    runGit(plannedArgs('git status --short', husky.dir), husky.dir)
    expect(hookRuns(husky.marker)).toBe(0)
  })

  it('FALSE ALARM CHECK: a repository with its own hooksPath still works', () => {
    // The reason core.hooksPath is deliberately NOT added to
    // gitConfigNamesProgram: husky sets exactly this key, and refusing it would
    // make every husky project unusable for no gain, since a hook at the
    // default path needs no key at all.
    const husky = buildFixture('.husky')
    const out = runGit(plannedArgs('git status --short', husky.dir), husky.dir)
    expect(out).toContain('.husky/')
  })
})

/**
 * A SUBMODULE's own hook directory — the second, independent way to the same
 * state, and the reason this is a test rather than a note.
 *
 * A submodule keeps its hooks in `.git/modules/<name>/hooks/`, which the
 * superproject's `.git/hooks` never covers. Measured on git 2.53.0, each switch
 * closes it on its OWN (A/B, one variable at a time, nacktes git as the control
 * in the same run):
 *
 *   naked git                       submodule hook ran 1x  (status and diff)
 *   only -c core.hooksPath=devNull  0x  — the `-c` carries into the submodule
 *   only --ignore-submodules=all    0x  — git never looks inside
 *
 * Both, independently. So these four tests are NOT evidence for the hooksPath
 * fix — they were already green before it, on `--ignore-submodules=all` alone.
 * What they pin is the state, and that is the point: removing either switch as
 * "redundant, the other covers it" leaves this path with a single barrier, and
 * removing both leaves none, with nothing else in the suite noticing.
 */
describe.skipIf(process.platform === 'win32')("a hook in a submodule's own directory", () => {
  interface SubFixture {
    superDir: string
    marker: string
  }

  function buildSubmoduleFixture(): SubFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-submodule-hook-'))
    roots.push(root)
    const marker = path.join(root, 'marker.txt')

    const src = path.join(root, 'sub-src')
    fs.mkdirSync(src)
    git(src, ['init', '-q', '-b', 'main', '.'])
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello\n')
    git(src, ['add', '-A'])
    git(src, ['commit', '-q', '-m', 'init'])

    const superDir = path.join(root, 'project')
    fs.mkdirSync(superDir)
    git(superDir, ['init', '-q', '-b', 'main', '.'])
    fs.writeFileSync(path.join(superDir, 'r.txt'), 'root\n')
    git(superDir, ['add', '-A'])
    git(superDir, ['commit', '-q', '-m', 'init'])
    git(superDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'sub'])
    git(superDir, ['commit', '-q', '-m', 'add submodule'])

    const subDir = path.join(superDir, 'sub')
    // Rule 1 again: consume the submodule's pending index refresh BEFORE the
    // hook exists, then move the mtime.
    expect(git(subDir, ['status', '--porcelain'])).toBe('')

    const subGitDir = git(subDir, ['rev-parse', '--absolute-git-dir']).trim()
    const hookDir = path.join(subGitDir, 'hooks')
    fs.mkdirSync(hookDir, { recursive: true })
    const hook = path.join(hookDir, 'post-index-change')
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n`)
    fs.chmodSync(hook, 0o755)

    const stale = new Date(2000, 0, 1)
    fs.utimesSync(path.join(subDir, 'a.txt'), stale, stale)

    expect(hookRuns(marker)).toBe(0)
    return { superDir, marker }
  }

  it.each(['git status --short', 'git diff --stat'])(
    'POSITIVE CONTROL: %s runs the submodule hook with neither switch',
    (line) => {
      const fx = buildSubmoduleFixture()
      const sub = line.split(' ').slice(1)
      runGit(['-c', 'core.fsmonitor=false', '--no-pager', ...sub], fx.superDir)
      expect(hookRuns(fx.marker)).toBeGreaterThan(0)
    }
  )

  it.each(['git status --short', 'git diff --stat'])('%s does not run it', (line) => {
    const fx = buildSubmoduleFixture()
    runGit(plannedArgs(line, fx.superDir), fx.superDir)
    expect(hookRuns(fx.marker)).toBe(0)
  })
})
