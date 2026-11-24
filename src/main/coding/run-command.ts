/**
 * `mingly_run_command`: the one coding tool that executes something.
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
import * as os from 'os'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import type { ToolRegistry, ToolContext, ToolGate } from '../agent/tool-registry'
import { CODING_MODE_ORDER, parseCodingMode } from '../../shared/coding-types'
import { AGENT_RUN_TIMEOUT_MS } from '../../shared/types'
import { isConfirmationTimestamp } from '../../shared/file-access-types'
import { atLeast } from '../policy/policy-types'
import { isRealPathWithin, resolveRealPath } from '../file-access/real-path-guard'
import { SimpleStore } from '../utils/simple-store'
import { COMMAND_UNAVAILABLE, ROOT_MARKS, planCommandDetailed, type CommandPlan, type CommandTool } from './command-allowlist'
import { isBlockedPath, resolvePathSegments } from './path-policy'
import {
  defaultReadToolDeps,
  resolveReadableFile,
  resolveScope,
  type ReadToolDeps,
  type Scope
} from './read-tools'

export const RUN_MAX_COMMANDS = 20
/**
 * The cumulative command time of one run, pinned to the agent's run timeout.
 *
 * WHICH CEILING LEADS: the run timeout, because it ends the run outright while
 * this one only refuses the next command. The two must therefore not stand side
 * by side as independent numbers: this was 300_000 against a 120_000 run
 * timeout, so it could never be reached. Before C1 that was harmless — the
 * registry-wide tool timeout capped every command at 14 s — but a command now
 * gets its full RUN_COMMAND_MS, so TWO commands reach the run timeout. Derived
 * rather than copied, so raising the run timeout raises this with it and the
 * relation cannot silently invert again.
 */
export const RUN_TOTAL_MS = AGENT_RUN_TIMEOUT_MS
export const RUN_COMMAND_MS = 60_000
/** The one name this tool is registered under; read in two places. */
const RUN_COMMAND_TOOL = 'mingly_run_command'
/**
 * Room the registry's timeout for THIS tool keeps on top of `commandMs`.
 *
 * The registry used to apply one timeout to every tool (15 s), which capped
 * every command at 14 s: `RUN_COMMAND_MS` and `RUN_TOTAL_MS` were fiction and
 * `npm test` — the showcase command — could not finish. The tool now declares
 * its own timeout, derived from the limits it was built with, so the two
 * numbers cannot drift apart. The reserve covers killing the process group and
 * assembling the result after the handler's own timer fires, and it is larger
 * than the 1 s the handler subtracts below, so the handler is always the one
 * that answers.
 */
const TOOL_TIMEOUT_RESERVE_MS = 5_000
/** Characters read from a process before it is stopped as a flood. */
export const RUN_OUTPUT_HARD_CAP = 1_000_000
/** Room kept for the status header inside the registry's result budget. */
const HEADER_RESERVE = 400
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024
const MAX_SCRIPTS = 500
const BUDGET_MAX_RUNS = 200
export const INTERPRETER_NAMES = ['npm', 'git', 'pytest'] as const

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
 * An entry counts only when it is a string for a known name, is absolute, and
 * carries a confirmation marker in `confirmedAt`. Without the marker an entry
 * cannot be told apart from one a compromised renderer wrote. Pure reader: it
 * never writes, and an unusable marker reads as "not confirmed".
 */
