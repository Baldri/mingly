/**
 * mingly_run_command handler (Task 12), against REAL child processes.
 *
 * The "interpreters" are small /bin/sh scripts in a directory outside the
 * project; nothing here needs npm, git, node or pytest to be installed.
 * Expected values are written out by hand. There is no wall-clock assertion on
 * the code under test: process death is polled for as a STATE (the pid is
 * gone), with a generous ceiling that only bounds the test itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import {
  registerRunCommand,
  readInterpreterPaths,
  physicalPath,
  gitConfigNamesProgram,
  RUN_TOTAL_MS,
  RUN_COMMAND_MS,
  type RunLimits
} from '../../src/main/coding/run-command'
import { AGENT_RUN_TIMEOUT_MS } from '../../src/shared/types'
import { COMMAND_UNAVAILABLE } from '../../src/main/coding/command-allowlist'
import { ensureProjectWorkspace } from '../../src/main/coding/project-workspace'
import type { AllowedDirectory } from '../../src/shared/file-access-types'

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({ listAllTools: vi.fn().mockReturnValue([]) }))
}))

let project: string
let bins: string
let outside: string
let interpreters: Record<string, string>
let grants: AllowedDirectory[]

function grant(): AllowedDirectory {
  return {
    id: 'dir-1',
    path: project,
    name: 'p',
    location: 'local',
    permissions: ['read', 'edit'],
    recursive: true,
    grantedAt: 1,
    confirmedAt: 1
  }
}

function script(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

/**
 * A real git, used for ONE thing: answering `git config` for the stub below.
 *
 * The guard over a repository config no longer matches the file's text; it asks
 * git which key names the file defines, because git's config grammar has more
 * spellings than a regex can be trusted to enumerate — `[filter.lfs]` is the
 * one that got through. A hand-written answer here would re-encode this test's
 * own idea of that grammar, and that idea is what was wrong, so the stub
 * delegates the question to the authority. Everything else each test stubs
 * itself, so the suite stays independent of whether npm, node or pytest exist.
 * Any machine that can check this repository out has git.
 */
const REAL_GIT = ((): string => {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()

function fake(name: string, body: string): void {
  const prelude =
    name === 'git' && REAL_GIT !== ''
      ? `if [ "$1" = "config" ]; then exec "${REAL_GIT}" "$@"; fi\n`
      : ''
  interpreters[name] = script(path.join(bins, name), prelude + body)
}

function makeRegistry(limits: Partial<RunLimits> = {}, maxResultChars = 1_000_000): ToolRegistry {
  const registry = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars })
  registerRunCommand(registry, {
    findGrant: async (id) => grants.find((g) => g.id === id),
    getInterpreterPaths: () => interpreters,
    limits: limits as RunLimits
  })
  return registry
}

async function ctxFor(runId: string | null = 'run1'): Promise<ToolContext> {
  const workspace = await ensureProjectWorkspace(project, runId ?? 'x')
  return {
    coding: { directoryId: 'dir-1', projectPath: project, mode: 'propose-run' },
    workspace,
    ...(runId === null ? {} : { runId, stepNumber: 1 })
  }
}

async function run(registry: ToolRegistry, command: string, ctx?: ToolContext): Promise<string> {
  const result = await registry.executeTool(
    { id: 't', name: 'mingly_run_command', arguments: { command } },
    ctx ?? (await ctxFor())
  )
  return result.content
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number): Promise<boolean> {
  // The ceiling bounds the test, not the code: the assertion is on the state.
  for (let i = 0; i < 200; i++) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-run-cmd-')))
  bins = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-run-bins-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-run-out-')))
  interpreters = {}
  grants = [grant()]
  // The tool-root marks every allowlisted tool needs (package.json is left to
  // each test: its content matters). The marks suite below starts WITHOUT them.
  fs.mkdirSync(path.join(project, '.git'))
  for (const m of ['tsconfig.json', 'vitest.config.ts', 'pytest.ini']) fs.writeFileSync(path.join(project, m), '')
})

afterEach(() => {
  for (const d of [project, bins, outside]) fs.rmSync(d, { recursive: true, force: true })
})

describe('mingly_run_command execution', () => {
  it('starts the planned file with the exact argument vector and reports the exit code', async () => {
    fake('npm', 'echo "n=$# [$1] [$2]"; exit 3')
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    const out = await run(makeRegistry(), 'npm run build')
    expect(out).toContain('exit code 3')
    expect(out).toContain('n=2 [run] [build]')
  })

  it('runs in the project root, not in .mingly', async () => {
    fake('git', 'pwd')
    const out = await run(makeRegistry(), 'git status')
    expect(out).toContain(project)
    expect(out).not.toContain(path.join(project, '.mingly'))
  })

  it('passes git the switches that stop repository config from naming a program', async () => {
    fake('git', 'echo "argv:$*"')
    expect(await run(makeRegistry(), 'git status')).toContain('argv:-c core.fsmonitor=false --no-pager status')
    expect(await run(makeRegistry(), 'git diff --stat')).toContain(
      'argv:-c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv --stat'
    )
  })

  it('does not hand the Mingly process environment to the child', async () => {
    process.env.MINGLY_T12_SECRET = 'leak-me-0123'
    try {
      fake('git', 'env')
      const out = await run(makeRegistry(), 'git status')
      // Positive control: the script did run and printed its own environment.
      expect(out).toContain('CI=1')
      expect(out).toContain(`PATH=${bins}`)
      expect(out).not.toContain('leak-me-0123')
      expect(out).not.toContain('MINGLY_T12_SECRET')
    } finally {
      delete process.env.MINGLY_T12_SECRET
    }
  })

  it('strips terminal escapes and bidi characters from the output', async () => {
    fake('git', "printf '\\033[31mred\\033[0m \\342\\200\\256x\\n'")
    const out = await run(makeRegistry(), 'git status')
    expect(out).toContain('red x')
    expect(out).not.toContain('\u001b')
    expect(out).not.toContain('\u202e')
  })

  it('runs a project binary from node_modules/.bin', async () => {
    script(path.join(project, 'node_modules', '.bin', 'vitest'), 'echo "vitest-ran $*"')
    expect(await run(makeRegistry(), 'vitest run')).toContain('vitest-ran run')
  })
})

