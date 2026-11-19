/**
 * Command planning for `mingly_run_command` (pure and synchronous).
 *
 * A command line is split on plain spaces into an argument vector and matched
 * against a short allowlist of prefixes WITH argument checking (not a regex
 * over the whole line). The guard hangs on the argument vector that will be
 * executed, never on how the command was spelled.
 *
 * Binaries: every executable is either `<project>/node_modules/.bin/<name>` or
 * an absolute path the user configured in the settings. `PATH` is never
 * consulted, so a packaged app behaves like the development build.
 *
 * Check order (a check that touches the environment runs after every check
 * that does not):
 *   1. input shape, shell syntax, character set, allowlist match, argument
 *      checks  -> refusals that say why (they depend only on the caller's text)
 *   2. npm script membership, interpreter lookup, project path  -> ONE shared
 *      refusal text, COMMAND_UNAVAILABLE, so that "npm is not configured" and
 *      "no such script" cannot be told apart from the outside.
 * The on-disk existence of the planned binary is checked later, by the
 * handler, with the same text.
 *
 * What this module does NOT do: it does not sandbox. An allowed command runs
 * project code (a test file, an npm script) with the rights of the user.
 */

import * as path from 'path'
import { isBlockedPath, resolvePathSegments } from './path-policy'

export type CommandPlan =
  | { kind: 'run'; file: string; args: string[]; cwd: string }
  | { kind: 'refused'; reason: string }

/** The one text for every refusal that depends on the environment. */
export const COMMAND_UNAVAILABLE = 'Refused: this command cannot be run.'

const MAX_COMMAND_CHARS = 500
const MAX_TOKENS = 12
const MAX_PATH_ARGS = 8
const MAX_PATH_ARG_CHARS = 200

