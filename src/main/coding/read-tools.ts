/**
 * Coding read tools: `list_files` and `read_file`.
 *
 * The first place where a model can actually read a project file, so this is
 * where the earlier guards have to compose. Fixed check order in `read_file`:
 *
 *   grant + read permission
 *   -> isBlockedPath on the path AS GIVEN (before any resolution, so a refusal
 *      reveals nothing about the filesystem)
 *   -> isRealPathWithin (symlinks resolved on both sides)
 *   -> isBlockedPath AGAIN on the resolved real path (a link `src/config.ts ->
 *      ../.env` passes the name check and the containment check; only the
 *      second pass stops it)
 *   -> isReadableExtension (requested name and real target)
 *   -> read the head, isProbablyBinary
 *   -> content
 *
 * Everything fails closed and refuses without detail: no errno, no hint which
 * check fired, nothing about what is on disk. The workspace comes from the
 * ToolContext (one instance per run, created by the executor); a handler never
 * calls ensureProjectWorkspace itself.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ToolRegistry, ToolContext, ToolGate } from '../agent/tool-registry'
import type { ToolResultOrigin } from '../agent/loop-guard'
import type { AgentToolCall } from '../../shared/types'
import { CODING_MODE_ORDER, parseCodingMode } from '../../shared/coding-types'
import { hasPermission, type AllowedDirectory } from '../../shared/file-access-types'
import { atLeast } from '../policy/policy-types'
import { isRealPathWithin, resolveRealPath } from '../file-access/real-path-guard'
import {
  isBlockedPath,
  isProbablyBinary,
  isReadableExtension,
  resolvePathSegments
} from './path-policy'

/** Entries `list_files` returns before it cuts the list and says so. */
export const LIST_FILES_MAX_ENTRIES = 500
/** Directory entries `list_files` inspects before it gives up and says so. */
const LIST_FILES_MAX_VISITED = 50_000
const LIST_FILES_MAX_DEPTH = 40
const MAX_PATTERN_LENGTH = 200
/** Largest file `read_file` opens. Larger: refused, not partially returned. */
const READ_FILE_MAX_BYTES = 2 * 1024 * 1024
const BINARY_HEAD_BYTES = 8000
const READ_DEFAULT_LIMIT = 2000
/** Room kept for the continuation hint (three numbers of up to 7 digits plus text). */
const HINT_RESERVE_CHARS = 120
const ORIGIN_PATH_MAX_CHARS = 300

const REFUSED = 'Refused: this path cannot be read by the coding tools.'
const LIST_REFUSED = 'Refused: the file list cannot be produced.'
// Deliberately the SAME text as REFUSED: a read that fails after containment
// (dangling link, vanished file) must not differ from a refusal, or the
// difference is an existence oracle for paths outside the grant.
const UNREADABLE = REFUSED
const BINARY = 'Refused: the file looks binary and is not returned.'
const BAD_TYPE = 'Refused: this file type is not on the coding read list.'
const TOO_LARGE = 'Refused: the file is too large to read.'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ReadToolDeps {
  /** The persisted grant for a directory id, or undefined. */
  findGrant(directoryId: string): Promise<AllowedDirectory | undefined>
}

/**
 * Loaded lazily: FileAccessManager pulls in electron, which must not load when
 * this module is merely imported by the registry.
 */
let fileAccessModule: Promise<typeof import('../file-access/file-access-manager')> | undefined

const defaultDeps: ReadToolDeps = {
  async findGrant(directoryId) {
    // One shared import promise: parallel tool calls in one step must not start
    // parallel imports of the same module.
    fileAccessModule ??= import('../file-access/file-access-manager')
    const { getFileAccessManager } = await fileAccessModule
    return getFileAccessManager()
      .getAllowedDirectories()
      .find((dir) => dir.id === directoryId)
  }
}

// ---------------------------------------------------------------------------
// Gate and shared scope check
// ---------------------------------------------------------------------------