describe('mingly_run_command bounds', () => {
  it('kills the whole process group on timeout, including a background child', async () => {
    const pidFile = path.join(outside, 'sleep.pid')
    fake('git', `sleep 60 &\necho $! > "${pidFile}"\nwait`)
    // Timing bound derived from a measurement (scratchpad/lat.js, 30 spawns of a
    // shell script that writes a pid file): median 5.4 ms, max 240.7 ms. The
    // first version used 300 ms and failed once under load because the script
    // had not written its pid file before the timeout fired. 3000 ms is >12x
    // the measured max; the assertion is on the kill, not on the duration.
    const out = await run(makeRegistry({ commandMs: 3000 }), 'git status')
    expect(out).toMatch(/timed out/)
    // Positive control: the child existed.
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(Number.isInteger(pid) && pid > 1).toBe(true)
    expect(await waitDead(pid)).toBe(true)
  })

  it('stops a flooding process and returns head and tail within the result budget', async () => {
    const pidFile = path.join(outside, 'yes.pid')
    fake('git', `echo $$ > "${pidFile}"\nexec yes abcdefghijklmnopqrstuvwxyz`)
    const out = await run(makeRegistry({ hardOutputCap: 50_000 }, 2000), 'git status')
    expect(out).toMatch(/output limit exceeded/)
    expect(out).toMatch(/characters omitted/)
    expect(out.length).toBeLessThanOrEqual(2000)
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(await waitDead(pid)).toBe(true)
  })

  it('keeps the START and the END of long output (a test summary sits at the end)', async () => {
    fake('git', 'echo FIRST-LINE; i=0; while [ $i -lt 400 ]; do echo "filler line $i"; i=$((i+1)); done; echo LAST-LINE')
    const out = await run(makeRegistry({}, 2000), 'git status')
    expect(out).toContain('FIRST-LINE')
    expect(out).toContain('LAST-LINE')
    expect(out).toMatch(/characters omitted/)
  })

  it('allows only maxCommands per run and a fresh run starts fresh', async () => {
    fake('git', 'echo ok')
    const registry = makeRegistry({ maxCommands: 2 })
    expect(await run(registry, 'git status', await ctxFor('r1'))).toContain('exit code 0')
    expect(await run(registry, 'git status', await ctxFor('r1'))).toContain('exit code 0')
    expect(await run(registry, 'git status', await ctxFor('r1'))).toMatch(/used up its command budget/)
    expect(await run(registry, 'git status', await ctxFor('r2'))).toContain('exit code 0')
  })

  it('counts parallel calls of one step against the same budget', async () => {
    fake('git', 'echo ok')
    const registry = makeRegistry({ maxCommands: 2 })
    const ctx = await ctxFor('rp')
    const results = await Promise.all([1, 2, 3, 4].map(() => run(registry, 'git status', ctx)))
    expect(results.filter((r) => r.includes('exit code 0'))).toHaveLength(2)
    expect(results.filter((r) => /used up its command budget/.test(r))).toHaveLength(2)
  })

  it('reserves time up front: parallel calls cannot each take the full command time', async () => {
    fake('git', 'echo ok')
    // 600 ms per command, 1000 ms in total: two reservations (600 + 400) fit,
    // the third finds nothing left even though every command ends at once.
    const registry = makeRegistry({ commandMs: 600, totalMs: 1000 })
    const ctx = await ctxFor('rt')
    const results = await Promise.all([1, 2, 3].map(() => run(registry, 'git status', ctx)))
    expect(results.filter((r) => r.includes('exit code 0'))).toHaveLength(2)
    expect(results.filter((r) => /used up its command budget/.test(r))).toHaveLength(1)
  })

  it('gives unused reserved time back, so quick commands do not drain the run', async () => {
    fake('git', 'echo ok')
    const registry = makeRegistry({ commandMs: 600, totalMs: 1000 })
    const ctx = await ctxFor('rr')
    for (let i = 0; i < 5; i++) expect(await run(registry, 'git status', ctx)).toContain('exit code 0')
  })

  it('the SHIPPED registry leaves room for the full minute a command is promised', () => {
    // The old version of this test passed `toolTimeoutMs: 4000` and asserted
    // only the RELATION between the two timeouts. That stays green forever
    // while the shipped value makes the feature unusable: the production
    // registry carried 15000 ms for every tool, so `wantMs` came out at 14 s
    // and `npm test` — the showcase command — could not finish.
    //
    // Pinned against the requirement, not against the module: the README
    // promises "höchstens 60 Sekunden pro Befehl", and the handler needs room
    // after that to kill the group and assemble the result. Both numbers are
    // written out here.
    const PROMISED_COMMAND_MS = 60_000
    const KILL_RESERVE_MS = 1_000
    const shipped = new ToolRegistry()
    registerRunCommand(shipped, {
      findGrant: async (id) => grants.find((g) => g.id === id),
      getInterpreterPaths: () => interpreters
    })

    expect(shipped.getToolTimeoutMs('mingly_run_command')).toBeGreaterThanOrEqual(
      PROMISED_COMMAND_MS + KILL_RESERVE_MS
    )
    // And it is the COMMAND tool that got the long leash, not every tool: a
    // hung MCP call must not be able to block a run for a minute.
    expect(shipped.getToolTimeoutMs()).toBeLessThan(PROMISED_COMMAND_MS)
    expect(shipped.getToolTimeoutMs('some_mcp_tool')).toBeLessThan(PROMISED_COMMAND_MS)
  })

  it('keeps the command time below the registry tool timeout', async () => {
    const pidFile = path.join(outside, 'reg.pid')
    fake('git', `echo $$ > "${pidFile}"\nexec sleep 60`)
    // The handler's own timer is the short one here, so its report must be the
    // answer and the process must be dead; the registry must not pre-empt it.
    const registry = makeRegistry({ commandMs: 1500 }, 100000)
    const out = await run(registry, 'git status')
    expect(out).toMatch(/timed out/)
    expect(out).not.toMatch(/Tool execution timed out|failed/)
    expect(await waitDead(Number(fs.readFileSync(pidFile, 'utf8').trim()))).toBe(true)
  })

  it('settles even when the process group cannot be killed, and says so', async () => {
    // `process.kill` failing with anything but ESRCH (EPERM, for instance) was
    // swallowed: neither `exit` nor `close` fires, the promise never settles
    // and the run's time budget stays charged for good. Survivable only while
    // the registry's own timeout was low — which the test above raises.
    const pidFile = path.join(outside, 'eperm.pid')
    // Long enough to outlive the registry's own timeout: if only the child's
    // natural exit settled this, the test would prove nothing.
    fake('git', `echo $$ > "${pidFile}"\nexec sleep 20`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    try {
      const registry = makeRegistry({ commandMs: 300 }, 100000)
      const out = await run(registry, 'git status')
      // The handler's own answer, not the registry's rejection.
      expect(out).toMatch(/timed out/)
      expect(out).not.toMatch(/Tool execution timed out/)
      // And the answer must not claim the group was killed when it was not:
      // what the reader sees has to describe what happened.
      expect(out).toMatch(/could not be stopped/)
      // A failed kill is not a normal end: it has to be visible in the log too.
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).toContain('EPERM')
    } finally {
      kill.mockRestore()
      warn.mockRestore()
      // Nothing killed it while the spy was up; do it now.
      try {
        process.kill(-Number(fs.readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })

  it('does not warn when the kill finds nothing left to kill (negative control)', async () => {
    fake('git', 'echo ok')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await run(makeRegistry(), 'git status')).toContain('exit code 0')
      // ESRCH is the normal end of every command: warning there would be noise.
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('mingly_run_command refuses alike when the environment says no', () => {
  it('uses ONE text for unconfigured, missing, not executable, unknown script and no grant', async () => {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    const registry = makeRegistry()
    const texts: string[] = []

    // interpreter not configured
    texts.push(await run(registry, 'git status'))
    // configured but the file does not exist
    interpreters.git = path.join(bins, 'no-such-git')
    texts.push(await run(registry, 'git status'))
    // configured, exists, not executable
    const plain = path.join(bins, 'plain-git')
    fs.writeFileSync(plain, '#!/bin/sh\necho hi\n', { mode: 0o644 })
    interpreters.git = plain
    texts.push(await run(registry, 'git status'))
    // npm configured, script unknown
    fake('npm', 'echo ok')
    texts.push(await run(registry, 'npm run deploy'))
    // project binary absent
    texts.push(await run(registry, 'vitest run'))
    // no package.json at all
    fs.rmSync(path.join(project, 'package.json'))
    texts.push(await run(registry, 'npm run build'))
    // a repository config that names a program — in the dotted spelling, and in
    // a spelling git itself will not parse. Both depend on what the repository
    // says, not on what the model wrote, so both carry this same text.
    fake('git', 'echo ok')
    const config = path.join(project, '.git', 'config')
    fs.writeFileSync(config, '[filter.spy]\n\tclean = /tmp/spy.sh\n')
    texts.push(await run(registry, 'git status'))
    fs.writeFileSync(config, '[filter.spy\n\tclean = /tmp/spy.sh\n')
    texts.push(await run(registry, 'git status'))
    fs.rmSync(config)
    // no grant
    grants = []
    texts.push(await run(registry, 'git status'))

    expect(texts).toEqual(Array(texts.length).fill(COMMAND_UNAVAILABLE))
  })

  it('positive control for the above: with everything in place the same commands run', async () => {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    fake('npm', 'echo ok')
    fake('git', 'echo ok')
    script(path.join(project, 'node_modules', '.bin', 'vitest'), 'echo ok')
    const registry = makeRegistry()
    for (const c of ['git status', 'npm run build', 'vitest run']) {
      expect(await run(registry, c), c).toContain('exit code 0')
    }
  })

  it('refuses when the context carries no run id', async () => {
    fake('git', 'echo ok')
    expect(await run(makeRegistry(), 'git status', await ctxFor(null))).toBe(COMMAND_UNAVAILABLE)
  })

  it('refuses a refused-by-input command with its reason, before anything touches the disk', async () => {
    grants = []
    const out = await run(makeRegistry(), 'git status && ls')
    expect(out).toMatch(/shell syntax/)
  })

  it('refuses a project binary that is a link leading out of the project', async () => {
    const target = script(path.join(outside, 'evil'), 'echo escaped')
    fs.mkdirSync(path.join(project, 'node_modules', '.bin'), { recursive: true })
    fs.symlinkSync(target, path.join(project, 'node_modules', '.bin', 'vitest'))
    expect(await run(makeRegistry(), 'vitest run')).toBe(COMMAND_UNAVAILABLE)
  })
})

describe('mingly_run_command path arguments are re-checked on disk', () => {
  it('runs pytest on a plain project file (positive control)', async () => {
    fake('pytest', 'echo "pytest-ran $*"')
    fs.mkdirSync(path.join(project, 'tests'))
    fs.writeFileSync(path.join(project, 'tests', 'ok.py'), 'x = 1\n')
    expect(await run(makeRegistry(), 'pytest tests/ok.py')).toContain('pytest-ran tests/ok.py')
  })

  it('refuses a file that is a link to something outside the project', async () => {
    fake('pytest', 'echo "pytest-ran $*"')
    fs.writeFileSync(path.join(outside, 'secret.py'), 'TOKEN = 1\n')
    fs.mkdirSync(path.join(project, 'tests'))
    fs.symlinkSync(path.join(outside, 'secret.py'), path.join(project, 'tests', 'link.py'))
    expect(await run(makeRegistry(), 'pytest tests/link.py')).toBe(COMMAND_UNAVAILABLE)
  })

  it('refuses a file that is a link to a blocked file inside the project', async () => {
    fake('pytest', 'echo "pytest-ran $*"')
    fs.writeFileSync(path.join(project, '.env'), 'API_KEY=1\n')
    fs.mkdirSync(path.join(project, 'tests'))
    fs.symlinkSync(path.join(project, '.env'), path.join(project, 'tests', 'e.py'))
    expect(await run(makeRegistry(), 'pytest tests/e.py')).toBe(COMMAND_UNAVAILABLE)
  })
})

describe('mingly_run_command stays inside the grant (fix round 1)', () => {
  it('I-1: npm test does not start when the granted root has no package.json of its own', async () => {
    // npm would walk UP from the granted root and run the parent's script.
    const marker = path.join(outside, 'npm-started.marker')
    fake('npm', `touch "${marker}"\necho ok`)
    fs.writeFileSync(path.join(project, '..', 'package.json'), JSON.stringify({ scripts: { test: 'echo PARENT' } }))
    try {
      expect(await run(makeRegistry(), 'npm test')).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      fs.rmSync(path.join(project, '..', 'package.json'), { force: true })
    }
  })

  it('I-1: positive control, with its own package.json npm test does start', async () => {
    const marker = path.join(outside, 'npm-started.marker')
    fake('npm', `touch "${marker}"\necho ok`)
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
    expect(await run(makeRegistry(), 'npm test')).toContain('exit code 0')
    expect(fs.existsSync(marker)).toBe(true)
  })

  it('I-1: a package.json that is a link out of the grant does not count', async () => {
    const marker = path.join(outside, 'npm-started.marker')
    fake('npm', `touch "${marker}"\necho ok`)
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
    fs.symlinkSync(path.join(outside, 'package.json'), path.join(project, 'package.json'))
    expect(await run(makeRegistry(), 'npm test')).toBe(COMMAND_UNAVAILABLE)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('I-2: once the budget is spent, every environment outcome reads the same', async () => {
    fake('git', 'echo ok')
    const registry = makeRegistry({ maxCommands: 1 })
    const ctx = await ctxFor('rb')
    expect(await run(registry, 'git status', ctx)).toContain('exit code 0')
    // would pass every environment check / fails the interpreter check / fails the grant-bound checks
    const passing = await run(registry, 'git status', ctx)
    const noInterpreter = await run(registry, 'npm test', ctx)
    const noBinary = await run(registry, 'vitest run', ctx)
    expect(passing).toMatch(/used up its command budget/)
    expect(noInterpreter).toBe(passing)
    expect(noBinary).toBe(passing)
  })

  it('I-2: a command refused on environment grounds does not use up budget', async () => {
    fake('git', 'echo ok')
    const registry = makeRegistry({ maxCommands: 1 })
    const ctx = await ctxFor('rc')
    expect(await run(registry, 'npm test', ctx)).toBe(COMMAND_UNAVAILABLE)
    expect(await run(registry, 'vitest run', ctx)).toBe(COMMAND_UNAVAILABLE)
    expect(await run(registry, 'git status && ls', ctx)).toMatch(/shell syntax/)
    expect(await run(registry, 'git status', ctx)).toContain('exit code 0')
  })

  it('I-2: a refused command gives its reserved time back as well', async () => {
    fake('git', 'echo ok')
    const registry = makeRegistry({ commandMs: 600, totalMs: 1000 })
    const ctx = await ctxFor('rd')
    for (let i = 0; i < 4; i++) expect(await run(registry, 'vitest run', ctx)).toBe(COMMAND_UNAVAILABLE)
    expect(await run(registry, 'git status', ctx)).toContain('exit code 0')
  })

  it('I-4: a read-only grant does not run commands (mingly_edit_file needs edit, running is stronger)', async () => {
    fake('git', 'echo ok')
    grants = [{ ...grant(), permissions: ['read'] }]
    expect(await run(makeRegistry(), 'git status')).toBe(COMMAND_UNAVAILABLE)
  })

  it('I-4: positive control, read plus edit runs', async () => {
    fake('git', 'echo ok')
    grants = [{ ...grant(), permissions: ['read', 'edit'] }]
    expect(await run(makeRegistry(), 'git status')).toContain('exit code 0')
  })
})

describe('mingly_run_command: the granted root must be the tool\'s own root (class fix for I-1)', () => {
  // Measured on this machine: npm, tsc, git and vitest (its CONFIG) all look
  // UPWARD from the working directory. pytest is UNMEASURED (not installed);
  // its marks are a fail-closed precondition, not a claim that they suffice.
  type Case = { command: string; marks: string[]; make: (dir: string, name: string) => void }
  const file = (dir: string, name: string): void => {
    fs.writeFileSync(path.join(dir, name), name === 'package.json' ? JSON.stringify({ scripts: { build: 'x', test: 'x' } }) : '{}')
  }
  const gitDir = (dir: string, name: string): void => fs.mkdirSync(path.join(dir, name))
  const VITEST_MARKS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].flatMap((e) => [`vitest.config.${e}`, `vite.config.${e}`])
  const PYTEST_MARKS = ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg']
  const CASES: Case[] = [
    { command: 'npm test', marks: ['package.json'], make: file },
    { command: 'npm run build', marks: ['package.json'], make: file },
    { command: 'tsc --noEmit', marks: ['tsconfig.json'], make: file },
    { command: 'npx tsc --noEmit', marks: ['tsconfig.json'], make: file },
    { command: 'vitest run', marks: VITEST_MARKS, make: file },
    { command: 'vitest run src', marks: VITEST_MARKS, make: file },
    { command: 'git status', marks: ['.git'], make: gitDir },
    { command: 'git status --short', marks: ['.git'], make: gitDir },
    { command: 'git diff --stat', marks: ['.git'], make: gitDir },
    { command: 'git diff --name-only', marks: ['.git'], make: gitDir },
    { command: 'pytest', marks: PYTEST_MARKS, make: file },
    { command: 'pytest tests/a.py', marks: PYTEST_MARKS, make: file }
  ]

  let outer: string
  let started: string

  /** Every program touches `started`; a refused command leaves it absent. */
  function arm(): void {
    started = path.join(outside, `started-${Math.random().toString(36).slice(2)}`)
    for (const n of ['npm', 'git', 'pytest']) fake(n, `touch "${started}"\necho ok`)
    for (const n of ['vitest', 'tsc']) {
      script(path.join(project, 'node_modules', '.bin', n), `touch "${started}"\necho ok`)
    }
  }

  beforeEach(() => {
    // The granted root is a CHILD directory; its parent is where an upward
    // search would find a root that is outside the grant.
    outer = project
    for (const m of ['.git', 'tsconfig.json', 'vitest.config.ts', 'pytest.ini']) {
      fs.rmSync(path.join(outer, m), { recursive: true, force: true })
    }
    project = path.join(outer, 'inner')
    fs.mkdirSync(project)
    grants = [grant()]
    arm()
  })

  for (const c of CASES) {
    it(`${c.command}: marks only in the PARENT of the grant -> not started`, async () => {
      for (const m of c.marks.slice(0, 1)) c.make(outer, m)
      expect(await run(makeRegistry(), c.command)).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it(`${c.command}: no mark anywhere -> not started`, async () => {
      expect(await run(makeRegistry(), c.command)).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it(`${c.command}: own mark in the granted root -> runs (false-alarm direction)`, async () => {
      c.make(project, c.marks[0])
      expect(await run(makeRegistry(), c.command)).toContain('exit code 0')
      expect(fs.existsSync(started)).toBe(true)
    })
  }

  it('every alternative mark of vitest and pytest suffices on its own', async () => {
    for (const [command, marks] of [['vitest run', VITEST_MARKS], ['pytest', PYTEST_MARKS]] as const) {
      for (const m of marks) {
        fs.rmSync(started, { force: true })
        for (const old of fs.readdirSync(project)) if (old !== 'node_modules' && old !== '.mingly') fs.rmSync(path.join(project, old), { recursive: true, force: true })
        file(project, m)
        expect(await run(makeRegistry(), command), `${command} with ${m}`).toContain('exit code 0')
      }
    }
  })

  it('a file mark that is a DIRECTORY is no mark', async () => {
    fs.mkdirSync(path.join(project, 'tsconfig.json'))
    fs.mkdirSync(path.join(project, 'pytest.ini'))
    expect(await run(makeRegistry(), 'tsc --noEmit')).toBe(COMMAND_UNAVAILABLE)
    expect(await run(makeRegistry(), 'pytest')).toBe(COMMAND_UNAVAILABLE)
    expect(fs.existsSync(started)).toBe(false)
  })

  it('a mark that is a link leading out of the grant is no mark', async () => {
    fs.writeFileSync(path.join(outer, 'tsconfig.json'), '{}')
    fs.symlinkSync(path.join(outer, 'tsconfig.json'), path.join(project, 'tsconfig.json'))
    fs.symlinkSync(path.join(outer, '.git-elsewhere'), path.join(project, '.git'))
    fs.mkdirSync(path.join(outer, '.git-elsewhere'))
    expect(await run(makeRegistry(), 'tsc --noEmit')).toBe(COMMAND_UNAVAILABLE)
    expect(await run(makeRegistry(), 'git status')).toBe(COMMAND_UNAVAILABLE)
    expect(fs.existsSync(started)).toBe(false)
  })

  describe('git: whatever git will use must lie inside the grant', () => {
    const gitRun = async (): Promise<string> => run(makeRegistry(), 'git status')

    it('a .git FILE pointing at a git dir OUTSIDE the grant is refused (foreign index, measured to leak names)', async () => {
      fs.mkdirSync(path.join(outer, 'other-repo-git'))
      fs.writeFileSync(path.join(project, '.git'), `gitdir: ${path.join(outer, 'other-repo-git')}\n`)
      expect(await gitRun()).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('a relative gitdir that climbs out of the grant is refused', async () => {
      fs.mkdirSync(path.join(outer, 'sibling-git'))
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: ../sibling-git\n')
      expect(await gitRun()).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('a .git file with a missing target, a file target or unreadable content is refused', async () => {
      for (const content of ['gitdir: nowhere\n', 'gitdir: .git-as-file\n', 'not a gitdir line\n', '', 'gitdir: \n']) {
        fs.rmSync(path.join(project, '.git'), { recursive: true, force: true })
        fs.writeFileSync(path.join(project, '.git-as-file'), 'x')
        fs.writeFileSync(path.join(project, '.git'), content)
        expect(await gitRun(), JSON.stringify(content)).toBe(COMMAND_UNAVAILABLE)
      }
      expect(fs.existsSync(started)).toBe(false)
    })

    it('a commondir that leads out of the grant is refused', async () => {
      const wt = path.join(project, '.gitdata', 'wt')
      fs.mkdirSync(wt, { recursive: true })
      fs.writeFileSync(path.join(wt, 'commondir'), '../../../')
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: .gitdata/wt\n')
      expect(await gitRun()).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    // `..` after a symlink applies to the link TARGET's parent. A lexical
    // check (path.resolve, and also Node's realpath, which collapses `..` first)
    // answers "inside"; the operating system lands outside.
    it('physicalPath follows the filesystem, not the string: sub/../x differs from path.resolve', async () => {
      const far = path.join(outside, 'a', 'b')
      fs.mkdirSync(far, { recursive: true })
      fs.mkdirSync(path.join(outside, 'a', 'x'))
      fs.symlinkSync(far, path.join(project, 'sub'))
      expect(path.resolve(project, 'sub/../x')).toBe(path.join(project, 'x')) // the lexical answer
      expect(await physicalPath(project, 'sub/../x')).toBe(path.join(outside, 'a', 'x')) // the physical one
      // Links with their own `..` and absolute links, and the plain cases:
      fs.symlinkSync('sub/..', path.join(project, 'hop'))
      expect(await physicalPath(project, 'hop')).toBe(path.join(outside, 'a'))
      fs.symlinkSync(far, path.join(project, 'abs'))
      expect(await physicalPath(project, 'abs')).toBe(far)
      expect(await physicalPath(project, '.')).toBe(project)
      expect(await physicalPath(project, '')).toBe(project)
      expect(await physicalPath(project, 'nope')).toBeNull()
    })

    it('physicalPath: an ABSOLUTE input wins and discards the base, like path.resolve does', async () => {
      fs.mkdirSync(path.join(outside, 'abs-target'))
      // The decoy the exploit uses: the absolute path re-created UNDER the base.
      fs.mkdirSync(path.join(project, outside, 'abs-target'), { recursive: true })
      expect(path.resolve(project, path.join(outside, 'abs-target'))).toBe(path.join(outside, 'abs-target'))
      expect(await physicalPath(project, path.join(outside, 'abs-target'))).toBe(path.join(outside, 'abs-target'))
      // Absolute input that goes through a link and a `..`.
      fs.mkdirSync(path.join(outside, 'p', 'q'), { recursive: true })
      fs.mkdirSync(path.join(outside, 'z'))
      fs.symlinkSync(path.join(outside, 'p', 'q'), path.join(outside, 'lnk'))
      // lnk -> p/q, so lnk/.. is p (physical), not outside; p/z does not exist
      expect(await physicalPath(project, `${outside}/lnk/../z`)).toBeNull()
      fs.mkdirSync(path.join(outside, 'p', 'z'))
      expect(await physicalPath(project, `${outside}/lnk/../z`)).toBe(path.join(outside, 'p', 'z'))
    })

    it('physicalPath: every other input class has a chosen answer', async () => {
      const real = path.join(project, 'real')
      fs.mkdirSync(path.join(real, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(real, 'file.txt'), 'x')
      // repeated and trailing separators
      expect(await physicalPath(project, 'real//sub/')).toBe(path.join(real, 'sub'))
      expect(await physicalPath(project, './real/./sub')).toBe(path.join(real, 'sub'))
      // `..` first, and `..` at the filesystem root stays at the root
      expect(await physicalPath(path.join(real, 'sub'), '..')).toBe(real)
      expect(await physicalPath('/', '..')).toBe('/')
      // symlink as the final segment, a chain of links, a dangling link
      fs.symlinkSync(path.join(real, 'sub'), path.join(project, 'last'))
      expect(await physicalPath(project, 'last')).toBe(path.join(real, 'sub'))
      fs.symlinkSync('last', path.join(project, 'chain1'))
      fs.symlinkSync('chain1', path.join(project, 'chain2'))
      expect(await physicalPath(project, 'chain2')).toBe(path.join(real, 'sub'))
      fs.symlinkSync('does-not-exist', path.join(project, 'dangling'))
      expect(await physicalPath(project, 'dangling')).toBeNull()
      // a link whose target is a FILE resolves to the file; nothing can be walked below it
      fs.symlinkSync(path.join(real, 'file.txt'), path.join(project, 'tofile'))
      expect(await physicalPath(project, 'tofile')).toBe(path.join(real, 'file.txt'))
      expect(await physicalPath(project, 'tofile/x')).toBeNull()
      // a link target with `..` is applied to the link's own directory
      fs.symlinkSync('../sub', path.join(real, 'sub', 'up'))
      expect(await physicalPath(project, 'real/sub/up')).toBe(path.join(real, 'sub'))
    })

    it('physicalPath gives up on a link loop', async () => {
      fs.symlinkSync('loop2', path.join(project, 'loop1'))
      fs.symlinkSync('loop1', path.join(project, 'loop2'))
      expect(await physicalPath(project, 'loop1')).toBeNull()
    })

    it('a commondir whose lexical path is inside but whose physical path is outside is refused', async () => {
      fs.mkdirSync(path.join(outside, 'a', 'b'), { recursive: true })
      fs.mkdirSync(path.join(outside, 'a', 'foreign'))
      const gd = path.join(project, '.git')
      fs.mkdirSync(path.join(gd, 'foreign'), { recursive: true })
      fs.symlinkSync(path.join(outside, 'a', 'b'), path.join(gd, 'sub'))
      fs.writeFileSync(path.join(gd, 'commondir'), 'sub/../foreign')
      expect(await gitRun()).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('a gitdir pointer whose lexical path is inside but whose physical path is outside is refused', async () => {
      fs.mkdirSync(path.join(outside, 'a', 'b'), { recursive: true })
      fs.mkdirSync(path.join(outside, 'a', 'inner-git'))
      fs.mkdirSync(path.join(project, 'inner-git'))
      fs.symlinkSync(path.join(outside, 'a', 'b'), path.join(project, 'link'))
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: link/../inner-git\n')
      expect(await gitRun()).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('false alarm direction: a physical path inside the grant that a lexical check would miss still runs', async () => {
      // grant/link -> grant/real/sub; `link/../gd` is grant/real/gd physically,
      // grant/gd lexically (which does not exist).
      fs.mkdirSync(path.join(project, 'real', 'sub'), { recursive: true })
      fs.mkdirSync(path.join(project, 'real', 'gd'))
      fs.symlinkSync(path.join(project, 'real', 'sub'), path.join(project, 'link'))
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: link/../gd\n')
      fake('git', 'echo "GIT_DIR=$GIT_DIR"')
      const out = await gitRun()
      expect(out).toContain('exit code 0')
      expect(out).toContain(`GIT_DIR=${path.join(project, 'real', 'gd')}\n`)
    })

    it('EXPLOIT: an ABSOLUTE commondir to a repository outside the grant is refused, decoy or not', async () => {
      const foreign = path.join(outside, 'foreign-repo', '.git')
      fs.mkdirSync(foreign, { recursive: true })
      const gd = path.join(project, '.git')
      // The decoy: the same absolute path re-created under the git dir.
      fs.mkdirSync(path.join(gd, foreign), { recursive: true })
      fs.writeFileSync(path.join(gd, 'commondir'), foreign)
      expect(await gitRun()).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('an ABSOLUTE gitdir pointer outside the grant is refused, decoy or not', async () => {
      const foreign = path.join(outside, 'foreign-gd')
      fs.mkdirSync(foreign)
      fs.mkdirSync(path.join(project, foreign), { recursive: true })
      fs.writeFileSync(path.join(project, '.git'), `gitdir: ${foreign}\n`)
      expect(await gitRun()).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('false alarm direction: an ABSOLUTE gitdir pointer and ABSOLUTE commondir inside the grant run, pinned (as `git worktree add` writes them)', async () => {
      const common = path.join(project, '.gitdata')
      const wt = path.join(common, 'worktrees', 'wt')
      fs.mkdirSync(wt, { recursive: true })
      fs.writeFileSync(path.join(wt, 'commondir'), common)
      fs.writeFileSync(path.join(project, '.git'), `gitdir: ${wt}\n`)
      fake('git', 'echo "GIT_DIR=$GIT_DIR"; echo "GIT_COMMON_DIR=$GIT_COMMON_DIR"')
      const out = await gitRun()
      expect(out).toContain('exit code 0')
      expect(out).toContain(`GIT_DIR=${wt}\n`)
      expect(out).toContain(`GIT_COMMON_DIR=${common}\n`)
    })

    it('GIT_COMMON_DIR is pinned to the validated common dir; without a commondir it is not set', async () => {
      const wt = path.join(project, '.gitdata', 'worktrees', 'wt')
      fs.mkdirSync(wt, { recursive: true })
      fs.writeFileSync(path.join(wt, 'commondir'), '../..')
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: .gitdata/worktrees/wt\n')
      fake('git', 'echo "GIT_COMMON_DIR=[$GIT_COMMON_DIR]"')
      expect(await gitRun()).toContain(`GIT_COMMON_DIR=[${path.join(project, '.gitdata')}]`)
      fs.rmSync(path.join(project, '.git'))
      fs.mkdirSync(path.join(project, '.git'))
      expect(await gitRun()).toContain('GIT_COMMON_DIR=[]')
    })

    it('a linked worktree whose git dir and commondir are inside the grant still runs, with git pinned to them', async () => {
      const wt = path.join(project, '.gitdata', 'worktrees', 'wt')
      fs.mkdirSync(wt, { recursive: true })
      fs.writeFileSync(path.join(wt, 'commondir'), '../..')
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: .gitdata/worktrees/wt\n')
      fake('git', 'echo "GIT_DIR=$GIT_DIR"; echo "GIT_WORK_TREE=$GIT_WORK_TREE"')
      const out = await gitRun()
      expect(out).toContain('exit code 0')
      expect(out).toContain(`GIT_DIR=${wt}\n`)
      expect(out).toContain(`GIT_WORK_TREE=${project}\n`)
    })

    it('a .git DIRECTORY runs, pinned to itself (false-alarm direction)', async () => {
      fs.mkdirSync(path.join(project, '.git'))
      fake('git', 'echo "GIT_DIR=$GIT_DIR"; echo "GIT_WORK_TREE=$GIT_WORK_TREE"')
      const out = await gitRun()
      expect(out).toContain(`GIT_DIR=${path.join(project, '.git')}\n`)
      expect(out).toContain(`GIT_WORK_TREE=${project}\n`)
    })

    it('other tools get no GIT_DIR or GIT_WORK_TREE', async () => {
      fake('npm', 'echo "G=[$GIT_DIR][$GIT_WORK_TREE]"')
      fs.writeFileSync(path.join(project, 'package.json'), '{"scripts":{"test":"x"}}')
      expect(await run(makeRegistry(), 'npm test')).toContain('G=[][]')
    })
  })

  describe('git: a repository config that names a program is refused', () => {
    /**
     * Measured here (git 2.53.0, negative control in the same run): a
     * `filter.<name>.clean` driver selected by a `.gitattributes` in the tree is
     * executed by `git diff --stat`, by `git diff --name-only` AND by
     * `git status` / `git status --short` — the last two whenever the file size
     * is unchanged, so stat alone cannot settle whether the file is modified.
     * Reaching the same driver through `[include] path = …` works as well.
     * There is no git flag that switches clean/smudge off, so the only way to
     * keep the promise is to refuse the repository.
     *
     * The refusal is environment-dependent, so it carries the ONE shared text
     * and says nothing about what the config holds.
     */
    const writeConfig = (body: string): void => {
      fs.mkdirSync(path.join(project, '.git'), { recursive: true })
      fs.writeFileSync(path.join(project, '.git', 'config'), body)
    }

    /**
     * Every form here is one git ACCEPTS — measured (git 2.53.0) with
     * `git config --file <f> --no-includes --name-only --list`, which answered
     * exit 0 and the key name noted for each. A form git rejected would make
     * the guard refuse because the file is malformed, and the test would pass
     * for the wrong reason.
     *
     * The DOTTED spellings are the ones the old text match missed: the regex
     * accepted whitespace, `]`, `"` or end of line after the section name, and
     * git also accepts a dot. Measured in the same run: `[filter.spy] clean=…`
     * defines `filter.spy.clean`, exactly as `[filter "spy"]` does, and a
     * `git status` or `git diff --stat` runs it.
     */
    const RISKY = [
      ['a clean filter driver', '[filter "spy"]\n\tclean = /tmp/spy.sh\n'],
      ['a DOTTED filter section', '[filter.spy]\n\tclean = /tmp/spy.sh\n'],
      ['a DOTTED filter section with a capitalised subsection', '[filter.SPY]\n\tclean = /tmp/spy.sh\n'],
      ['a QUOTED filter section with a capitalised subsection', '[filter "SPY"]\n\tclean = /tmp/spy.sh\n'],
      ['a filter driver on one line', '[filter "spy"] smudge = /tmp/spy.sh\n'],
      ['a long-running filter process', '[filter "spy"]\n\tprocess = /tmp/spy.sh\n'],
      ['an include that may define one', '[include]\n\tpath = /tmp/extra.cfg\n'],
      ['a DOTTED include section', '[include.path]\n\tx = /tmp/extra.cfg\n'],
      ['a conditional include', '[includeIf "gitdir:/"]\n\tpath = /tmp/extra.cfg\n'],
      ['a DOTTED conditional include', '[includeIf.gitdir]\n\tpath = /tmp/extra.cfg\n'],
      ['a key naming a program', '[core]\n\tsshCommand = /tmp/spy.sh\n'],
      ['a diff driver command', '[diff "x"]\n\tcommand = /tmp/spy.sh\n']
    ] as const

    for (const [label, body] of RISKY) {
      it(`refuses ${label}, with the shared text and without starting git`, async () => {
        writeConfig(body)
        expect(await run(makeRegistry(), 'git status')).toBe(COMMAND_UNAVAILABLE)
        expect(await run(makeRegistry(), 'git diff --stat')).toBe(COMMAND_UNAVAILABLE)
        expect(fs.existsSync(started)).toBe(false)
      })
    }

    it('the harness has a real git to answer the config question', () => {
      // Without it the stub cannot answer `git config` and every case in this
      // suite would be decided by something other than git's own grammar.
      expect(REAL_GIT).not.toBe('')
    })

    it('a config git itself cannot parse is refused, not read past', async () => {
      // Measured: `git config --file` exits 128 on a malformed file. A file this
      // app cannot have judged is one it must not vouch for.
      writeConfig('[filter.spy\n\tclean = /tmp/spy.sh\n')
      expect(await run(makeRegistry(), 'git status')).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('false alarm direction: a section that merely starts like one is allowed', async () => {
      // `[filterx]` is not a filter section, and `[foo "command"]` is a
      // subsection named command, not a variable. Measured key names:
      // `filterx.clean` and `foo.command.bar`.
      writeConfig('[filterx]\n\tclean = x\n[foo "command"]\n\tbar = x\n')
      expect(await run(makeRegistry(), 'git status')).toContain('exit code 0')
      expect(fs.existsSync(started)).toBe(true)
    })

    it('false alarm direction: an ordinary repository config still runs', async () => {
      // What `git init` plus a user writes. None of it names a program.
      writeConfig(
        '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n' +
          '\tlogallrefupdates = true\n\tignorecase = true\n' +
          '[user]\n\temail = a@b.invalid\n\tname = a\n' +
          '[remote "origin"]\n\turl = https://example.invalid/repo.git\n' +
          '\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
          '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n'
      )
      expect(await run(makeRegistry(), 'git status')).toContain('exit code 0')
      expect(fs.existsSync(started)).toBe(true)
    })

    it('false alarm direction: a comment mentioning a filter is not a definition', async () => {
      writeConfig('# the filter driver below was removed; sshCommand too\n[core]\n\tfilemode = true\n')
      expect(await run(makeRegistry(), 'git status')).toContain('exit code 0')
    })

    it('a repository with no config file at all still runs', async () => {
      fs.mkdirSync(path.join(project, '.git'), { recursive: true })
      expect(await run(makeRegistry(), 'git status')).toContain('exit code 0')
    })

    it('a config that cannot be read is refused, not assumed harmless', async () => {
      fs.mkdirSync(path.join(project, '.git'), { recursive: true })
      // A directory where the config file belongs: unreadable as a file.
      fs.mkdirSync(path.join(project, '.git', 'config'))
      expect(await run(makeRegistry(), 'git status')).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
    })

    it('the config of the pinned common dir is checked too', async () => {
      // In a linked worktree the shared config lives in the common dir, which
      // is where git reads it from.
      const common = path.join(project, '.gitdata')
      const wt = path.join(common, 'worktrees', 'wt')
      fs.mkdirSync(wt, { recursive: true })
      fs.writeFileSync(path.join(wt, 'commondir'), '../..')
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: .gitdata/worktrees/wt\n')
      fs.writeFileSync(path.join(common, 'config'), '[filter "spy"]\n\tclean = /tmp/spy.sh\n')
      expect(await run(makeRegistry(), 'git status')).toBe(COMMAND_UNAVAILABLE)
      expect(fs.existsSync(started)).toBe(false)
      // Positive control: the same worktree without that config runs.
      fs.rmSync(path.join(common, 'config'))
      expect(await run(makeRegistry(), 'git status')).toContain('exit code 0')
    })

    it('only git is affected: another tool runs with the same hostile config', async () => {
      writeConfig('[filter "spy"]\n\tclean = /tmp/spy.sh\n')
      fs.writeFileSync(path.join(project, 'package.json'), '{"scripts":{"test":"x"}}')
      expect(await run(makeRegistry(), 'npm test')).toContain('exit code 0')
    })
  })
})

/**
 * Z2. Two ceilings bound a run's commands: this tool's cumulative budget and
 * the agent's own run timeout. Before C1 every command was capped at 14 s by
 * the registry-wide tool timeout, so the relation did not matter; now a command
 * gets its full 60 s, which means TWO commands reach the agent's 120 s. A
 * budget that the other ceiling can never let a run spend is not a budget, it
 * is a number that looks like one.
 *
 * The assertions are on the RELATION, plus one literal for the ceiling itself
 * so a silent widening of it is visible. 120_000 is the documented rail
 * (AgentConfig.runTimeoutMs), written out here rather than read from the module
 * the relation is about.
 */
describe('the command budget and the agent run timeout', () => {
  it('the run timeout is the documented 120 seconds', () => {
    expect(AGENT_RUN_TIMEOUT_MS).toBe(120_000)
  })

  it('the cumulative command budget never exceeds the run timeout that ends the run first', () => {
    expect(RUN_TOTAL_MS).toBeLessThanOrEqual(AGENT_RUN_TIMEOUT_MS)
  })

  it('one command never exceeds the whole run budget', () => {
    expect(RUN_COMMAND_MS).toBeLessThanOrEqual(RUN_TOTAL_MS)
  })
})

/**
 * The decision over key NAMES, separately from the probe that produces them.
 *
 * Every name here was printed by `git config --file <f> --no-includes
 * --name-only --list` for the config form in the comment (git 2.53.0), so the
 * inputs are what git says, not what this test believes git says.
 */
describe('gitConfigNamesProgram', () => {
  it('refuses every form that defines a filter driver, dotted or quoted', () => {
    // [filter "spy"] / [filter.spy] / [filter.SPY] / [filter "SPY"]
    for (const key of ['filter.spy.clean', 'filter.spy.smudge', 'filter.spy.process', 'filter.LFS.clean']) {
      expect(gitConfigNamesProgram([key]), key).toBe(true)
    }
  })

  it('refuses an include, a conditional include and their dotted spellings', () => {
    // [include] / [include.path] / [includeIf "gitdir:/"] / [includeIf.gitdir]
    for (const key of ['include.path', 'include.path.x', 'includeif.gitdir:/.path', 'includeif.gitdir.path']) {
      expect(gitConfigNamesProgram([key]), key).toBe(true)
    }
  })

  it('refuses a variable whose name ends in command', () => {
    for (const key of ['core.sshcommand', 'diff.x.command', 'trailer.x.command']) {
      expect(gitConfigNamesProgram([key]), key).toBe(true)
    }
  })

  it('allows the keys an ordinary repository config defines', () => {
    expect(
      gitConfigNamesProgram([
        'core.repositoryformatversion',
        'core.filemode',
        'core.bare',
        'core.logallrefupdates',
        'core.ignorecase',
        'core.precomposeunicode',
        'user.email',
        'user.name',
        'remote.origin.url',
        'remote.origin.fetch',
        'branch.main.remote',
        'branch.main.merge'
      ])
    ).toBe(false)
  })

  it('allows names that only look like one of the refused forms', () => {
    // [filterx] clean=…  and  [foo "command"] bar=…
    expect(gitConfigNamesProgram(['filterx.clean'])).toBe(false)
    expect(gitConfigNamesProgram(['foo.command.bar'])).toBe(false)
    expect(gitConfigNamesProgram(['includeiffy.path'])).toBe(false)
  })

  it('finds the one bad key among many good ones, and says no to none at all', () => {
    expect(gitConfigNamesProgram(['core.filemode', 'filter.spy.clean', 'user.name'])).toBe(true)
    expect(gitConfigNamesProgram([])).toBe(false)
  })
})

describe('readInterpreterPaths', () => {
  const backing = (paths: unknown) => ({ get: () => paths })

  it('keeps only known names with string values', () => {
    expect(
      readInterpreterPaths(backing({ npm: '/a/npm', git: 5, pytest: '/a/pytest', node: '/a/node', rm: '/bin/rm' }))
    ).toEqual({ npm: '/a/npm', pytest: '/a/pytest' })
  })

  it('returns nothing for a stored value that is not a map, and ignores the prototype', () => {
    expect(readInterpreterPaths(backing('x'))).toEqual({})
    expect(readInterpreterPaths(backing(null))).toEqual({})
    expect(readInterpreterPaths(backing(['/a/npm']))).toEqual({})
    expect(readInterpreterPaths(backing(Object.create({ npm: '/a/npm' })))).toEqual({})
  })
})
