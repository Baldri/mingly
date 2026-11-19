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
const ORIGIN_PATH_MAX_CHARS = 300

const REFUSED = 'Refused: this path cannot be read by the coding tools.'
const LIST_REFUSED = 'Refused: the file list cannot be produced.'
const UNREADABLE = 'Refused: the file cannot be read.'
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
const defaultDeps: ReadToolDeps = {
  async findGrant(directoryId) {
    const { getFileAccessManager } = await import('../file-access/file-access-manager')
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

/** `**` crosses directories, `*` and `?` do not. Everything else is literal. */
function globToRegexSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')
    }
  }
  return out
}

interface IgnoreRule {
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  regex: RegExp
}

function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
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
    rules.push({
      negated,
      dirOnly,
      anchored,
      regex: new RegExp(`^${globToRegexSource(line)}$`)
    })
  }
  return rules
}

/** Last matching rule wins, as in git. */
function isIgnored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.regex.test(rule.anchored ? rel : base)) ignored = !rule.negated
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

    let patternRegex: RegExp | null = null
    let patternHasSlash = false
    if (args.pattern !== undefined) {
      if (typeof args.pattern !== 'string' || args.pattern.length > MAX_PATTERN_LENGTH) {
        return LIST_REFUSED
      }
      if (args.pattern !== '') {
        patternHasSlash = args.pattern.includes('/')
        patternRegex = new RegExp(`^${globToRegexSource(args.pattern)}$`)
      }
    }

    const rules = await readGitignore(scope.root)
    const found: string[] = []
    let truncated = false
    let truncatedReason = ''
    let visited = 0

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
          if (isIgnored(rules, rel, true)) continue
          await walk(rel, depth + 1)
        } else if (entry.isFile()) {
          if (isIgnored(rules, rel, false)) continue
          if (patternRegex) {
            const subject = patternHasSlash ? rel : entry.name
            if (!patternRegex.test(subject)) continue
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

    await walk('', 0)

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
  deps: ReadToolDeps
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

    // 5. Extension, for the name the model asked for and for the real target.
    if (!isReadableExtension(requested) || !isReadableExtension(realRelPosix)) return BAD_TYPE

    // 6. Head sniff, then the content.
    const result = await readHeadAndBody(realTarget)
    if (result.verdict === 'binary') return BINARY
    if (result.verdict === 'large') return TOO_LARGE
    if (result.verdict !== 'ok') return UNREADABLE

    const lines = result.text.split('\n')
    const offset = positiveInt(args.offset, 1)
    const limit = Math.min(positiveInt(args.limit, READ_DEFAULT_LIMIT), READ_DEFAULT_LIMIT)
    if (offset > lines.length) {
      return `[offset ${offset} is beyond the end of the file, which has ${lines.length} lines]`
    }
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const remaining = lines.length - (offset - 1 + slice.length)
    const body = slice.join('\n')
    return remaining > 0
      ? `${body}\n[${remaining} more lines; continue with offset=${offset + slice.length}]`
      : body
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
        'project root. `offset` (1-based line) and `limit` (lines, max 2000) page through long files.',
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
    (args, ctx) => readFile(args, ctx, deps),
    readOnlyGate
  )
}

/**
 * Origin of a tool result for the loop guard. Only `read_file` knows a file.
 * The path is model-supplied text that ends up in a dialog and in a withheld
 * notice, so control characters are dropped and the length is capped.
 */
export function originForToolCall(call: AgentToolCall): ToolResultOrigin {
  if (call.name === 'read_file' && typeof call.arguments?.path === 'string') {
    // eslint-disable-next-line no-control-regex
    const clean = call.arguments.path.replace(/[\u0000-\u001f\u007f]/g, '')
    const filePath = clean.slice(0, ORIGIN_PATH_MAX_CHARS)
    if (filePath !== '') return { toolName: call.name, filePath }
  }
  return { toolName: call.name }
}