const readOnlyGate: ToolGate = (ctx) => {
  if (!ctx || !ctx.coding) return false
  // Re-parsed: an unknown mode string must read as `off`, never as "high".
  return atLeast(CODING_MODE_ORDER, parseCodingMode(ctx.coding.mode), 'read-only')
}

interface Scope {
  /** path.resolve(projectPath) */
  root: string
  /** realpath of the project root */
  realRoot: string
  /** Project-relative, posix-separated path of the workspace root (`.mingly`). */
  workspaceRel: string
}

/**
 * Grant and workspace checks shared by both tools. Null means refuse.
 * Requires the workspace in the context (the executor's single instance) and
 * that it sits where ensureProjectWorkspace puts it, so a context that was
 * assembled by hand cannot pass.
 */
async function resolveScope(
  ctx: ToolContext | undefined,
  deps: ReadToolDeps
): Promise<Scope | null> {
  try {
    if (!ctx || !ctx.coding || !ctx.workspace) return null
    const { directoryId, projectPath } = ctx.coding
    if (typeof directoryId !== 'string' || typeof projectPath !== 'string') return null
    if (!path.isAbsolute(projectPath)) return null

    const grant = await deps.findGrant(directoryId)
    if (!grant || !hasPermission(grant, 'read')) return null

    const root = path.resolve(projectPath)
    if (ctx.workspace.root !== path.join(root, '.mingly')) return null
    // The project, not just a file, has to lie inside the grant.
    if (!(await isRealPathWithin(root, grant.path))) return null

    const realRoot = await resolveRealPath(root)
    if (realRoot === null) return null
    return { root, realRoot, workspaceRel: '.mingly' }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Glob and .gitignore matching (deliberately small)
// ---------------------------------------------------------------------------

/**
 * Wildcard matching WITHOUT a regex engine. A glob compiled to a regex with
 * chains of `[^/]*` and `.*` backtracks catastrophically, and both the pattern
 * (written by the model) and the .gitignore (written by the project being read)
 * are untrusted, in the Electron main process. This matcher is the two-pointer
 * star match: no exponential case, O(pattern x text) at worst, and both inputs
 * are length-capped on top of that.
 *
 * Syntax: `?` one character, `*` any run of characters inside ONE path
 * segment, a whole segment `**` any number of segments (including none).
 * `**` inside a longer segment counts as `*`, as in git.
 */
/**
 * Total matching work one listing may do, in matcher steps. The per-rule caps
 * bound one rule, not rules x entries, so the budget is global: when it is
 * spent the listing ends and says it is incomplete.
 */
export const LIST_FILES_WORK_BUDGET = 20_000_000

class WorkBudgetExceeded extends Error {}

interface WorkBudget {
  left: number
}

function spend(budget: WorkBudget): void {
  if (--budget.left < 0) throw new WorkBudgetExceeded()
}

function matchSegment(pattern: string, text: string, budget: WorkBudget): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    spend(budget)
    if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++
      t++
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** `patternSegments` is the pattern split at `/`; `textSegments` the path split at `/`. */
function matchSegments(
  patternSegments: readonly string[],
  textSegments: readonly string[],
  budget: WorkBudget
): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < textSegments.length) {
    spend(budget)
    if (p < patternSegments.length && patternSegments[p] === '**') {
      star = p++
      mark = t
    } else if (p < patternSegments.length && matchSegment(patternSegments[p], textSegments[t], budget)) {
      p++
      t++
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  while (p < patternSegments.length && patternSegments[p] === '**') p++
  return p === patternSegments.length
}

/** Longest .gitignore line and largest rule count honoured; the rest is skipped. */
const GITIGNORE_MAX_LINE_CHARS = 200
const GITIGNORE_MAX_RULES = 1000

interface IgnoreRule {
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  segments: string[]
}

function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    if (rules.length >= GITIGNORE_MAX_RULES) break
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    // A skipped over-long rule only means a file is listed that git would hide.
    if (line.length > GITIGNORE_MAX_LINE_CHARS) continue
    line = line.replace(/(?<!\\) +$/, '')
    if (line === '' || line.startsWith('#')) continue
    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    rules.push({ negated, dirOnly, anchored, segments: line.split('/') })
  }
  return rules
}