export function readInterpreterPaths(backing: { get(key: string, d?: unknown): unknown }): Record<string, string> {
  const stored = backing.get('paths', {})
  const markers = backing.get('confirmedAt', {})
  const out: Record<string, string> = {}
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out
  const marked = typeof markers === 'object' && markers !== null && !Array.isArray(markers)
    ? (markers as Record<string, unknown>)
    : {}
  for (const name of INTERPRETER_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(stored, name)) continue
    if (!Object.prototype.hasOwnProperty.call(marked, name)) continue
    const value = (stored as Record<string, unknown>)[name]
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue
    if (!isConfirmationTimestamp(marked[name])) continue
    out[name] = value
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
      // mingly_run_command -> upgrade when the app is observed with more than 200 coding
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

  /**
   * Undo a reservation of a command that never started: the slot and its time
   * go back, so a refusal costs nothing.
   */
  release(runId: string, grantedMs: number): void {
    const entry = this.runs.get(runId)
    if (!entry) return
    entry.count = Math.max(0, entry.count - 1)
    entry.reservedMs = Math.max(0, entry.reservedMs - grantedMs)
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
  /** A kill was attempted and refused: the process may still be running. */
  unstoppable: boolean
  head: string
  tail: string
  omitted: number
}

/**
 * How long runProcess waits for `exit`/`close` after it killed the group
 * because of a timeout or a flood.
 *
 * A SIGKILL that landed is reported within milliseconds, so this only ever
 * fires when the signal did NOT land (EPERM, a pid that is not ours any more).
 * Without it the promise never settled: the run's time budget stayed charged
 * for good, and the caller waited for the registry's timeout — which is now 65
 * seconds for this tool, so the hang grew with the fix to the timeout.
 */
const FINAL_SETTLE_MS = 1_000

/**
 * SIGKILL the whole process group, or the child on Windows. ESRCH means the
 * work was already over and is the normal end of every command; anything else
 * (EPERM above all) means the process is STILL RUNNING and this app could not
 * stop it — not a normal end, so it is said out loud and reported back.
 *
 * Returns false only in that second case. The caller must not then claim the
 * group was killed: "process group killed" would be a false sentence in front
 * of the human.
 */
function killGroup(pid: number | undefined, child: { kill(signal?: NodeJS.Signals): boolean }): boolean {
  try {
    if (process.platform !== 'win32' && pid !== undefined) process.kill(-pid, 'SIGKILL')
    else child.kill('SIGKILL')
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return true
    console.warn(
      `mingly_run_command: the process group could not be stopped (${code ?? 'unknown error'}); ` +
        'it may still be running'
    )
    return false
  }
}

/** The environment of the child: built here, `process.env` is not inherited. */
function childEnv(
  file: string,
  interpreterPaths: Readonly<Record<string, string>>,
  pinned: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
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
  Object.assign(env, pinned)
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
    let unstoppable = false
    let graceTimer: NodeJS.Timeout | undefined
    let settleTimer: NodeJS.Timeout | undefined

    /** Kill, and remember a refusal so the result does not claim otherwise. */
    const kill = (): void => {
      if (!killGroup(child.pid, child)) unstoppable = true
    }

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (settleTimer) clearTimeout(settleTimer)
      // The leader is gone; anything it left behind in its group goes too.
      // Deliberately NOT kill(): this is housekeeping after an ordinary end, not
      // a kill the run intended, so a refusal here (killGroup still logs it)
      // must not put "could not be stopped" next to a clean exit code. Only the
      // timeout and flood paths, where stopping the process was the point, mark
      // the result unstoppable.
      killGroup(child.pid, child)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        exitCode,
        signal,
        timedOut,
        flooded,
        unstoppable,
        head,
        tail,
        omitted: Math.max(0, total - head.length - tail.length)
      })
    }

    /**
     * The last resort after a kill: settle anyway. A kill that landed brings
     * `exit` (and then `close`) within milliseconds and clears this; a kill
     * that was REFUSED brings neither, and the promise would otherwise never
     * settle. What is reported then is what was true: it timed out or flooded,
     * with the output collected so far and no exit code.
     */
    const armFinalSettle = (): void => {
      if (settled || settleTimer) return
      settleTimer = setTimeout(() => finish(null, null), FINAL_SETTLE_MS)
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
      armFinalSettle()
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
        kill()
        armFinalSettle()
      }
    }
    child.stdout?.on('data', sink(new StringDecoder('utf8')))
    child.stderr?.on('data', sink(new StringDecoder('utf8')))

    child.on('error', () => {
      // Spawn failure: same text as every other environment refusal.
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (settleTimer) clearTimeout(settleTimer)
      resolve(null)
    })
    child.on('exit', (code, signal) => {
      // A grandchild that keeps the pipes open must not hold the call forever.
      // Nothing is armed after the call has already been answered.
      if (settled) return
      graceTimer = setTimeout(() => finish(code, signal), 1000)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

// ---------------------------------------------------------------------------
// package.json scripts, binary and path checks (all touch the file system)
// ---------------------------------------------------------------------------

/**
 * Script names of the granted root's OWN package.json, or null when it has
 * none (absent, unreadable, outside the grant, not an object). npm resolves
 * its prefix by walking UP from the working directory, so a root without a
 * package.json would run a parent's scripts, outside the grant: null means
 * every npm command is refused.
 */
async function readNpmScripts(scope: Scope): Promise<string[] | null> {
  try {
    const resolved = await resolveReadableFile('package.json', scope)
    if (resolved.kind !== 'ok') return null
    const stat = await fs.promises.stat(resolved.realTarget)
    if (!stat.isFile() || stat.size > PACKAGE_JSON_MAX_BYTES) return null
    const parsed: unknown = JSON.parse(await fs.promises.readFile(resolved.realTarget, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const scripts = (parsed as { scripts?: unknown }).scripts
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []
    const names: string[] = []
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body === 'string') names.push(name)
      if (names.length >= MAX_SCRIPTS) break
    }
    return names
  } catch {
    return null
  }
}

/**
 * Does the granted root carry a mark of this tool's own root (ROOT_MARKS)?
 * An entry counts only if it is a file and, when it is a link, only if its
 * real target stays inside the grant. NOT used for git: a `.git` entry is a
 * redirection, see resolveGitDir.
 */
async function rootHasMark(tool: CommandTool, scope: Scope): Promise<boolean> {
  for (const name of ROOT_MARKS[tool]) {
    try {
      const entry = path.join(scope.realRoot, name)
      const link = await fs.promises.lstat(entry)
      if (link.isSymbolicLink() && !(await isRealPathWithin(entry, scope.root))) continue
      const stat = await fs.promises.stat(entry)
      if (stat.isFile()) return true
    } catch {
      // Absent or unreadable: not a mark.
    }
  }
  return false
}

const GIT_POINTER_MAX_BYTES = 4096

const MAX_LINK_HOPS = 40

/** How long the config probe may take. It reads one bounded local file. */
const GIT_CONFIG_PROBE_MS = 10_000
/** Key names read from one config file before the probe counts as unusable. */
const GIT_CONFIG_KEYS_MAX_CHARS = 512 * 1024

/**
 * Does any of these config KEY NAMES name a program git might run?
 *
 * Measured (git 2.53.0, negative control in the same run): a
 * `filter.<name>.clean` driver selected by a `.gitattributes` in the tree is
 * executed by `git diff --stat`, by `git diff --name-only` and by
 * `git status` / `git status --short` — the last two whenever the file size is
 * unchanged, so git cannot settle from stat alone whether the file is modified.
 * Reaching the same driver through `[include] path = …` works just as well.
 * There is NO git flag that switches clean/smudge off (`--no-ext-diff` and
 * `--no-textconv` cover different drivers), so the repository is refused.
 *
 * What counts as naming a program is unchanged: a `filter` section, a key whose
 * name ends in `command`, and an `include`/`includeIf` section — the last
 * because what it pulls in is not read here, and a check that ignored it would
 * be bypassed by one line.
 *
 * What changed is WHAT is asked. This used to match the TEXT of each line, and
 * accepted whitespace, `]`, `"` or end of line after a section name. git also
 * accepts a dot — the legacy `[filter.lfs]` form — and that form defines a
 * working driver. Measured, with the quoted form as the control in the same run:
 *
 *   [filter.lfs]     git config --get filter.lfs.clean -> /bin/echo PWNED, exit 0
 *   [filter "lfs"]   the same (control)
 *   old regex:       false for [filter.lfs], true for [filter "lfs"]
 *
 * A denylist over spellings cannot promise it found every spelling, and the gap
 * was the symptom, not the defect. So the spelling question now goes to the only
 * authority on it (readGitConfigKeys) and what is left here is a decision over
 * names git has already normalised: git lower-cases the section and the variable
 * and a DOTTED subsection, and keeps the case of a QUOTED one — measured
 * `filter.spy.clean` for `[filter.SPY]` and `filter.LFS.clean` for
 * `[filter "LFS"]`, so the name is lower-cased here before it is judged.
 *
 * Still an OVER-approximation, deliberately: `[include.path] x = …` is a
 * subsection called `path`, not an include directive, and it is refused anyway.
 * A refusal is the safe direction; a miss is not.
 */
export function gitConfigNamesProgram(keys: readonly string[]): boolean {
  return keys.some((key) => {
    const name = key.toLowerCase()
    return (
      name.startsWith('filter.') ||
      name.startsWith('include.') ||
      name.startsWith('includeif.') ||
      // core.sshCommand, diff.<x>.command, trailer.<x>.command and whatever git
      // adds next. A SUBSECTION named command (`foo.command.bar`) does not end
      // the key, so it is not caught — measured.
      name.endsWith('command')
    )
  })
}

/**
 * The config scopes that may appear once system and global config are switched
 * off: the repository's own, and a linked worktree's `config.worktree`.
 *
 * Anything else is git saying it read something this app did not account for,
 * and that is the exact class of mistake this check has already been wrong
 * about twice. Measured that the label is real and not decorative: with
 * `GIT_CONFIG_GLOBAL` pointing at a file that has `user.name`, the output gains
 * a `global` line; with `GIT_CONFIG_GLOBAL=/dev/null` it does not.
 */
const GIT_CONFIG_ALLOWED_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree'])

/**
 * The key names out of a `git config --list --name-only --show-scope` listing,
 * or null when the listing is not one this app can vouch for.
 *
 * Every line git writes is `scope<TAB>key`. Split at the FIRST tab: git refuses
 * a key containing a newline outright (measured: `error: invalid key
 * (newline)`), so one line is one key, but a SUBSECTION may contain a tab, and
 * then the key is simply the whole remainder of the line — measured,
 * `[filter "a<TAB>b"]` lists as `local<TAB>filter.a<TAB>b.clean`, three
 * tab-separated fields. The section part, which decides everything, sits before
 * any tab a repository could inject, so taking the remainder is both
 * unambiguous and complete.
 *
 * null — and the caller refuses — for a line that is not `scope<TAB>key` at all,
 * which is also how a warning on stderr is handled: git writes
 * `warning: unable to access '…/config': Is a directory` and carries on, and a
 * config this app could not have judged must not pass as an empty one.
 *
 * An EMPTY listing is `[]`, not null: git read no configuration, which is the
 * authority's truthful answer and the safe one.
 */
export function parseGitConfigScopes(output: string, onUnparsable?: (line: string) => void): string[] | null {
  const keys: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab <= 0) {
      onUnparsable?.(line)
      return null
    }
    const key = line.slice(tab + 1)
    if (key === '' || !GIT_CONFIG_ALLOWED_SCOPES.has(line.slice(0, tab))) {
      onUnparsable?.(line)
      return null
    }
    keys.push(key)
  }
  return keys
}

