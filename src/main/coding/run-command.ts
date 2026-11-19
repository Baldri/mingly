/**
 * `run_command`: the one coding tool that executes something.
 *
 * Offered only in mode `propose-run` (the registry re-checks the gate before
 * the handler runs). The command is planned by command-allowlist.ts into a
 * file and an argument vector and started with `shell: false`; nothing here
 * interprets a shell line.
 *
 * What bounds a run (the TOTAL is bounded, not just each piece):
 *   - commands per run          (RUN_MAX_COMMANDS)
 *   - cumulative run time       (RUN_TOTAL_MS, reserved up front, so parallel
 *                                calls of one step cannot each take the full time)
 *   - time per command          (also kept below the registry's tool timeout,
 *                                so a command is dead before the registry gives up)
 *   - output kept               (head and tail within the registry's result
 *                                budget; the process is stopped at a hard cap)
 *
 * The child gets a constructed environment, never `process.env`: API keys and
 * tokens of the Mingly process do not reach it. Its PATH is built from the
 * directories of the interpreters the user configured plus /usr/bin:/bin.
 *
 * Not protected: a permitted command runs project code (a test, an npm script,
 * a conftest) with the user's rights, and that code can read what the user can
 * read and reach the network. The output is a tool result and passes the loop
 * guard like any other, but the guard's content detector is narrower than the
 * blocklist. This is not a sandbox.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import type { ToolRegistry, ToolContext, ToolGate } from '../agent/tool-registry'
import { CODING_MODE_ORDER, parseCodingMode } from '../../shared/coding-types'
import { atLeast } from '../policy/policy-types'
import { isRealPathWithin, resolveRealPath } from '../file-access/real-path-guard'
import { SimpleStore } from '../utils/simple-store'
import { COMMAND_UNAVAILABLE, planCommandDetailed } from './command-allowlist'
import { isBlockedPath, resolvePathSegments } from './path-policy'
import {
  defaultReadToolDeps,
  resolveReadableFile,
  resolveScope,
  type ReadToolDeps,
  type Scope
} from './read-tools'

export const RUN_MAX_COMMANDS = 20
export const RUN_TOTAL_MS = 300_000
export const RUN_COMMAND_MS = 60_000
/** Characters read from a process before it is stopped as a flood. */
export const RUN_OUTPUT_HARD_CAP = 1_000_000
/** Room kept for the status header inside the registry's result budget. */
const HEADER_RESERVE = 400
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024
const MAX_SCRIPTS = 500
const BUDGET_MAX_RUNS = 200
const INTERPRETER_NAMES = ['npm', 'git', 'pytest'] as const

const BUDGET_SPENT = 'Refused: this run has used up its command budget.'

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const runGate: ToolGate = (ctx) => {
  if (!ctx || !ctx.coding) return false
  // Re-parsed: an unknown mode string must read as `off`, never as "high".
  return atLeast(CODING_MODE_ORDER, parseCodingMode(ctx.coding.mode), 'propose-run')
}

// ---------------------------------------------------------------------------
// Settings: configured interpreters
// ---------------------------------------------------------------------------

/**
 * The interpreters the user confirmed in the settings, as absolute paths.
 * Anything that is not a string for a known name is dropped here; the planner
 * then checks absoluteness again.
 */
export function readInterpreterPaths(backing: { get(key: string, d?: unknown): unknown }): Record<string, string> {
  const stored = backing.get('paths', {})
  const out: Record<string, string> = {}
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out
  for (const name of INTERPRETER_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(stored, name)) continue
    const value = (stored as Record<string, unknown>)[name]
    if (typeof value === 'string') out[name] = value
  }
  return out
}

