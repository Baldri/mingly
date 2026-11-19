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
 * Three things bound what this tool can leak or mislead with:
 *   - the content it reads to verify the old text is collected BY THE AGENT, so
 *     it passes the same sensitive-data scan as every other collected content;
 *     where it trips, no refusal carries a count (the uniform message).
 *     A per-path cap on failed attempts is defence in depth for the files the
 *     scan does not flag. Together they close the count oracle where it matters
 *     and bound it where it does not; the cap alone is NOT the answer.
 *   - at most ONE pending proposal per file per run, so the diff a human
 *     approves was computed against the file as it will be when written;
 *   - the displayed diff shows invisible and direction-changing characters
 *     escaped (Trojan Source), while the stored text stays byte-exact.
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
/**
 * Failed (ambiguous or not-found) attempts per path per run before the path is
 * closed for the rest of the run. An honest agent needs one or two (it misses
 * once, then corrects); 5 leaves room for three misses. A probe that extracts
 * content one guess at a time needs far more "no" answers than that.
 */
export const EDIT_MAX_FAILED_ATTEMPTS_PER_PATH = 5
/** Audit records kept per run, and finished runs kept readable. */
const AUDIT_MAX_RECORDS_PER_RUN = 1000
const AUDIT_MAX_FINISHED_RUNS = 50
/**
 * Finished runs whose proposals are still awaiting review. When a new one
 * arrives beyond this, the OLDEST retained run's pending proposals are dropped
 * (and recorded as abandoned). A cap on retained runs rather than a per-directory
 * rule because the store knows runs, not directories; the per-run bounds
 * (EDIT_MAX_PENDING_PER_RUN, EDIT_TEXT_MAX_CHARS) bound each run's size.
 */
export const EDIT_MAX_RETAINED_RUNS = 20
const AUDIT_REASON_MAX_CHARS = 500
const CONTEXT_LINES = 3

const REFUSED = 'Refused: this file cannot be edited by the coding tools.'
const BAD_ARGS =
  'Refused: edit_file needs the string arguments "path", "old" (not empty) and "new".'
const BAD_TYPE = 'Refused: this file type is not on the coding edit list.'
const BINARY = 'Refused: the file looks binary and cannot be edited.'
const NOT_UTF8 = 'Refused: the file is not valid UTF-8 and cannot be edited.'
const TOO_LARGE = 'Refused: the file is too large to edit.'
const LIMIT_REACHED =
  'the limit of failed edit attempts for this file was reached in this run; no further edit ' +
  'proposals for this file are accepted in this run.'
/** One text for zero matches and for several, on a file the scan flagged. */
const UNIFORM_NO_MATCH =
  'the old text could not be applied to this file as exactly one match. For this file no ' +
  'further detail is given.'

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
    edit: Pick<ProposedEdit, 'path' | 'oldText' | 'newText'>,
    fileContent: string,
    options?: { contentSensitive?: boolean }
  ): ProposeOutcome
  /** Copies, in proposal order. */
  pending(runId: string): ProposedEdit[]
  /**
   * Acceptance or rejection of the pending package: clears the run's pending
   * list and records the decision (`accepted`, bounded `reason`) for the audit.
   * It does NOT reset the failed-attempt counters: those live as long as the run.
   */
  resolve(runId: string, accepted: boolean, reason?: string): void
  /**
   * The run is over; no further proposals are accepted for it.
   *   'abandoned' (cancelled, failed): the pending package is dropped and
   *     recorded, never applied. Nobody stands behind that work.
   *   'finished' (completed, max steps): the pending package is KEPT, it is the
   *     deliverable awaiting review, and resolve() still works. At most
   *     EDIT_MAX_RETAINED_RUNS such runs are kept; older ones are dropped.
   * The failed-attempt counters end with the run. Audit records stay readable
   * for the last AUDIT_MAX_FINISHED_RUNS runs.
   */
  endRun(runId: string, how: 'abandoned' | 'finished'): void
  /** Records for the audit task to consume. Copies. */
  auditRecords(runId: string): { records: EditAuditRecord[]; dropped: number }
}

export type EditAuditOutcome =
  | 'proposed'
  | 'rejected-ambiguous'
  | 'rejected-not-found'
  | 'limit-reached'
  | 'package-accepted'
  | 'package-rejected'
  | 'package-abandoned'

/**
 * One fact about an edit proposal, shaped for the audit that a later task
 * builds (that task wires THIS record; it must not invent a second trail).
 * Never holds the old or new text: a probe string may be the very secret being
 * guessed. `occurrences` is the real count even where the model was refused
 * detail (`contentSensitive`).
 */
