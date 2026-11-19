/**
 * Coding edit tool: `edit_file`.
 *
 * Its whole point is that it does NOT write. It verifies an exact replacement
 * against the file as it is now, records it as a proposal and produces a diff
 * for the human. The write happens in a later step, only after the user has
 * accepted the step's package, and that step re-verifies the old text against
 * the file as it is THEN (time passes between proposing and accepting). The
 * store therefore keeps `oldText` and `newText`, not only the diff.
 *
 * What the model gets back is a confirmation or a reason, never file content:
 * the diff has context lines from the file and goes to the human only. A result
 * with neighbouring lines would be a second read path that skips the consent
 * guard `read_file` results pass through.
 *
 * The file is opened through the SAME path discipline as `read_file`
 * (`resolveReadableFile` in read-tools.ts); this module has no path logic of
 * its own. Every refusal that depends on the file system is one uniform text.
 */

import * as path from 'path'
import type { ToolRegistry, ToolContext, ToolGate } from '../agent/tool-registry'
import {
  CODING_MODE_ORDER,
  parseCodingMode,
  type ProposedEdit
} from '../../shared/coding-types'
import { atLeast } from '../policy/policy-types'
import {
  defaultReadToolDeps,
  readHeadAndBody,
  resolveReadableFile,
  resolveScope,
  type ReadToolDeps
} from './read-tools'

// ---------------------------------------------------------------------------
// Limits and messages
// ---------------------------------------------------------------------------

/** Longest old or new text one proposal may carry (characters). */
export const EDIT_TEXT_MAX_CHARS = 1_000_000
/** Proposals one run may hold unresolved. */
export const EDIT_MAX_PENDING_PER_RUN = 200
const RUN_ID_MAX_CHARS = 256
const CONTEXT_LINES = 3

const REFUSED = 'Refused: this file cannot be edited by the coding tools.'
const BAD_ARGS =
  'Refused: edit_file needs the string arguments "path", "old" (not empty) and "new".'
const BAD_TYPE = 'Refused: this file type is not on the coding edit list.'
const BINARY = 'Refused: the file looks binary and cannot be edited.'
const NOT_UTF8 = 'Refused: the file is not valid UTF-8 and cannot be edited.'
const TOO_LARGE = 'Refused: the file is too large to edit.'

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type ProposeOutcome =
  | { kind: 'proposed'; editId: string }
  | { kind: 'rejected'; reason: string }

export interface EditProposalStore {
  /**
   * `fileContent` is read by the handler and handed in, so the store stays
   * synchronous and testable without a file system. Synchronous also means two
   * parallel calls of one step are checked one after the other, atomically.
   */
  propose(
    runId: string,
    stepNumber: number,
    edit: Omit<ProposedEdit, 'diff' | 'addedLines' | 'removedLines'>,
    fileContent: string
  ): ProposeOutcome
  /** Copies, in proposal order. */
  pending(runId: string): ProposedEdit[]
  /** Acceptance or rejection of the whole package: either way the run's list is cleared. */
  resolve(runId: string, accepted: boolean, reason?: string): void
}

interface Entry {
  stepNumber: number
  /** Collision key of the path: see pathKey(). */
  key: string
  edit: ProposedEdit
}

/**
 * Two spellings that name one file must collide. NFKC plus lower case folds
 * more than a case-sensitive file system distinguishes; the failure direction
 * is a refused second proposal, never two unappliable diffs for one file.
 */
function pathKey(p: string): string {
  return p.normalize('NFKC').toLowerCase()
}

/** Occurrences counted WITH overlap: "aa" in "aaa" is two, i.e. ambiguous. */
function countOccurrences(haystack: string, needle: string): { count: number; first: number } {
  let count = 0
  let first = -1
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    if (count === 0) first = at
    count++
    from = at + 1
  }
  return { count, first }
}

/** Lines with their terminators kept, so "x\n" and "x" at the end differ. */
function toLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function displayLine(prefix: string, line: string): string {
  const body = line.endsWith('\n') ? line.slice(0, -1) : line
  return line.endsWith('\n')
    ? `${prefix}${body}`
    : `${prefix}${body}\n\\ No newline at end of file`
}