function defaultInterpreterPaths(): Record<string, string> {
  try {
    return readInterpreterPaths(SimpleStore.create('coding-interpreters.json'))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Budget per run
// ---------------------------------------------------------------------------

export interface RunLimits {
  maxCommands: number
  totalMs: number
  commandMs: number
  hardOutputCap: number
}

const DEFAULT_LIMITS: RunLimits = {
  maxCommands: RUN_MAX_COMMANDS,
  totalMs: RUN_TOTAL_MS,
  commandMs: RUN_COMMAND_MS,
  hardOutputCap: RUN_OUTPUT_HARD_CAP
}

class RunBudget {
  private readonly runs = new Map<string, { count: number; reservedMs: number }>()

  constructor(private readonly limits: RunLimits) {}

  /** Synchronous, so two calls of one step cannot both pass on the same last slot. */
  reserve(runId: string, wantMs: number): number | null {
    let entry = this.runs.get(runId)
    if (!entry) {
      // DEBT: the oldest run's budget is forgotten once 200 other runs have used
      // run_command -> upgrade when the app is observed with more than 200 coding
      // runs in one session, or when a run id is ever reused.
      if (this.runs.size >= BUDGET_MAX_RUNS) {
        const oldest = this.runs.keys().next().value
        if (oldest !== undefined) this.runs.delete(oldest)
      }
      entry = { count: 0, reservedMs: 0 }
      this.runs.set(runId, entry)
    }
    const remaining = this.limits.totalMs - entry.reservedMs
    if (entry.count >= this.limits.maxCommands || remaining <= 0) return null
    const grant = Math.min(wantMs, remaining)
    entry.count += 1
    entry.reservedMs += grant
    return grant
  }

  /** Give back the part of the reservation the command did not use. */
  refund(runId: string, unusedMs: number): void {
    const entry = this.runs.get(runId)
    if (entry && unusedMs > 0) entry.reservedMs = Math.max(0, entry.reservedMs - unusedMs)
  }
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

interface ProcessResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  flooded: boolean
  head: string
  tail: string
  omitted: number
}

function killGroup(pid: number | undefined, child: { kill(signal?: NodeJS.Signals): boolean }): void {
  try {
    if (process.platform !== 'win32' && pid !== undefined) process.kill(-pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    // ESRCH: nothing left to kill.
  }
}

/** The environment of the child: built here, `process.env` is not inherited. */
function childEnv(file: string, interpreterPaths: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const dirs = new Set<string>([path.dirname(file)])
  for (const name of INTERPRETER_NAMES) {
    if (Object.prototype.hasOwnProperty.call(interpreterPaths, name) && path.isAbsolute(interpreterPaths[name])) {
      dirs.add(path.dirname(interpreterPaths[name]))
    }
  }
  dirs.add('/usr/bin')
  dirs.add('/bin')
  const env: NodeJS.ProcessEnv = {
    PATH: [...dirs].join(path.delimiter),
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0'
  }
  // Locations, not secrets; npm and git need them to find their caches.
  if (process.env.HOME) env.HOME = process.env.HOME
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  return env
}

function runProcess(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  headMax: number,
  tailMax: number,
  hardCap: number
): Promise<ProcessResult | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, [...args], {
        cwd,
        env,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve(null)
      return
    }

    let head = ''
    let tail = ''
    let total = 0
    let timedOut = false
    let flooded = false
    let settled = false
    let graceTimer: NodeJS.Timeout | undefined

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      // The leader is gone; anything it left behind in its group goes too.
      killGroup(child.pid, child)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        exitCode,
        signal,
        timedOut,
        flooded,
        head,
        tail,
        omitted: Math.max(0, total - head.length - tail.length)
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, child)
    }, timeoutMs)

    const sink = (decoder: StringDecoder) => (chunk: Buffer): void => {
      if (flooded) return
      let text = decoder.write(chunk)
      total += text.length
      if (head.length < headMax) {
        const take = text.slice(0, headMax - head.length)
        head += take
        text = text.slice(take.length)
      }
      if (text.length > 0) tail = (tail + text).slice(-tailMax)
      if (total > hardCap) {
        flooded = true
        killGroup(child.pid, child)
      }
    }
    child.stdout?.on('data', sink(new StringDecoder('utf8')))
    child.stderr?.on('data', sink(new StringDecoder('utf8')))

    child.on('error', () => {
      // Spawn failure: same text as every other environment refusal.
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(null)
    })
    child.on('exit', (code, signal) => {
      // A grandchild that keeps the pipes open must not hold the call forever.
      graceTimer = setTimeout(() => finish(code, signal), 1000)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

// ---------------------------------------------------------------------------
// package.json scripts, binary and path checks (all touch the file system)
// ---------------------------------------------------------------------------

async function readNpmScripts(scope: Scope): Promise<string[]> {
  try {
    const resolved = await resolveReadableFile('package.json', scope)
    if (resolved.kind !== 'ok') return []
    const stat = await fs.promises.stat(resolved.realTarget)
    if (!stat.isFile() || stat.size > PACKAGE_JSON_MAX_BYTES) return []
    const parsed: unknown = JSON.parse(await fs.promises.readFile(resolved.realTarget, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return []
    const scripts = (parsed as { scripts?: unknown }).scripts
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []
    const names: string[] = []
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body === 'string') names.push(name)
      if (names.length >= MAX_SCRIPTS) break
    }
    return names
  } catch {
    return []
  }
}

async function binaryIsRunnable(file: string, projectBin: boolean, scope: Scope): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) return false
    await fs.promises.access(file, fs.constants.X_OK)
    // A project binary is a link into node_modules; it must stay in the project.
    if (projectBin && !(await isRealPathWithin(file, scope.root))) return false
    return true
  } catch {
    return false
  }
}

/** A path argument whose real target leaves the project or is blocked is refused. */
async function pathArgIsSafe(arg: string, scope: Scope): Promise<boolean> {
  const full = path.resolve(scope.root, arg)
  if (!(await isRealPathWithin(full, scope.root))) return false
  const realTarget = await resolveRealPath(full)
  if (realTarget === null) return false
  const rel = path.relative(scope.realRoot, realTarget)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  const segments = resolvePathSegments(rel.split(path.sep).join('/'))
  if (segments === null || segments.includes('..')) return false
  return !isBlockedPath(segments.join('/'))
}

// ---------------------------------------------------------------------------
// Result text
// ---------------------------------------------------------------------------