export interface EditAuditRecord {
  runId: string
  stepNumber?: number
  path?: string
  outcome: EditAuditOutcome
  occurrences?: number
  /** Failed attempts on this path in this run, including this one. */
  failedAttempts?: number
  contentSensitive?: boolean
  /** Size of the package, for package-* outcomes. */
  edits?: number
  reason?: string
  at: number
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
  const body = escapeHidden(line.endsWith('\n') ? line.slice(0, -1) : line)
  return line.endsWith('\n')
    ? `${prefix}${body}`
    : `${prefix}${body}\n\\ No newline at end of file`
}

interface BuiltDiff {
  diff: string
  addedLines: number
  removedLines: number
}

/**
 * Characters that can make displayed text differ from what is stored. Tab is
 * deliberately not among them. Rendered visibly in the diff, never removed.
 */
const HIDDEN_CHAR = /[\r\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

function isHidden(ch: string): boolean {
  return ch !== '\t' && ch !== '\n' && /[\r\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)
}

function escapeHidden(text: string): string {
  return text.replace(HIDDEN_CHAR, (ch) => {
    if (ch === '\t') return ch
    const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')
    return `<U+${hex}>`
  })
}

/** True when `after` has more of some hidden code point than `before`. */
function introducesHidden(before: string, after: string): boolean {
  const tally = (t: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (const ch of t) if (isHidden(ch)) m.set(ch, (m.get(ch) ?? 0) + 1)
    return m
  }
  const b = tally(before)
  for (const [ch, n] of tally(after)) if (n > (b.get(ch) ?? 0)) return true
  return false
}

/** Unified diff of one replacement, `CONTEXT_LINES` of context, single hunk. */
function buildDiff(
  displayPath: string,
  before: string,
  after: string,
  hiddenWarning: boolean
): BuiltDiff {
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
    ...(hiddenWarning
      ? [
          '!! This proposal adds invisible or direction-changing characters. They are shown ' +
            'as <U+XXXX> below and are written as they are.'
        ]
      : []),
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

interface RunState {
  entries: Entry[]
  /** Failed attempts per path key; lives as long as the run, not as long as a package. */
  failures: Map<string, number>
  records: EditAuditRecord[]
  dropped: number
  /** Set once the run is over but its package is still under review. */
  ended?: 'finished'
}

function cleanReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined
  return reason.replace(HIDDEN_CHAR, ' ').slice(0, AUDIT_REASON_MAX_CHARS)
}

export function createEditProposalStore(): EditProposalStore {
  const runs = new Map<string, RunState>()
  const finished = new Map<string, { records: EditAuditRecord[]; dropped: number }>()
  /** Ids of finished runs with a package still under review, oldest first. */
  const retained: string[] = []
  let counter = 0

  /** The run no longer holds a package: keep only its audit records. */
  const retire = (runId: string, st: RunState): void => {
    runs.delete(runId)
    const at = retained.indexOf(runId)
    if (at !== -1) retained.splice(at, 1)
    finished.delete(runId)
    finished.set(runId, { records: st.records, dropped: st.dropped })
    while (finished.size > AUDIT_MAX_FINISHED_RUNS) {
      const oldest = finished.keys().next().value
      if (oldest === undefined) break
      finished.delete(oldest)
    }
  }

  const stateFor = (runId: string): RunState => {
    let st = runs.get(runId)
    if (!st) {
      st = { entries: [], failures: new Map(), records: [], dropped: 0 }
      runs.set(runId, st)
    }
    return st
  }

  const record = (st: RunState, rec: Omit<EditAuditRecord, 'at'>): void => {
    if (st.records.length >= AUDIT_MAX_RECORDS_PER_RUN) {
      st.dropped++
      return
    }
    st.records.push({ ...rec, at: Date.now() })
  }

  return {
    propose(runId, stepNumber, edit, fileContent, options): ProposeOutcome {
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

        // A run that has ended adds nothing: a straggler tool call must not
        // grow a package a human is about to review (or revive an abandoned one).
        if (finished.has(runId) || runs.get(runId)?.ended) {
          return reject('this run has already ended; no further proposals are accepted.')
        }

        const st = stateFor(runId)
        const key = pathKey(edit.path)

        // One pending proposal per file per run, across steps: a later one would
        // be verified against the file without the earlier change, and the human
        // would approve a diff computed against stale content.
        if (st.entries.some((e) => e.key === key)) {
          return reject(
            'this file already has a pending proposal in this run. Combine all changes to the ' +
              'file into a single edit_file call: old and new text may span the whole region ' +
              'that changes. If the pending proposal was a mistake, wait for it to be resolved.'
          )
        }

        const failedBefore = st.failures.get(key) ?? 0
        if (failedBefore >= EDIT_MAX_FAILED_ATTEMPTS_PER_PATH) {
          // Decided before the file is looked at: nothing about it can show.
          record(st, {
            runId,
            stepNumber,
            path: edit.path,
            outcome: 'limit-reached',
            failedAttempts: failedBefore,
            ...(options?.contentSensitive ? { contentSensitive: true } : {})
          })
          return reject(LIMIT_REACHED)
        }

        const { count, first } = countOccurrences(fileContent, edit.oldText)
        if (count !== 1) {
          const failedAttempts = failedBefore + 1
          st.failures.set(key, failedAttempts)
          record(st, {
            runId,
            stepNumber,
            path: edit.path,
            outcome: count === 0 ? 'rejected-not-found' : 'rejected-ambiguous',
            occurrences: count,
            failedAttempts,
            ...(options?.contentSensitive ? { contentSensitive: true } : {})
          })
          if (options?.contentSensitive) return reject(UNIFORM_NO_MATCH)
          return reject(
            `the old text occurs ${count} times in the file; it must occur exactly once. ` +
              'Nothing was changed. Use a longer, unique piece of the file as the old text.'
          )
        }
        if (st.entries.length >= EDIT_MAX_PENDING_PER_RUN) {
          return reject('too many unresolved proposals in this run.')
        }

        const after =
          fileContent.slice(0, first) + edit.newText + fileContent.slice(first + edit.oldText.length)
        const hidden = introducesHidden(edit.oldText, edit.newText)
        const built = buildDiff(edit.path, fileContent, after, hidden)
        const stored: ProposedEdit = {
          path: edit.path,
          oldText: edit.oldText,
          newText: edit.newText,
          diff: built.diff,
          addedLines: built.addedLines,
          removedLines: built.removedLines,
          introducesHiddenCharacters: hidden
        }
        st.entries.push({ stepNumber, key, edit: stored })
        record(st, {
          runId,
          stepNumber,
          path: edit.path,
          outcome: 'proposed',
          failedAttempts: failedBefore
        })
        counter++
        return { kind: 'proposed', editId: `edit-${counter}` }
      } catch {
        return reject('the proposal could not be checked.')
      }
    },

    pending(runId): ProposedEdit[] {
      return (runs.get(runId)?.entries ?? []).map((e) => ({ ...e.edit }))
    },

    resolve(runId, accepted, reason): void {
      const st = runs.get(runId)
      if (!st || st.entries.length === 0) return
      record(st, {
        runId,
        outcome: accepted ? 'package-accepted' : 'package-rejected',
        edits: st.entries.length,
        reason: cleanReason(reason)
      })
      st.entries = []
      if (st.ended) retire(runId, st)
    },

    endRun(runId, how): void {
      const st = runs.get(runId)
      if (!st) {
        // Nothing was proposed. Still remember the id as ended, so a late call
        // cannot start a package for a run that is over.
        retire(runId, { entries: [], failures: new Map(), records: [], dropped: 0 })
        return
      }
      st.failures.clear()
      if (how === 'finished' && st.entries.length > 0) {
        st.ended = 'finished'
        retained.push(runId)
        while (retained.length > EDIT_MAX_RETAINED_RUNS) {
          const oldestId = retained[0]
          const old = runs.get(oldestId)
          if (old) {
            record(old, {
              runId: oldestId,
              outcome: 'package-abandoned',
              edits: old.entries.length,
              reason: 'dropped: too many finished runs awaiting review'
            })
            old.entries = []
            retire(oldestId, old)
          } else {
            retained.shift()
          }
        }
        return
      }
      if (st.entries.length > 0) {
        record(st, { runId, outcome: 'package-abandoned', edits: st.entries.length })
        st.entries = []
      }
      retire(runId, st)
    },

    auditRecords(runId): { records: EditAuditRecord[]; dropped: number } {
      const src = runs.get(runId) ?? finished.get(runId)
      if (!src) return { records: [], dropped: 0 }
      return { records: src.records.map((r) => ({ ...r })), dropped: src.dropped }
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
  /**
   * The sensitive-data scan, applied to the file content this tool reads. Same
   * detector the loop guard uses. True means: tripped.
   */
  scanSensitive: (text: string) => Promise<boolean>
}

/** Lazy: the detector's module graph must not load when the registry is merely imported. */
async function defaultScanSensitive(text: string): Promise<boolean> {
  const { getSensitiveDataDetector } = await import('../security/sensitive-data-detector')
  return getSensitiveDataDetector().scan(text).hasSensitiveData
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

    // Content the agent collects passes the same classifier as text a human
    // typed. Fail closed: a scan that cannot run counts as tripped.
    let contentSensitive = true
    try {
      contentSensitive = await deps.scanSensitive(file.text)
    } catch {
      contentSensitive = true
    }
    const outcome = deps.store.propose(
      runId,
      stepNumber,
      { path: realRel, oldText, newText },
      file.text,
      { contentSensitive }
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
    store: deps.store ?? getEditProposalStore(),
    scanSensitive: deps.scanSensitive ?? defaultScanSensitive
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