/**
 * Will git run a program for THIS repository, under the environment the command
 * will get?
 *
 * The question, and not the files. Two earlier shapes of this check were
 * bypassed, and both failures were the same mistake one level apart:
 *
 *  1. Matching the TEXT of `$GIT_DIR/config` missed git's dotted
 *     `[filter.lfs]`, because a denylist over spellings cannot promise it found
 *     every spelling.
 *  2. Asking git's own parser — but `--file $GIT_DIR/config`, a file this app
 *     chose — missed `$GIT_DIR/config.worktree`, which git reads when
 *     `extensions.worktreeConfig` is set. Measured (git 2.53.0, controls in the
 *     same run): `git config --get filter.evil.clean` answered
 *     `/bin/echo PWNED` while the `--file` route did not list the key at all.
 *     And `extensions.worktreeconfig` is refused by no rule here, so the file
 *     that POINTS at the driver passed the check.
 *
 * So the authority is asked what it will USE, with the same GIT_DIR,
 * GIT_COMMON_DIR and GIT_WORK_TREE the real command is pinned to, and with
 * system and global config switched off so the answer does not depend on the
 * machine. There is no list of files to keep in sync any more, and
 * `extensions.worktreeConfig` needs no special case — which is the point.
 *
 * Global config is out of scope ON PURPOSE, not by oversight: the threat is a
 * FOREIGN repository the user points the agent at, while `~/.gitconfig` is the
 * user's own (a filter he installed, e.g. via `git lfs install`, is no attack),
 * and probing it too would refuse every git command for everyone with git-lfs
 * installed globally. Do not make the probe "consistent" with the real command's
 * environment.
 *
 * `--no-includes` is deliberate: an `include.path` directive then appears as a
 * KEY, which is refused, without git reading whatever it points at (measured
 * A/B: `--includes` pulls the included file's keys in, the default does not).
 *
 * Fail closed on every way of not knowing: git could not be started, exited
 * non-zero (a config git cannot parse is exit 128 — measured), was signalled,
 * timed out, wrote more than this will read, or produced a line that is not
 * `scope<TAB>key`. Truncated output is refused rather than searched, because
 * the key that matters could be the one that was cut. A warning on stderr lands
 * in the same stream and has no tab, so it refuses too — which is how a config
 * git could not open is refused rather than read past.
 *
 * NO empty-output special case: a repository git does not recognise answers
 * with nothing, and measured, the real command then fails with `fatal: not a
 * git repository` — git will use no configuration, which is the truthful answer
 * and the safe one. Adding "but an empty answer is suspicious" would be another
 * assumption on top of the authority, which is what went wrong twice.
 *
 * NOT covered, and not claimed: keys that name a program for commands this tool
 * does not allow. `core.fsmonitor`, the pager and the external diff and textconv
 * drivers are switched off on the command line instead.
 */
