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
 * What bounds what this tool can leak or mislead with:
 *   - every refusal that depends on the file content is ONE text (see
 *     NOT_EXACTLY_ONCE): the same for "not found" and "not unique", no number,
 *     the same on every file. Any variation, a count or a different message for
 *     files a scan flagged, would tell the model something about content it has
 *     not read. What remains is the one bit of whether a proposal was accepted;
 *     the per-path cap on failed attempts bounds how often that can be asked.
 *   - at most ONE pending proposal per file per run, and every proposal stores
 *     the hash of the file as read plus the match position: the apply step can
 *     prove the file is the one the human's diff was computed against
 *     (editStillMatches), including when another run or the user changed it;
 *   - the displayed diff shows invisible, blank and confusable characters
 *     escaped (Trojan Source), while the stored text stays byte-exact;
 *   - everything held is bounded in total (byte budget, retained-run cap), and
 *     the bound is enforced by REFUSING new proposals: a package waiting for
 *     review is never dropped to make room.
 *
 * The file is opened through the SAME path discipline as `read_file`
 * (`resolveReadableFile` in read-tools.ts); this module has no path logic of
 * its own. Every refusal that depends on the file system is one uniform text.
 */

import { createHash } from 'crypto'
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
 * Finished runs whose proposals are still awaiting review. A NEW run's first
 * proposal is refused while this many are waiting (resolve one to free a slot);
 * nothing already waiting is ever dropped. A cap on runs rather than a
 * per-directory rule because the store knows runs, not directories. Runs that
 * were already running when the cap was reached may still end into retention, so
 * the count can overshoot by the number of concurrent runs; the byte budget
 * bounds the total regardless.
 */
export const EDIT_MAX_RETAINED_RUNS = 20
/**
 * Global ceiling on what the store holds across ALL runs (path, old text, new
 * text and diff of every pending proposal, in bytes). Each per-run and per-text
 * cap is fine alone; their product is gigabytes in the main process, where that
 * is a crash and not a slowdown. 32 MiB is sized for a real session: a typical
 * proposal is a few KB, a large one 30 KB. A maximal proposal (1,000,000
 * characters per text) costs several MB, so about eight of those fill it: that
 * is why the response to reaching it is a REFUSAL of the new proposal and not
 * the eviction of old ones, which a runaway run could use to wipe every package
 * waiting for review.
 */
export const EDIT_PENDING_BYTES_BUDGET = 32 * 1024 * 1024
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
/**
 * The ONE refusal for a content-dependent miss. "Not found" and "not unique"
 * need the same remedy, so the advice is the same and nothing varies with the
 * file: no count, no distinction, no difference between files.
 */
const NOT_EXACTLY_ONCE =
  'the old text was not found exactly once in the file, or the resulting change is too large ' +
  'to hold. Nothing was changed. Read the file and give a longer old text that appears exactly ' +
  'once, or a smaller edit.'
const CAPACITY_BYTES =
  'too much pending change data in this session (byte budget). Propose smaller edits, or ' +
  'resolve the proposals that are waiting for review to free space.'
const CAPACITY_RUNS =
  'too many finished runs are awaiting review. Resolve one of their proposal packages to free ' +
  'a slot; nothing waiting has been dropped.'

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
    fileContent: string
  ): ProposeOutcome
  /**
   * Every check that needs nothing from the file. The handler calls it BEFORE
   * reading the file, so a refusal that does not depend on content never opens
   * it. Null means: go on and read. `propose` runs the same checks again.
   */
  precheck(
    runId: string,
    stepNumber: number,
    edit: Pick<ProposedEdit, 'path' | 'oldText' | 'newText'>
  ): ProposeOutcome | null
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
   *     deliverable awaiting review, and resolve() still works. Nothing kept
   *     is ever dropped to make room: new proposals are refused instead.
   * The failed-attempt counters end with the run. Audit records stay readable
   * for the last AUDIT_MAX_FINISHED_RUNS runs.
   */
  endRun(runId: string, how: 'abandoned' | 'finished'): void
  /** Bytes held by pending proposals across all runs (diagnostic and test seam). */
  pendingBytes(): number
  /** Records for the audit task to consume. Copies. */
  auditRecords(runId: string): { records: EditAuditRecord[]; dropped: number }
}