interface BuiltDiff {
  diff: string
  addedLines: number
  removedLines: number
}

/** Unified diff of one replacement, `CONTEXT_LINES` of context, single hunk. */
function buildDiff(displayPath: string, before: string, after: string): BuiltDiff {
  const a = toLines(before)
  const b = toLines(after)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }
  const removed = a.slice(prefix, a.length - suffix)
  const added = b.slice(prefix, b.length - suffix)
  const ctxBefore = a.slice(Math.max(0, prefix - CONTEXT_LINES), prefix)
  const ctxAfter = a.slice(a.length - suffix, Math.min(a.length, a.length - suffix + CONTEXT_LINES))

  const oldStart = prefix - ctxBefore.length + 1
  const oldCount = ctxBefore.length + removed.length + ctxAfter.length
  const newCount = ctxBefore.length + added.length + ctxAfter.length
  // A file name may carry anything; a line break in it would forge diff lines.
  const safePath = displayPath.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?')
  const lines = [
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
    `@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@`,
    ...ctxBefore.map((l) => displayLine(' ', l)),
    ...removed.map((l) => displayLine('-', l)),
    ...added.map((l) => displayLine('+', l)),
    ...ctxAfter.map((l) => displayLine(' ', l))
  ]
  return { diff: lines.join('\n'), addedLines: added.length, removedLines: removed.length }
}

function reject(reason: string): ProposeOutcome {
  return { kind: 'rejected', reason }
}

export function createEditProposalStore(): EditProposalStore {
  const runs = new Map<string, Entry[]>()
  let counter = 0

  return {
    propose(runId, stepNumber, edit, fileContent): ProposeOutcome {
      try {
        if (typeof runId !== 'string' || runId === '' || runId.length > RUN_ID_MAX_CHARS) {
          return reject('no valid run to attach the proposal to.')
        }
        if (!Number.isInteger(stepNumber) || stepNumber < 0) {
          return reject('no valid step to attach the proposal to.')
        }
        if (
          !edit ||
          typeof edit.path !== 'string' ||
          edit.path === '' ||
          typeof edit.oldText !== 'string' ||
          typeof edit.newText !== 'string' ||
          typeof fileContent !== 'string'
        ) {
          return reject('the proposal is malformed.')
        }
        if (edit.oldText === '') return reject('the old text must not be empty.')
        if (edit.oldText === edit.newText) {
          return reject('old and new text are identical; there is no change to propose.')
        }
        if (edit.oldText.length > EDIT_TEXT_MAX_CHARS || edit.newText.length > EDIT_TEXT_MAX_CHARS) {
          return reject('the old or new text is too large for one proposal.')
        }
        // The result must stay a text file.
        if (edit.oldText.includes('\u0000') || edit.newText.includes('\u0000')) {
          return reject('the old or new text contains a NUL character.')
        }

        const { count, first } = countOccurrences(fileContent, edit.oldText)
        if (count !== 1) {
          return reject(
            `the old text occurs ${count} times in the file; it must occur exactly once. ` +
              'Nothing was changed. Use a longer, unique piece of the file as the old text.'
          )
        }

        const list = runs.get(runId) ?? []
        const key = pathKey(edit.path)
        if (list.some((e) => e.stepNumber === stepNumber && e.key === key)) {
          return reject(
            'this step already proposed a change to this same file. Steps run their tool calls in ' +
              'parallel, so a second old text would be checked against the file without the first ' +
              'change. Put both changes into one edit, or propose the second in the next step.'
          )
        }
        if (list.length >= EDIT_MAX_PENDING_PER_RUN) {
          return reject('too many unresolved proposals in this run.')
        }

        const after =
          fileContent.slice(0, first) + edit.newText + fileContent.slice(first + edit.oldText.length)
        const built = buildDiff(edit.path, fileContent, after)
        const stored: ProposedEdit = {
          path: edit.path,
          oldText: edit.oldText,
          newText: edit.newText,
          diff: built.diff,
          addedLines: built.addedLines,
          removedLines: built.removedLines
        }
        list.push({ stepNumber, key, edit: stored })
        runs.set(runId, list)
        counter++
        return { kind: 'proposed', editId: `edit-${counter}` }
      } catch {
        return reject('the proposal could not be checked.')
      }
    },

    pending(runId): ProposedEdit[] {
      return (runs.get(runId) ?? []).map((e) => ({ ...e.edit }))
    },

    resolve(runId): void {
      runs.delete(runId)
    }
  }
}