async function gitConfigIsSafe(
  gitBinary: string,
  interpreters: Readonly<Record<string, string>>,
  pinned: Readonly<Record<string, string>>,
  cwd: string
): Promise<boolean> {
  const res = await runProcess(
    gitBinary,
    ['config', '--list', '--name-only', '--show-scope', '--no-includes'],
    cwd,
    {
      // The command's own pinned GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE, so
      // the answer is about the invocation that is about to happen.
      ...childEnv(gitBinary, interpreters, pinned),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull
    },
    GIT_CONFIG_PROBE_MS,
    GIT_CONFIG_KEYS_MAX_CHARS,
    1024,
    GIT_CONFIG_KEYS_MAX_CHARS
  )
  if (res === null) return false
  if (res.timedOut || res.flooded || res.omitted > 0) return false
  if (res.signal !== null || res.exitCode !== 0) return false

  // head then tail is the stream in order; omitted === 0 above says none of it
  // was dropped.
  // The refusal that follows is the shared text and says nothing about WHICH line
  // failed: that would let the agent probe repository configuration. The local
  // log may say, so a "git is unavailable here" complaint can be diagnosed.
  const keys = parseGitConfigScopes(res.head + res.tail, (line) =>
    console.warn(
      `mingly_run_command: git config listing refused, unparsable line: ${JSON.stringify(line.slice(0, 200))}`
    )
  )
  return keys !== null && !gitConfigNamesProgram(keys)
}