export type EditAuditOutcome =
  | 'proposed'
  | 'rejected-ambiguous'
  | 'rejected-not-found'
  | 'limit-reached'
  | 'rejected-capacity'
  | 'package-accepted'
  | 'package-rejected'
  | 'package-abandoned'

/**
 * One fact about an edit proposal, shaped for the audit that a later task
 * builds (that task wires THIS record; it must not invent a second trail).
 * Never holds the old or new text: a probe string may be the very secret being
 * guessed. `occurrences` is 0 or 2 (two or more): counting stops at the second
 * match, which is all the decision needs and what bounds the work.
 */
export interface EditAuditRecord {
  runId: string
  stepNumber?: number
  path?: string
  outcome: EditAuditOutcome
  occurrences?: number
  /** Failed attempts on this path in this run, including this one. */
  failedAttempts?: number
  /** Size of the package, for package-* outcomes. */
  edits?: number
  reason?: string
  at: number
}

interface Entry {
  /** Size in the store's accounting: path + old + new + diff. */
  bytes: number
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

/**
 * 0, 1, or 2 meaning "two or more", with the first index, in O(haystack +
 * needle) time: Knuth-Morris-Pratt, which never moves back in the haystack.
 * Stopping at the second match bounds the NUMBER of searches, not the cost of
 * one, and the engine's indexOf is quadratic on a long near-match everywhere
 * (one call on a^400000 vs a^100000 b a^99999 took 4743 ms, about 106 s at the
 * 2 MiB cap), so the search itself is linear and the class is gone. Overlap
 * still counts: "aa" in "aaa" is two. `steps`, when given, receives the number
 * of character comparisons, so a test can assert the work and not the clock.
 */
export function findUpToTwo(
  haystack: string,
  needle: string,
  steps?: { n: number }
): { count: 0 | 1 | 2; first: number } {
  const m = needle.length
  const n = haystack.length
  if (m === 0 || m > n) return { count: 0, first: -1 }
  const fail = new Int32Array(m)
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && needle.charCodeAt(i) !== needle.charCodeAt(k)) {
      k = fail[k - 1]
      if (steps) steps.n++
    }
    if (steps) steps.n++
    if (needle.charCodeAt(i) === needle.charCodeAt(k)) k++
    fail[i] = k
  }
  let first = -1
  for (let i = 0, k = 0; i < n; i++) {
    while (k > 0 && haystack.charCodeAt(i) !== needle.charCodeAt(k)) {
      k = fail[k - 1]
      if (steps) steps.n++
    }
    if (steps) steps.n++
    if (haystack.charCodeAt(i) === needle.charCodeAt(k)) k++
    if (k === m) {
      if (first !== -1) return { count: 2, first }
      first = i - m + 1
      k = fail[k - 1]
    }
  }
  return first === -1 ? { count: 0, first: -1 } : { count: 1, first }
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
 * Characters that render invisibly or confusably, built from that property and
 * not from one Unicode category: controls, format characters (bidi, zero-width,
 * soft hyphen, tags), lone surrogates, private use and unassigned code points,
 * line and paragraph separators, EVERY space separator (the plain space is
 * exempted below), and the letters and marks that draw nothing yet are valid in
 * identifiers: Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the blank
 * braille pattern U+2800, the combining grapheme joiner U+034F, the Khmer
 * inherent vowels, Mongolian and general variation selectors. Err towards
 * escaping: a visibly escaped harmless character costs the reviewer one glance,
 * a missed one costs the review. Tab and plain space stay as they are; a
 * newline never occurs inside one displayed line. Rendered visibly in the diff,
 * never removed from what is stored.
 *
 * REVISIT THIS LIST when the Unicode tables move (a new Unicode version adds
 * Default_Ignorable, variation-selector and join-control points). U+180F, the
 * Mongolian free variation selector four, slipped through an earlier version
 * because the range stopped one point short. The tests enumerate the points.
 */
const HIDDEN_SET =
  '\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Zs}' +
  '\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u2800\\u3164\\uFE00-\\uFE0F\\uFFA0' +
  '\\u{E0100}-\\u{E01EF}'
const HIDDEN_CHAR = new RegExp(`[${HIDDEN_SET}]`, 'gu')
const HIDDEN_ONE = new RegExp(`[${HIDDEN_SET}]`, 'u')

function isHidden(ch: string): boolean {
  return ch !== ' ' && ch !== '\t' && ch !== '\n' && HIDDEN_ONE.test(ch)
}