function cleanOutput(text: string): string {
  // Terminal escape sequences first (CSI and OSC), so no `[31m` stub is left
  // behind; then every remaining control and format character (bidi).
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' || ch === '\t' ? ch : ''))
}

function describeResult(res: ProcessResult, timeoutMs: number): string {
  let status: string
  if (res.timedOut) status = `timed out after ${Math.round(timeoutMs / 100) / 10}s, process group killed`
  else if (res.flooded) status = 'output limit exceeded, process stopped'
  else if (res.signal) status = `terminated by signal ${res.signal}`
  else status = `exit code ${res.exitCode}`
  const out = cleanOutput(res.head) + (res.omitted > 0 ? `\n[... ${res.omitted} characters omitted ...]\n` : '') + cleanOutput(res.tail)
  return `${status}\n${out === '' ? '(no output)' : out}`
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface RunCommandDeps {
  findGrant: ReadToolDeps['findGrant']
  getInterpreterPaths: () => Record<string, string>
  limits: RunLimits
}

async function runCommand(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: RunCommandDeps,
  budget: RunBudget,
  registry: ToolRegistry
): Promise<string> {
  try {
    if (!ctx || !ctx.coding || typeof ctx.coding.projectPath !== 'string') return COMMAND_UNAVAILABLE
    const projectPath = ctx.coding.projectPath
    const command = args.command
    const interpreters = deps.getInterpreterPaths()

    // 1. Pure checks first. Without scripts, an environment-dependent refusal
    //    carries the shared text; any other refusal says why and ends here.
    const pre = planCommandDetailed(command as string, projectPath, interpreters, [])
    if (pre.plan.kind === 'refused' && pre.plan.reason !== COMMAND_UNAVAILABLE) return pre.plan.reason

    // 2. Environment: grant and workspace, then package.json, then the binary.
    const scope = await resolveScope(ctx, { findGrant: deps.findGrant })
    if (!scope) return COMMAND_UNAVAILABLE
    let detailed = pre
    if (pre.plan.kind === 'refused') {
      detailed = planCommandDetailed(command as string, projectPath, interpreters, await readNpmScripts(scope))
    }
    const plan = detailed.plan
    if (plan.kind !== 'run') return plan.reason

    const projectBin = plan.file.startsWith(path.join(scope.root, 'node_modules', '.bin') + path.sep)
    if (!(await binaryIsRunnable(plan.file, projectBin, scope))) return COMMAND_UNAVAILABLE
    for (const arg of detailed.pathArgs) {
      if (!(await pathArgIsSafe(arg, scope))) return COMMAND_UNAVAILABLE
    }

    // 3. Budget. Only a command that is about to start counts.
    const runId = ctx.runId
    if (typeof runId !== 'string' || runId === '') return COMMAND_UNAVAILABLE
    // The command must be dead before the registry's own timeout fires, or the
    // registry would report a failure while the process keeps running.
    const wantMs = Math.min(deps.limits.commandMs, Math.max(500, registry.getToolTimeoutMs() - 1000))
    const timeoutMs = budget.reserve(runId, wantMs)
    if (timeoutMs === null) return BUDGET_SPENT

    const resultBudget = Math.max(1000, registry.getMaxResultChars() - HEADER_RESERVE)
    const headMax = Math.floor(resultBudget / 2)
    const started = Date.now()
    const res = await runProcess(
      plan.file,
      plan.args,
      plan.cwd,
      childEnv(plan.file, interpreters),
      timeoutMs,
      headMax,
      resultBudget - headMax,
      deps.limits.hardOutputCap
    )
    budget.refund(runId, timeoutMs - (Date.now() - started))
    if (res === null) return COMMAND_UNAVAILABLE
    return describeResult(res, timeoutMs)
  } catch {
    return COMMAND_UNAVAILABLE
  }
}

export function registerRunCommand(registry: ToolRegistry, deps: Partial<RunCommandDeps> = {}): void {
  const resolved: RunCommandDeps = {
    findGrant: deps.findGrant ?? defaultReadToolDeps.findGrant,
    getInterpreterPaths: deps.getInterpreterPaths ?? defaultInterpreterPaths,
    limits: { ...DEFAULT_LIMITS, ...deps.limits }
  }
  const budget = new RunBudget(resolved.limits)

  registry.registerBuiltIn(
    {
      name: 'run_command',
      description:
        'Run ONE allowlisted command in the project root, without a shell. Allowed: `npm test`, ' +
        '`npm run <script>` (script must exist in package.json), `vitest run [paths]`, `tsc --noEmit`, ' +
        '`pytest [paths]`, `git status [--short]`, `git diff --stat|--name-only`. No pipes, no ' +
        '`&&`, no quotes, no other flags. The run has a limited number of commands and a time budget; ' +
        'output is cut to head and tail. The command executes project code on the user machine.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line, e.g. "npm test"' }
        },
        required: ['command']
      }
    },
    (args, ctx) => runCommand(args, ctx, resolved, budget, registry),
    runGate
  )
}