/** Shell syntax, quoting, substitution, every control character and DEL. */
const SHELL_SYNTAX = /[&|;<>$`(){}'"\\\u0000-\u001f\u007f]/
/** What a token may consist of once shell syntax is excluded. ASCII only. */
const TOKEN_CHARS = /^[A-Za-z0-9._:/@+,=-]+$/
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/

const refuse = (reason: string): CommandPlan => ({ kind: 'refused', reason })
const unavailable = (): CommandPlan => refuse(COMMAND_UNAVAILABLE)

/** The tools an allowlisted command can start (`npx tsc` counts as tsc). */
export type CommandTool = 'npm' | 'tsc' | 'vitest' | 'pytest' | 'git'

const CONFIG_EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']

/**
 * What marks the granted directory as THIS tool's own root: at least one of
 * these entries must exist directly in it. Every one of these tools looks for
 * its root or config UPWARD from the working directory, so without a mark of
 * its own the tool would run on a root outside the grant.
 *
 * Measured on this machine (macOS, 2026-11): npm runs a parent's package.json
 * scripts; tsc compiles a parent's tsconfig.json; git reports the parent
 * repository; vitest loads a parent's vitest.config (its root stays the
 * working directory). pytest is UNMEASURED (not installed here): its marks
 * are a fail-closed precondition and are NOT a claim that they are enough.
 * `.git` may be a directory or a file (linked worktree); the rest are files.
 */
export const ROOT_MARKS: Readonly<Record<CommandTool, readonly string[]>> = {
  npm: ['package.json'],
  tsc: ['tsconfig.json'],
  vitest: CONFIG_EXTENSIONS.flatMap((e) => [`vitest.config.${e}`, `vite.config.${e}`]),
  pytest: ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg'],
  git: ['.git']
}

/** How a planned command finds its executable. */
type Binary =
  | { kind: 'project-bin'; name: string }
  | { kind: 'interpreter'; name: string }

interface Matched {
  tool: CommandTool
  binary: Binary
  args: string[]
  /** Arguments that name project paths; the handler re-checks them on disk. */
  pathArgs: string[]
  /** Set when script membership in package.json must be confirmed. */
  npmScript?: string
}

type Match = Matched | { refusal: string }

const GIT_PREFIX = ['-c', 'core.fsmonitor=false', '--no-pager']

/**
 * A path argument: relative, no flag, no `..` escape, not on the blocklist.
 * Pure text check; symlinks are the handler's business.
 */
function checkPathArg(token: string): boolean {
  if (token.length > MAX_PATH_ARG_CHARS) return false
  if (token.startsWith('-') || token.startsWith('/') || token.includes(':')) return false
  const segments = resolvePathSegments(token)
  if (segments === null || segments.length === 0 || segments.includes('..')) return false
  return !isBlockedPath(token)
}

function pathArgsOrRefusal(rest: readonly string[]): string[] | { refusal: string } {
  if (rest.length > MAX_PATH_ARGS) return { refusal: 'Refused: too many path arguments.' }
  for (const token of rest) {
    if (!checkPathArg(token)) {
      return { refusal: 'Refused: arguments must be relative project paths (no flags, no ..).' }
    }
  }
  return [...rest]
}

function sameArgs(rest: readonly string[], expected: readonly string[]): boolean {
  return rest.length === expected.length && rest.every((t, i) => t === expected[i])
}

function matchTokens(tokens: readonly string[]): Match {
  const [cmd, ...rest] = tokens
  const notListed = { refusal: 'Refused: this command is not on the allowlist.' }

  switch (cmd) {
    case 'npm': {
      if (sameArgs(rest, ['test'])) {
        return { tool: 'npm', binary: { kind: 'interpreter', name: 'npm' }, args: ['test'], pathArgs: [] }
      }
      if (rest.length === 2 && rest[0] === 'run') {
        if (!SCRIPT_NAME.test(rest[1])) return { refusal: 'Refused: not a valid npm script name.' }
        return {
          tool: 'npm',
          binary: { kind: 'interpreter', name: 'npm' },
          args: ['run', rest[1]],
          pathArgs: [],
          npmScript: rest[1]
        }
      }
      return { refusal: 'Refused: only `npm test` and `npm run <script>` are allowed.' }
    }
    case 'npx':
      // Only the form that maps onto the project's own tsc. npx itself is
      // never run: it can download and execute a package that is not installed.
      if (sameArgs(rest, ['tsc', '--noEmit'])) {
        return { tool: 'tsc', binary: { kind: 'project-bin', name: 'tsc' }, args: ['--noEmit'], pathArgs: [] }
      }
      return { refusal: 'Refused: only `npx tsc --noEmit` is allowed.' }
    case 'tsc':
      if (sameArgs(rest, ['--noEmit'])) {
        return { tool: 'tsc', binary: { kind: 'project-bin', name: 'tsc' }, args: ['--noEmit'], pathArgs: [] }
      }
      return { refusal: 'Refused: only `tsc --noEmit` is allowed.' }
    case 'vitest': {
      if (rest[0] !== 'run') return { refusal: 'Refused: only `vitest run [paths]` is allowed.' }
      const paths = pathArgsOrRefusal(rest.slice(1))
      if ('refusal' in paths) return paths
      return { tool: 'vitest', binary: { kind: 'project-bin', name: 'vitest' }, args: ['run', ...paths], pathArgs: paths }
    }
    case 'pytest': {
      const paths = pathArgsOrRefusal(rest)
      if ('refusal' in paths) return paths
      return { tool: 'pytest', binary: { kind: 'interpreter', name: 'pytest' }, args: paths, pathArgs: paths }
    }
    case 'git': {
      // `-c core.fsmonitor=false` and the no-ext-diff/no-textconv switches stop
      // repository configuration from naming a program git would then run.
      if (sameArgs(rest, ['status'])) {
        return { tool: 'git', binary: { kind: 'interpreter', name: 'git' }, args: [...GIT_PREFIX, 'status'], pathArgs: [] }
      }
      if (sameArgs(rest, ['status', '--short'])) {
        return {
          tool: 'git',
          binary: { kind: 'interpreter', name: 'git' },
          args: [...GIT_PREFIX, 'status', '--short'],
          pathArgs: []
        }
      }
      if (sameArgs(rest, ['diff', '--stat']) || sameArgs(rest, ['diff', '--name-only'])) {
        return {
          tool: 'git',
          binary: { kind: 'interpreter', name: 'git' },
          args: [...GIT_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', rest[1]],
          pathArgs: []
        }
      }
      if (sameArgs(rest, ['diff'])) {
        return {
          refusal:
            'Refused: `git diff` prints file contents, which would bypass the blocklist. Use `git diff --stat` or `git diff --name-only`.'
        }
      }
      return { refusal: 'Refused: only `git status [--short]` and `git diff --stat|--name-only` are allowed.' }
    }
    default:
      return notListed
  }
}

function resolveInterpreter(
  name: string,
  interpreterPaths: Readonly<Record<string, string>>
): string | null {
  // Own keys only: `constructor` or `__proto__` must not name an interpreter.
  if (!Object.prototype.hasOwnProperty.call(interpreterPaths, name)) return null
  const configured: unknown = interpreterPaths[name]
  if (typeof configured !== 'string' || configured === '') return null
  if (configured.includes('\u0000') || !path.isAbsolute(configured)) return null
  return configured
}

/** The plan plus the path arguments the handler must re-check on disk. */
export interface DetailedPlan {
  plan: CommandPlan
  pathArgs: string[]
  /** The tool the plan starts; absent for a refused plan. */
  tool?: CommandTool
}

export function planCommandDetailed(
  raw: string,
  projectPath: string,
  interpreterPaths: Readonly<Record<string, string>>,
  npmScripts: readonly string[] = []
): DetailedPlan {
  const out = (plan: CommandPlan): DetailedPlan => ({ plan, pathArgs: [] })

  // 1. Pure checks on the caller's own text.
  if (typeof raw !== 'string') return out(refuse('Refused: the command must be a string.'))
  if (raw.length > MAX_COMMAND_CHARS) return out(refuse('Refused: the command is too long.'))
  if (SHELL_SYNTAX.test(raw)) {
    return out(
      refuse('Refused: shell syntax (& | ; < > $ ` ( ) { } quotes, backslash, control characters) is not interpreted.')
    )
  }
  const trimmed = raw.replace(/^ +| +$/g, '')
  if (trimmed === '') return out(refuse('Refused: the command is empty.'))
  const tokens = trimmed.split(/ +/)
  if (tokens.length > MAX_TOKENS) return out(refuse('Refused: too many arguments.'))
  if (!tokens.every((t) => TOKEN_CHARS.test(t))) {
    return out(refuse('Refused: the command contains characters outside the allowed set.'))
  }
  const matched = matchTokens(tokens)
  if ('refusal' in matched) return out(refuse(matched.refusal))

  // 2. Environment-dependent checks, one shared refusal text.
  if (!path.isAbsolute(projectPath)) return out(unavailable())
  if (matched.npmScript !== undefined && !npmScripts.includes(matched.npmScript)) {
    return out(unavailable())
  }
  let file: string
  if (matched.binary.kind === 'project-bin') {
    file = path.join(projectPath, 'node_modules', '.bin', matched.binary.name)
  } else {
    const configured = resolveInterpreter(matched.binary.name, interpreterPaths)
    if (configured === null) return out(unavailable())
    file = configured
  }
  return {
    plan: { kind: 'run', file, args: matched.args, cwd: projectPath },
    pathArgs: matched.pathArgs,
    tool: matched.tool
  }
}

/**
 * `npmScripts` comes from the project's package.json and is passed in so this
 * function stays pure. Empty or absent means no `npm run <script>` is allowed.
 */
export function planCommand(
  raw: string,
  projectPath: string,
  interpreterPaths: Readonly<Record<string, string>>,
  npmScripts?: readonly string[]
): CommandPlan {
  return planCommandDetailed(raw, projectPath, interpreterPaths, npmScripts).plan
}