function escapeHidden(text: string): string {
  return text.replace(HIDDEN_CHAR, (ch) => {
    if (ch === ' ' || ch === '\t') return ch
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
  const safePath = escapeHidden(displayPath)
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

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

/**
 * For the apply step: is `currentContent` provably the file this proposal's
 * diff was computed against? Compares the hash of the content and then checks
 * the stored old text sits at the stored position. A changed file (by the user
 * elsewhere in it, or by another run's accepted proposal) fails the hash even
 * when the old text still occurs exactly once, which a plain "old text occurs
 * once" re-check cannot tell. Fails closed on anything malformed.
 */
export function editStillMatches(edit: ProposedEdit, currentContent: string): boolean {
  try {
    if (typeof currentContent !== 'string') return false
    if (typeof edit.baseSha256 !== 'string' || edit.baseSha256 !== sha256(currentContent)) return false
    if (!Number.isInteger(edit.matchIndex) || edit.matchIndex < 0) return false
    return currentContent.startsWith(edit.oldText, edit.matchIndex)
  } catch {
    return false
  }
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

export function createEditProposalStore(
  options: { byteBudget?: number } = {}
): EditProposalStore {
  const byteBudget = options.byteBudget ?? EDIT_PENDING_BYTES_BUDGET
  let totalBytes = 0
  const runs = new Map<string, RunState>()
  const finished = new Map<string, { records: EditAuditRecord[]; dropped: number }>()
  /** Ids of finished runs with a package still under review, oldest first. */
  const retained: string[] = []
  let counter = 0

  /** Empty a run's package and give its bytes back. */
  const releaseEntries = (st: RunState): void => {
    for (const e of st.entries) totalBytes -= e.bytes
    st.entries = []
  }

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

  /** One failed attempt on a path: counted and audited. */
  const failPath = (
    st: RunState,
    key: string,
    runId: string,
    stepNumber: number,
    displayPath: string,
    what: Pick<EditAuditRecord, 'outcome' | 'occurrences' | 'reason'>
  ): void => {
    const failedAttempts = (st.failures.get(key) ?? 0) + 1
    st.failures.set(key, failedAttempts)
    record(st, { runId, stepNumber, path: displayPath, failedAttempts, ...what })
  }

  /**
   * Every decision that needs nothing from the file. Returns the refusal, or
   * null when the proposal may go on to the content search. May record and
   * count (it is where the per-path cap lives), so it is the single place both
   * `precheck` (before the file is read) and `propose` go through.
   */
  const admit = (
    runId: string,
    stepNumber: number,
    edit: Pick<ProposedEdit, 'path' | 'oldText' | 'newText'>
  ): ProposeOutcome | null => {
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
      typeof edit.newText !== 'string'
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
    // A lone surrogate would be displayed as <U+D800> but written as U+FFFD:
    // display and stored form must not diverge, and it cannot be written faithfully.
    if (LONE_SURROGATE.test(edit.oldText) || LONE_SURROGATE.test(edit.newText)) {
      return reject('the old or new text contains a lone surrogate, which cannot be written as UTF-8.')
    }

    // A run that has ended adds nothing: a straggler tool call must not
    // grow a package a human is about to review (or revive an abandoned one).
    if (finished.has(runId) || runs.get(runId)?.ended) {
      return reject('this run has already ended; no further proposals are accepted.')
    }

    // A run that holds no package yet waits while too many finished runs are
    // awaiting review: refuse it (every time, not only the first), never drop
    // one of them.
    const existing = runs.get(runId)
    if ((!existing || existing.entries.length === 0) && retained.length >= EDIT_MAX_RETAINED_RUNS) {
      record(stateFor(runId), {
        runId,
        stepNumber,
        path: edit.path,
        outcome: 'rejected-capacity',
        reason: 'retained-run cap'
      })
      return reject(CAPACITY_RUNS)
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
        failedAttempts: failedBefore
      })
      return reject(LIMIT_REACHED)
    }

    // Pending cap: needs nothing from the file, so it is decided HERE, before
    // the search. It counts as a failed attempt so that a full run cannot be
    // used to ask the match question around the per-path cap.
    if (st.entries.length >= EDIT_MAX_PENDING_PER_RUN) {
      failPath(st, key, runId, stepNumber, edit.path, {
        outcome: 'rejected-capacity',
        reason: 'pending cap'
      })
      return reject('too many unresolved proposals in this run.')
    }

    // Byte budget, conservative lower bound (the diff only adds to it): when
    // even path + old + new do not fit, refuse without touching the file.
    const lowerBound =
      Buffer.byteLength(edit.path) + Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText)
    if (totalBytes + lowerBound > byteBudget) {
      record(st, {
        runId,
        stepNumber,
        path: edit.path,
        outcome: 'rejected-capacity',
        reason: 'byte budget (lower bound)'
      })
      return reject(CAPACITY_BYTES)
    }
    return null
  }

  return {
    precheck(runId, stepNumber, edit): ProposeOutcome | null {
      try {
        return admit(runId, stepNumber, edit)
      } catch {
        return reject('the proposal could not be checked.')
      }
    },

    propose(runId, stepNumber, edit, fileContent): ProposeOutcome {
      try {
        // Everything that does not need the file comes first: a decision taken
        // before the file is looked at cannot show anything about it, and must
        // not be reachable only after the content search (that would make the
        // match/no-match bit readable around the per-path cap).
        if (typeof fileContent !== 'string') return reject('the proposal is malformed.')
        const early = admit(runId, stepNumber, edit)
        if (early) return early

        const st = stateFor(runId)
        const key = pathKey(edit.path)
        const failedBefore = st.failures.get(key) ?? 0

        const { count, first } = findUpToTwo(fileContent, edit.oldText)
        if (count !== 1) {
          failPath(st, key, runId, stepNumber, edit.path, {
            outcome: count === 0 ? 'rejected-not-found' : 'rejected-ambiguous',
            occurrences: count
          })
          return reject(NOT_EXACTLY_ONCE)
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
          introducesHiddenCharacters: hidden,
          baseSha256: sha256(fileContent),
          matchIndex: first
        }
        const bytes =
          Buffer.byteLength(stored.path) +
          Buffer.byteLength(stored.oldText) +
          Buffer.byteLength(stored.newText) +
          Buffer.byteLength(stored.diff)
        // Over the budget once the diff exists: unavoidable after reading the
        // file, so it must cost what every other content-dependent refusal costs:
        // the SAME model-visible text and a failed attempt. (The audit keeps the
        // real cause.) Never evict a package that waits for review.
        if (totalBytes + bytes > byteBudget) {
          failPath(st, key, runId, stepNumber, edit.path, {
            outcome: 'rejected-capacity',
            reason: 'byte budget (after the diff)'
          })
          return reject(NOT_EXACTLY_ONCE)
        }
        totalBytes += bytes
        st.entries.push({ bytes, stepNumber, key, edit: stored })
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
      releaseEntries(st)
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
        return
      }
      if (st.entries.length > 0) {
        record(st, { runId, outcome: 'package-abandoned', edits: st.entries.length })
        releaseEntries(st)
      }
      retire(runId, st)
    },

    pendingBytes(): number {
      return totalBytes
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

    // Everything that needs nothing from the file is decided before it is read.
    const realRelEarly = resolved.realRel.split(path.sep).join('/')
    const early = deps.store.precheck(runId, stepNumber, {
      path: realRelEarly,
      oldText,
      newText
    })
    if (early && early.kind === 'rejected') return `Rejected: ${early.reason}`

    const file = await readHeadAndBody(resolved.realTarget)
    if (file.verdict === 'binary') return BINARY
    if (file.verdict === 'large') return TOO_LARGE
    if (file.verdict !== 'ok') return REFUSED
    if (!file.roundTrips) return NOT_UTF8

    // The path as the file system spells it, never the model's spelling: this
    // is what the dialog shows and what the accept step will open.
    const realRel = realRelEarly

    const outcome = deps.store.propose(
      runId,
      stepNumber,
      { path: realRel, oldText, newText },
      file.text
    )
    if (outcome.kind === 'rejected') return `Rejected: ${outcome.reason}`

    // No line counts here: they vary with what surrounds the match (end of file,
    // a following newline, a line start), and the model wrote old and new text
    // itself, so the only thing counts would add is that context. The counts
    // live in the stored proposal and the audit, for the human.
    return (
      'Proposed. Nothing was written and the file is unchanged. The change is applied ' +
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
        '`old` must occur EXACTLY ONCE in the file, otherwise the proposal is rejected; include ' +
        'enough surrounding text to make it unique. At most one pending proposal per file: ' +
        'combine all changes to a file into one call. `path` is relative to the project root.',
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