/** Last matching rule wins, as in git. */
function isIgnored(
  rules: readonly IgnoreRule[],
  rel: string,
  isDir: boolean,
  budget: WorkBudget
): boolean {
  const relSegments = rel.split('/')
  const baseSegments = [relSegments[relSegments.length - 1]]
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (matchSegments(rule.segments, rule.anchored ? relSegments : baseSegments, budget)) {
      ignored = !rule.negated
    }
  }
  return ignored
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

class ListIncomplete extends Error {}

async function readGitignore(root: string): Promise<IgnoreRule[]> {
  try {
    return parseGitignore(await fs.promises.readFile(path.join(root, '.gitignore'), 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    // Present but unreadable: listing "everything" would be a guess.
    throw new ListIncomplete()
  }
}

async function listFiles(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: ReadToolDeps
): Promise<string> {
  try {
    const scope = await resolveScope(ctx, deps)
    if (!scope) return REFUSED

    let patternSegments: string[] | null = null
    let patternHasSlash = false
    if (args.pattern !== undefined) {
      if (typeof args.pattern !== 'string' || args.pattern.length > MAX_PATTERN_LENGTH) {
        return LIST_REFUSED
      }
      if (args.pattern !== '') {
        patternHasSlash = args.pattern.includes('/')
        patternSegments = args.pattern.split('/')
      }
    }

    const rules = await readGitignore(scope.root)
    const found: string[] = []
    let truncated = false
    let truncatedReason = ''
    let visited = 0
    const budget: WorkBudget = { left: LIST_FILES_WORK_BUDGET }

    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (truncated) return
      if (depth > LIST_FILES_MAX_DEPTH) {
        truncated = true
        truncatedReason = 'maximum directory depth reached'
        return
      }
      const abs = relDir === '' ? scope.root : path.join(scope.root, relDir)
      // Any failure here ends the whole listing (caught below): a list that
      // silently skips a directory it could not read is a false statement.
      const entries = await fs.promises.readdir(abs, { withFileTypes: true })
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

      for (const entry of entries) {
        if (truncated) return
        visited++
        if (visited > LIST_FILES_MAX_VISITED) {
          truncated = true
          truncatedReason = 'scan limit reached'
          return
        }
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`

        if (rel === scope.workspaceRel) continue
        // Every entry goes through the blocklist, directories included: the
        // list must not reveal which blocked files exist.
        if (isBlockedPath(rel)) continue
        // A link is never named and never followed: its target is unchecked.
        if (entry.isSymbolicLink()) continue

        if (entry.isDirectory()) {
          if (isIgnored(rules, rel, true, budget)) continue
          await walk(rel, depth + 1)
        } else if (entry.isFile()) {
          if (isIgnored(rules, rel, false, budget)) continue
          if (patternSegments) {
            const subject = patternHasSlash ? rel.split('/') : [entry.name]
            if (!matchSegments(patternSegments, subject, budget)) continue
          }
          if (found.length >= LIST_FILES_MAX_ENTRIES) {
            truncated = true
            truncatedReason = `more than ${LIST_FILES_MAX_ENTRIES} entries match`
            return
          }
          found.push(rel)
        }
      }
    }

    try {
      await walk('', 0)
    } catch (error) {
      if (!(error instanceof WorkBudgetExceeded)) throw error
      // Same honesty as every other cut: say the list is incomplete.
      truncated = true
      truncatedReason = 'matching work budget reached'
    }

    const lines = found.length > 0 ? found : ['(no files)']
    if (truncated) {
      lines.push(
        `[truncated: ${truncatedReason}; showing ${found.length} entries and the list is INCOMPLETE. ` +
          'Narrow it with the "pattern" argument.]'
      )
    }
    return lines.join('\n')
  } catch {
    return LIST_REFUSED
  }
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

/**
 * The project-relative spelling of what the model passed. A relative path is
 * kept as written. An absolute path is accepted only when it starts with the
 * project root (as written or as resolved), because the compaction notice
 * hands the model absolute paths; the prefix is cut as TEXT so the blocklist
 * still sees every segment the model wrote.
 */
function toRequestedRelative(input: string, scope: Scope): string | null {
  if (!path.isAbsolute(input)) return input
  for (const base of [scope.root, scope.realRoot]) {
    const prefix = base.endsWith(path.sep) ? base : base + path.sep
    if (input.startsWith(prefix) && input.length > prefix.length) {
      return input.slice(prefix.length)
    }
  }
  return null
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback
}

async function readHeadAndBody(
  realTarget: string
): Promise<{ verdict: 'ok'; text: string } | { verdict: 'binary' | 'large' | 'unreadable' }> {
  let handle: fs.promises.FileHandle | undefined
  try {
    // O_NOFOLLOW: the final component was resolved a moment ago; if it has been
    // swapped for a link since, the open fails instead of following it.
    handle = await fs.promises.open(realTarget, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile()) return { verdict: 'unreadable' }
    if (stat.size > READ_FILE_MAX_BYTES) return { verdict: 'large' }

    const buffer = Buffer.alloc(stat.size)
    let position = 0
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, position, stat.size - position, position)
      if (bytesRead === 0) break
      position += bytesRead
    }
    const data = buffer.subarray(0, position)
    if (isProbablyBinary(data.subarray(0, Math.min(data.length, BINARY_HEAD_BYTES)))) {
      return { verdict: 'binary' }
    }
    return { verdict: 'ok', text: data.toString('utf-8') }
  } catch {
    return { verdict: 'unreadable' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readFile(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: ReadToolDeps,
  maxResultChars: () => number
): Promise<string> {
  try {
    // 1. Grant present, read permission, workspace from the context.
    const scope = await resolveScope(ctx, deps)
    if (!scope) return REFUSED

    const input = args.path
    if (typeof input !== 'string' || input === '') return REFUSED
    const requested = toRequestedRelative(input, scope)
    if (requested === null) return REFUSED

    // 2. Blocklist on the path as given, before anything touches the disk.
    if (isBlockedPath(requested)) return REFUSED

    // Pure check on the model's own string: it depends on no file system state,
    // so answering it before containment reveals nothing. (Doing it after left
    // two different answers for a dangling and an outside link with this name.)
    if (!isReadableExtension(requested)) return BAD_TYPE

    // 3. Containment, symlinks resolved on both sides.
    const full = path.resolve(scope.root, requested)
    if (!(await isRealPathWithin(full, scope.root))) return REFUSED

    // 4. Blocklist again, on the resolved real path.
    const realTarget = await resolveRealPath(full)
    if (realTarget === null) return REFUSED
    const realRel = path.relative(scope.realRoot, realTarget)
    if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) return REFUSED
    const realSegments = resolvePathSegments(realRel.split(path.sep).join('/'))
    if (realSegments === null || realSegments.includes('..')) return REFUSED
    const realRelPosix = realSegments.join('/')
    if (isBlockedPath(realRelPosix)) return REFUSED

    // 5. Extension of the real target (the requested name was checked above).
    // Uniform refusal: what the target is called is not the model's business.
    if (!isReadableExtension(realRelPosix)) return REFUSED

    // 6. Head sniff, then the content.
    const result = await readHeadAndBody(realTarget)
    if (result.verdict === 'binary') return BINARY
    if (result.verdict === 'large') return TOO_LARGE
    if (result.verdict !== 'ok') return UNREADABLE

    // The path that was actually read, for the consent dialog. Recorded only
    // now: a refused or failed read leaves no entry, so the dialog never shows
    // text the model wrote.
    // Display form: the name as the file system spells it, NOT the folded form
    // built for matching (case folding and NFKC are for the blocklist only).
    if (ctx?.toolCallId !== undefined) ctx.resolvedPaths?.set(ctx.toolCallId, realRel.split(path.sep).join('/'))

    const lines = result.text.split('\n')
    // A final newline ends the last line; it does not start another.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const offset = positiveInt(args.offset, 1)
    const limit = Math.min(positiveInt(args.limit, READ_DEFAULT_LIMIT), READ_DEFAULT_LIMIT)
    if (offset > lines.length) {
      return `[offset ${offset} is beyond the end of the file, which has ${lines.length} lines]`
    }

    // The whole result, hint included, must fit the registry's budget: the
    // registry cuts at that length and a hint at the end would be the part lost.
    const budget = maxResultChars()
    const bodyBudget = budget - HINT_RESERVE_CHARS
    const first = lines[offset - 1]
    if (bodyBudget <= 0 || first.length > bodyBudget) {
      const skip = offset < lines.length ? ` Continue after it with offset=${offset + 1}.` : ''
      return `[line ${offset} is longer than the ${budget}-character result budget and cannot be returned.${skip}]`
    }

    let used = 0
    let count = 0
    while (count < limit && offset - 1 + count < lines.length) {
      const cost = lines[offset - 1 + count].length + (count > 0 ? 1 : 0)
      if (used + cost > bodyBudget) break
      used += cost
      count++
    }
    const last = offset + count - 1
    const body = lines.slice(offset - 1, last).join('\n')
    const remaining = lines.length - last
    if (remaining === 0) return body
    return (
      `${body}\n[showing lines ${offset}-${last} of ${lines.length}; ` +
      `${remaining} more lines; continue with offset=${last + 1}]`
    )
  } catch {
    return UNREADABLE
  }
}

// ---------------------------------------------------------------------------
// Registration and origin
// ---------------------------------------------------------------------------

export function registerReadTools(registry: ToolRegistry, deps: ReadToolDeps = defaultDeps): void {
  registry.registerBuiltIn(
    {
      name: 'list_files',
      description:
        'List files of the granted project directory, relative to its root. ' +
        'Optional glob `pattern` (`*`, `**`, `?`). Honours .gitignore, hides .mingly, ' +
        'and states when the list is cut.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob filter, e.g. "src/**/*.ts"' }
        }
      }
    },
    (args, ctx) => listFiles(args, ctx, deps),
    readOnlyGate
  )

  registry.registerBuiltIn(
    {
      name: 'read_file',
      description:
        'Read a text file inside the granted project directory. `path` is relative to the ' +
        'project root. `offset` (1-based line) and `limit` (lines, max 2000) page through long files; ' +
        'the result is also bounded by a character budget, and a trailing note says which lines were returned and which offset continues.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          offset: { type: 'number', description: 'First line to return (1-based)' },
          limit: { type: 'number', description: 'Maximum number of lines' }
        },
        required: ['path']
      }
    },
    (args, ctx) => readFile(args, ctx, deps, () => registry.getMaxResultChars()),
    readOnlyGate
  )
}

/**
 * Origin of a tool result for the loop guard. `resolvedPath` is the path the
 * handler actually read (project-relative, symlinks resolved); the model's own
 * spelling is never used, because the dialog that shows it is the one place a
 * human decides. No resolved path means no `filePath`. Stripping of format and
 * control characters is defence in depth for a real file name that carries them.
 */
export function originForToolCall(call: AgentToolCall, resolvedPath?: string): ToolResultOrigin {
  if (call.name === 'read_file' && typeof resolvedPath === 'string') {
    const clean = resolvedPath.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    const filePath = clean.slice(0, ORIGIN_PATH_MAX_CHARS)
    if (filePath !== '') return { toolName: call.name, filePath }
  }
  return { toolName: call.name }
}