let storeInstance: EditProposalStore | undefined

export function getEditProposalStore(): EditProposalStore {
  storeInstance ??= createEditProposalStore()
  return storeInstance
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface EditToolDeps extends ReadToolDeps {
  store: EditProposalStore
}

const proposeGate: ToolGate = (ctx) => {
  if (!ctx || !ctx.coding) return false
  // Re-parsed: an unknown mode string must read as `off`, never as "high".
  return atLeast(CODING_MODE_ORDER, parseCodingMode(ctx.coding.mode), 'propose')
}

async function editFile(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: EditToolDeps
): Promise<string> {
  try {
    // The proposal is keyed on the run and step the EXECUTOR set; without them
    // there is nothing safe to key it on.
    const runId = ctx?.runId
    const stepNumber = ctx?.stepNumber
    if (typeof runId !== 'string' || runId === '') return REFUSED
    if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber)) return REFUSED

    // Grant present with read AND edit permission, workspace from the context.
    const scope = await resolveScope(ctx, deps, true)
    if (!scope) return REFUSED

    const { old: oldText, new: newText } = args
    if (typeof args.path !== 'string' || args.path === '') return BAD_ARGS
    if (typeof oldText !== 'string' || oldText === '' || typeof newText !== 'string') return BAD_ARGS

    // The same discipline as read_file, one implementation.
    const resolved = await resolveReadableFile(args.path, scope)
    if (resolved.kind === 'bad-type') return BAD_TYPE
    if (resolved.kind !== 'ok') return REFUSED

    const file = await readHeadAndBody(resolved.realTarget)
    if (file.verdict === 'binary') return BINARY
    if (file.verdict === 'large') return TOO_LARGE
    if (file.verdict !== 'ok') return REFUSED
    if (!file.roundTrips) return NOT_UTF8

    // The path as the file system spells it, never the model's spelling: this
    // is what the dialog shows and what the accept step will open.
    const realRel = resolved.realRel.split(path.sep).join('/')
    const outcome = deps.store.propose(
      runId,
      stepNumber,
      { path: realRel, oldText, newText },
      file.text
    )
    if (outcome.kind === 'rejected') return `Rejected: ${outcome.reason}`

    const [latest] = deps.store.pending(runId).filter((e) => e.path === realRel).slice(-1)
    const counts = latest ? ` (-${latest.removedLines}/+${latest.addedLines} lines)` : ''
    return (
      `Proposed${counts}. Nothing was written and the file is unchanged. The change is applied ` +
      'only if the user accepts it.'
    )
  } catch {
    return REFUSED
  }
}

export function registerEditTools(
  registry: ToolRegistry,
  deps: Partial<EditToolDeps> = {}
): void {
  const resolvedDeps = (): EditToolDeps => ({
    findGrant: deps.findGrant ?? defaultReadToolDeps.findGrant,
    store: deps.store ?? getEditProposalStore()
  })

  registry.registerBuiltIn(
    {
      name: 'edit_file',
      description:
        'Propose a change to a text file inside the granted project directory. This does NOT ' +
        'write: it records a proposal that the user reviews as a diff and applies or discards. ' +
        '`old` must occur EXACTLY ONCE in the file (otherwise the proposal is rejected and says ' +
        'how often it occurs); include enough surrounding text to make it unique. ' +
        'At most one proposal per file per step. `path` is relative to the project root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          old: { type: 'string', description: 'Exact text to replace; must occur exactly once' },
          new: { type: 'string', description: 'Replacement text (may be empty to delete)' }
        },
        required: ['path', 'old', 'new']
      }
    },
    (args, ctx) => editFile(args, ctx, resolvedDeps()),
    proposeGate
  )
}