/**
 * Resolve `input` against the REAL directory `start` the way the operating
 * system would: segment by segment, with lstat and readlink, and every `..`
 * applied to the physical path reached so far (which holds no symlink, so its
 * dirname is its physical parent). Returns the real path, or null when a
 * segment is missing, a link loops (more than 40 hops) or anything fails.
 *
 * Why not path.resolve or fs.realpath: both collapse `..` TEXTUALLY first, so
 * `sub/../x` with `sub` a link into another tree answers `<here>/x` where the
 * kernel (and git) land in `<link target's parent>/x`. Measured on this machine:
 * `cd -P` and Python's realpath follow the link; Node's fs.realpathSync gives
 * ENOENT for the physical-only target, i.e. it collapsed first.
 */
export async function physicalPath(start: string, input: string): Promise<string | null> {
  try {
    const separator = path.sep === '\\' ? /[\\/]+/ : /\/+/
    const pending = input.split(separator)
    // An absolute input discards the base, as path.resolve and the kernel do.
    let current = path.isAbsolute(input) ? path.parse(input).root : start
    let hops = 0
    while (pending.length > 0) {
      const segment = pending.shift() as string
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        current = path.dirname(current)
        continue
      }
      const next = path.join(current, segment)
      const info = await fs.promises.lstat(next)
      if (info.isSymbolicLink()) {
        if (++hops > MAX_LINK_HOPS) return null
        const target = await fs.promises.readlink(next)
        if (path.isAbsolute(target)) current = path.parse(target).root
        pending.unshift(...target.split(separator))
      } else {
        current = next
      }
    }
    return current
  } catch {
    return null
  }
}

