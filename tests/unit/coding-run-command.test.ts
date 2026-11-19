/**
 * run_command handler (Task 12), against REAL child processes.
 *
 * The "interpreters" are small /bin/sh scripts in a directory outside the
 * project; nothing here needs npm, git, node or pytest to be installed.
 * Expected values are written out by hand. There is no wall-clock assertion on
 * the code under test: process death is polled for as a STATE (the pid is
 * gone), with a generous ceiling that only bounds the test itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import { registerRunCommand, readInterpreterPaths, type RunLimits } from '../../src/main/coding/run-command'
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
    permissions: ['read'],
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

function fake(name: string, body: string): void {
  interpreters[name] = script(path.join(bins, name), body)
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
    { id: 't', name: 'run_command', arguments: { command } },
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
})

afterEach(() => {
  for (const d of [project, bins, outside]) fs.rmSync(d, { recursive: true, force: true })
})

describe('run_command execution', () => {
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

describe('run_command bounds', () => {
  it('kills the whole process group on timeout, including a background child', async () => {
    const pidFile = path.join(outside, 'sleep.pid')
    fake('git', `sleep 60 &\necho $! > "${pidFile}"\nwait`)
    const out = await run(makeRegistry({ commandMs: 300 }), 'git status')
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

  it('keeps the command time below the registry tool timeout', async () => {
    const pidFile = path.join(outside, 'reg.pid')
    fake('git', `echo $$ > "${pidFile}"\nexec sleep 60`)
    const registry = new ToolRegistry({ toolTimeoutMs: 1500, maxResultChars: 100000 })
    registerRunCommand(registry, {
      findGrant: async (id) => grants.find((g) => g.id === id),
      getInterpreterPaths: () => interpreters
    })
    const out = await run(registry, 'git status')
    // The handler's own timeout answered, not the registry's rejection.
    expect(out).toMatch(/timed out/)
    expect(out).not.toMatch(/Tool execution timed out|failed/)
    expect(await waitDead(Number(fs.readFileSync(pidFile, 'utf8').trim()))).toBe(true)
  })
})

describe('run_command refuses alike when the environment says no', () => {
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
    // no grant
    fake('git', 'echo ok')
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

describe('run_command path arguments are re-checked on disk', () => {
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