/**
 * `rel` resolved physically from the real directory `base` (see physicalPath):
 * the result must be a directory strictly inside the grant, symlinks resolved
 * on both sides.
 */
async function containedDirectory(base: string, rel: string, scope: Scope): Promise<string | null> {
  try {
    const real = await physicalPath(base, rel)
    if (real === null || !(await fs.promises.stat(real)).isDirectory()) return null
    // Equal to the root is refused too: a git dir that IS the work tree is not a git dir.
    if (real === scope.realRoot || !(await isRealPathWithin(real, scope.root))) return null
    return real
  } catch {
    return null
  }
}

/**
 * The git dir git will actually use, or null when it is not provably inside
 * the grant. `.git` is either a directory or a FILE `gitdir: <path>`, and the
 * file sends git elsewhere (measured: a `.git` file naming a foreign repository
 * made `git status` list that repository's index entries from inside the
 * grant). So the target is resolved (relative to the directory holding the
 * file) and must lie inside the grant; so must `commondir` when present.
 * The caller then PINS git to the result (GIT_DIR) and to the granted root as
 * work tree (GIT_WORK_TREE, which beats `core.worktree` from config; measured).
 * Containment is path-sep based: a grant at the filesystem root never passes,
 * which fails closed.
 */
async function resolveGitDir(scope: Scope): Promise<{ gitDir: string; commonDir: string | null } | null> {
  try {
    const entry = path.join(scope.realRoot, '.git')
    const real = await fs.promises.realpath(entry)
    const stat = await fs.promises.stat(real)
    let gitDir: string | null
    if (stat.isDirectory()) {
      gitDir = await containedDirectory(real, '', scope)
    } else if (stat.isFile() && stat.size <= GIT_POINTER_MAX_BYTES) {
      const firstLine = (await fs.promises.readFile(real, 'utf8')).split(/\r?\n/, 1)[0]
      const match = /^gitdir: (.+)$/.exec(firstLine)
      if (!match || match[1].includes('\u0000')) return null
      gitDir = await containedDirectory(scope.realRoot, match[1], scope)
    } else {
      return null
    }
    if (gitDir === null) return null
    // A linked worktree names its main git dir in `commondir`; it must stay inside too.
    let common: string | null = null
    try {
      common = (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8')).split(/\r?\n/, 1)[0]
    } catch {
      common = null
    }
    if (common === null) return { gitDir, commonDir: null }
    const commonDir = common === '' ? null : await containedDirectory(gitDir, common, scope)
    return commonDir === null ? null : { gitDir, commonDir }
  } catch {
    return null
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
  // The two lines above say the group was killed. When the kill was refused
  // that is not true, and the sentence has to be taken back rather than left
  // standing in front of the human.
  if (res.unstoppable) status += ' (the process group could not be stopped and may still be running)'
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

    // 2. Budget, BEFORE any check that touches the environment. A budget
    //    outcome placed after them would make every environment check
    //    observable through it. A command that is then refused on environment
    //    grounds gives its reservation back (release), so a refusal costs
    //    nothing and only a command that actually starts stays charged.
    const runId = ctx.runId
    if (typeof runId !== 'string' || runId === '') return COMMAND_UNAVAILABLE
    // The command must be dead before the registry's own timeout fires, or the
    // registry would report a failure while the process keeps running. The
    // timeout asked for is THIS tool's (see registerRunCommand), not the
    // registry-wide one: the registry-wide one is short on purpose.
    const wantMs = Math.min(
      deps.limits.commandMs,
      Math.max(500, registry.getToolTimeoutMs(RUN_COMMAND_TOOL) - 1000)
    )
    const timeoutMs = budget.reserve(runId, wantMs)
    if (timeoutMs === null) return BUDGET_SPENT

    let started = false
    try {
      // 3. Environment: grant and workspace, package.json, binary, path args.
      //    Running needs `edit` on the grant, like mingly_edit_file: a command can
      //    write files, so it is the stronger tool and may not ask for less.
      const scope = await resolveScope(ctx, { findGrant: deps.findGrant }, true)
      if (!scope) return COMMAND_UNAVAILABLE
      let detailed = pre
      let scripts: string[] | null = []
      if (pre.plan.kind === 'refused' || pre.tool === 'npm') {
        scripts = await readNpmScripts(scope)
        detailed = planCommandDetailed(command as string, projectPath, interpreters, scripts ?? [])
      }
      const plan = detailed.plan
      if (plan.kind !== 'run') return plan.reason
      // The granted root must be the root THIS tool will use: every allowlisted
      // tool searches upward, so without its own mark it would run outside the
      // grant. For npm the package.json read above is the mark (and must be valid).
      if (detailed.tool === undefined) return COMMAND_UNAVAILABLE
      const pinned: Record<string, string> = {}
      let gitDirs: { gitDir: string; commonDir: string | null } | null = null
      if (detailed.tool === 'git') {
        // Its mark is a redirection: validate where it leads and pin git there.
        gitDirs = await resolveGitDir(scope)
        if (gitDirs === null) return COMMAND_UNAVAILABLE
        pinned.GIT_DIR = gitDirs.gitDir
        // The validated common dir becomes authoritative, like GIT_DIR: git reads
        // it from the `commondir` file otherwise, and that file is not trusted.
        if (gitDirs.commonDir !== null) pinned.GIT_COMMON_DIR = gitDirs.commonDir
        pinned.GIT_WORK_TREE = scope.realRoot
      } else if (detailed.tool === 'npm' ? scripts === null : !(await rootHasMark(detailed.tool, scope))) {
        return COMMAND_UNAVAILABLE
      }

      const projectBin = plan.file.startsWith(path.join(scope.root, 'node_modules', '.bin') + path.sep)
      if (!(await binaryIsRunnable(plan.file, projectBin, scope))) return COMMAND_UNAVAILABLE
      for (const arg of detailed.pathArgs) {
        if (!(await pathArgIsSafe(arg, scope))) return COMMAND_UNAVAILABLE
      }

      // The git dir is inside the grant, but its CONTENT still decides what git
      // executes: a clean filter runs for every allowed form (measured). Asked
      // of git itself under the SAME pinned environment, so it comes AFTER the
      // binary check — this is the one check that asks the binary rather than
      // the file system. Not cached per run, deliberately: a permitted command
      // runs project code that can rewrite the config, so an answer is only
      // good for the command it precedes. Environment-dependent, so the shared
      // text and nothing more specific — a differentiated refusal would let the
      // agent probe repository configuration it is not allowed to read.
      if (gitDirs !== null && !(await gitConfigIsSafe(plan.file, interpreters, pinned, plan.cwd))) {
        return COMMAND_UNAVAILABLE
      }

      started = true
      return await execute(plan, interpreters, pinned, timeoutMs, deps, registry, budget, runId)
    } finally {
      if (!started) budget.release(runId, timeoutMs)
    }
  } catch {
    return COMMAND_UNAVAILABLE
  }
}

async function execute(
  plan: Extract<CommandPlan, { kind: 'run' }>,
  interpreters: Readonly<Record<string, string>>,
  pinned: Readonly<Record<string, string>>,
  timeoutMs: number,
  deps: RunCommandDeps,
  registry: ToolRegistry,
  budget: RunBudget,
  runId: string
): Promise<string> {
  const resultBudget = Math.max(1000, registry.getMaxResultChars() - HEADER_RESERVE)
  const headMax = Math.floor(resultBudget / 2)
  const began = Date.now()
  const res = await runProcess(
    plan.file,
    plan.args,
    plan.cwd,
    childEnv(plan.file, interpreters, pinned),
    timeoutMs,
    headMax,
    resultBudget - headMax,
    deps.limits.hardOutputCap
  )
  if (res === null) {
    // Nothing started (spawn failure): same text as every environment refusal,
    // and the reservation goes back like for any other refusal.
    budget.release(runId, timeoutMs)
    return COMMAND_UNAVAILABLE
  }
  budget.refund(runId, timeoutMs - (Date.now() - began))
  return describeResult(res, timeoutMs)
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
      name: RUN_COMMAND_TOOL,
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
    runGate,
    resolved.limits.commandMs + TOOL_TIMEOUT_RESERVE_MS
  )
}
