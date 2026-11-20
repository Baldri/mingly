/**
 * The audit trail of the coding mode: what was applied to a project, under
 * which model and policy, and what the guard did on the way. It is the document
 * a regulated customer hands to a compliance officer, so two properties carry
 * everything else:
 *
 *  1. An entry never holds file content or a found value. An audit log that
 *     records the secret it exists to protect against is itself the leak. This
 *     is enforced by CONSTRUCTION, not by discipline: every entry is rebuilt
 *     here from a fixed list of fields, each reduced to the one thing it may
 *     hold (a bounded path, a number, a flag, or a name that matches a strict
 *     pattern). An object that carries more (`content`, `diff`, `oldText`) loses
 *     the extra fields; a name field that holds text is replaced by a marker.
 *
 *     There is exactly ONE free-text field: the reason a human typed when
 *     refusing a proposal (`note` on a `coding.change_rejected` entry). It is
 *     the user's own words about their own decision — not file content, not
 *     model output — and the dialog that collects it says it is kept here, so
 *     the field has to exist for that sentence to be true. It is stripped of
 *     hidden characters and bounded like every other cell. Nothing else may
 *     become free text: a reason that could quote what the guard found would
 *     put the finding into the trail.
 *
 *  2. The export is safe to open in a spreadsheet and bounded as a whole. Paths
 *     come from a model and a file system: they are untrusted input crossing
 *     into somebody else's spreadsheet, so a cell that would execute is
 *     neutralised, and the output has a total size limit that says so when it
 *     cuts.
 *
 * Every decision here fails closed: what cannot be vouched for is recorded as
 * UNKNOWN (names), as the stricter side (flags), or refused (an export filter).
 */

import { getActivityLogger } from '../audit/activity-logger'
import * as nodePath from 'path'
import { DEFAULT_POLICY } from '../policy/policy-engine'
import { stripHiddenCharacters } from './edit-proposals'

/** The marker for a value that could not be vouched for. Never a guess. */
export const UNKNOWN = 'unknown'

/** Entity type of every entry written here: the run the change belongs to. */
const ENTITY_TYPE = 'coding_run'
const ACTOR_USER = { actorType: 'user', actorId: 'local' } as const
const ACTOR_GUARD = { actorType: 'system', actorId: 'guard' } as const

// ---------------------------------------------------------------------------
// What an entry may hold
// ---------------------------------------------------------------------------

export interface CodingAuditDetails {
  projectPath: string
  filePath: string
  addedLines: number
  removedLines: number
  provider: string
  model: string
  policyVersion: string
  guardRedirected: boolean
  /**
   * NOT stored on a change entry. A run whose guard blocked ends abandoned and
   * is never applied, so `true` on an applied-change row could only ever mean
   * "the run context was lost", which a reader would misread as "the guard
   * blocked something". The row records `runContextKnown` instead; the block
   * itself is the separate `coding.guard_blocked` entry.
   */
  guardBlocked: boolean
  /** Whether provider, model and guard outcome come from the run's own record. Absent means no. */
  runContextKnown?: boolean
}

/**
 * What a REFUSED proposal records: the same shape as an applied change, plus
 * the reason the user typed.
 *
 * The rows a compliance officer actually asks about are these: what the agent
 * proposed and the human did not allow. `projectPath` is optional because the
 * reject channel is given a run id and a reason and nothing else — a project
 * it cannot vouch for is recorded as UNKNOWN, never guessed.
 */
export interface CodingRejectedDetails {
  projectPath?: string
  filePath: string
  addedLines: number
  removedLines: number
  provider: string
  model: string
  policyVersion: string
  /** Whether provider and model come from the run's own record. Absent means no. */
  runContextKnown?: boolean
  /** The user's own words. The ONE free-text field in this trail (see the header). */
  reason?: string
}

/** What a blocked guard records: where and under whom, never why (a reason can quote the content). */
export interface CodingGuardBlockedDetails {
  projectPath: string
  provider: string
  model: string
  policyVersion: string
}

/**
 * What a FLAGGED guard records: the sanitizer changed a tool result and did not
 * block it, so the provider received the original bytes.
 *
 * `types` are the sanitizer's own warning types — names from a fixed set, not
 * text, and never the value it found. The difference from
 * CodingGuardBlockedDetails is deliberate: that one ends a run, this one records
 * that a run went on with content a cleaner version existed of.
 */
export interface CodingGuardFlaggedDetails {
  projectPath: string
  provider: string
  model: string
  policyVersion: string
  types: readonly string[]
}

export interface CodingUndoDetails {
  projectPath: string
  restored: readonly string[]
  skipped: ReadonlyArray<{ path: string; reason: string }>
  interrupted: boolean
}

/** A path is kept up to this length; beyond it the entry says it was cut. */
const MAX_PATH_CHARS = 1024
/**
 * The user's refusal reason, in characters. The same bound the proposal store
 * and the dialog's input field use, so the three agree on what is kept.
 */
const MAX_REASON_CHARS = 500
const TRUNCATED = '…[truncated]'
/** Provider id, model id, policy version: a name, not text. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const REASON = /^[a-z][a-z-]{0,39}$/

function name(value: unknown): string {
  return typeof value === 'string' && NAME.test(value) ? value : UNKNOWN
}

function clip(text: string): string {
  const clean = stripHiddenCharacters(text)
  return clean.length > MAX_PATH_CHARS ? clean.slice(0, MAX_PATH_CHARS) + TRUNCATED : clean
}

/** The project root: an absolute path. Anything else is not what the callers hold, so it is UNKNOWN. */
function projectRoot(value: unknown): string {
  return typeof value === 'string' && nodePath.isAbsolute(value) ? clip(value) : UNKNOWN
}

/** A file inside the project: relative, normalised, never leaving it. Free text does not qualify. */
function projectFile(value: unknown): string {
  if (typeof value !== 'string' || value === '') return UNKNOWN
  const posix = nodePath.posix
  if (posix.isAbsolute(value) || nodePath.isAbsolute(value)) return UNKNOWN
  if (posix.normalize(value) !== value || value === '..' || value.startsWith('../')) return UNKNOWN
  return clip(value)
}

/**
 * The one free-text field: hidden and direction-changing characters out,
 * bounded. Anything that is not a string is no reason at all (empty), never a
 * stringified object.
 */
function reasonText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return stripHiddenCharacters(value).slice(0, MAX_REASON_CHARS)
}

/** Types kept on one flagged entry; the sanitizer has eight, so this bounds it. */
const MAX_FLAGGED_TYPES = 8

/**
 * A fixed list of names, deduplicated, sorted and bounded. Each entry goes
 * through `name`, so anything that is not a name becomes UNKNOWN rather than
 * free text — a "type" that could carry the finding would put the finding into
 * the trail. Sorted so the exported cell does not depend on detection order.
 */
function typeList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const kept: string[] = []
  for (const entry of value) {
    const type = name(entry)
    if (!kept.includes(type)) kept.push(type)
    if (kept.length >= MAX_FLAGGED_TYPES) break
  }
  return kept.sort()
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** A flag that is not a boolean takes the stricter side: assume the guard acted. */
function flag(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true
}

/** The policy version in force, from the policy layer; a value that is not a version is UNKNOWN. */
export function currentPolicyVersion(): string {
  return name(DEFAULT_POLICY?.version)
}

type StoredChange = Omit<CodingAuditDetails, 'guardBlocked'> & { runContextKnown: boolean }

function changeDetails(d: CodingAuditDetails): StoredChange {
  return {
    projectPath: projectRoot(d?.projectPath),
    filePath: projectFile(d?.filePath),
    addedLines: count(d?.addedLines),
    removedLines: count(d?.removedLines),
    provider: name(d?.provider),
    model: name(d?.model),
    policyVersion: name(d?.policyVersion),
    guardRedirected: flag(d?.guardRedirected),
    // guardBlocked is deliberately not copied (see CodingAuditDetails).
    runContextKnown: d?.runContextKnown === true
  }
}

// ---------------------------------------------------------------------------
// Writing entries
// ---------------------------------------------------------------------------

/** One entry per change that was applied to a file. */
export function logCodingChange(runId: string, details: CodingAuditDetails): void {
  getActivityLogger().log({
    ...ACTOR_USER,
    action: 'coding.change_applied',
    entityType: ENTITY_TYPE,
    entityId: runId,
    details: { ...changeDetails(details) }
  })
}

/**
 * One entry per proposal a human refused, carrying the reason they typed.
 *
 * Written for the whole package at once (one entry per file), so the export
 * shows which changes were proposed and not allowed — the half of the
 * compliance claim that is hard to make any other way. The run id links these
 * rows to the applied rows of the same run.
 */
export function logCodingChangeRejected(runId: string, details: CodingRejectedDetails): void {
  getActivityLogger().log({
    ...ACTOR_USER,
    action: 'coding.change_rejected',
    entityType: ENTITY_TYPE,
    entityId: runId,
    details: {
      projectPath: projectRoot(details?.projectPath),
      filePath: projectFile(details?.filePath),
      addedLines: count(details?.addedLines),
      removedLines: count(details?.removedLines),
      provider: name(details?.provider),
      model: name(details?.model),
      policyVersion: name(details?.policyVersion),
      runContextKnown: details?.runContextKnown === true,
      note: reasonText(details?.reason)
    }
  })
}

/**
 * The guard stopped a run's content from going on. Its own action, apart from
 * `coding.change_applied`: a change that was applied in a run whose guard
 * blocked at some point stays an applied change in an export that filters on
 * that action, and carries the flag.
 */
export function logCodingGuardBlocked(runId: string, details: CodingGuardBlockedDetails): void {
  getActivityLogger().log({
    ...ACTOR_GUARD,
    action: 'coding.guard_blocked',
    entityType: ENTITY_TYPE,
    entityId: runId,
    details: {
      projectPath: projectRoot(details?.projectPath),
      provider: name(details?.provider),
      model: name(details?.model),
      policyVersion: name(details?.policyVersion),
      guardBlocked: true
    }
  })
}

/**
 * The sanitizer changed a tool result and the run went on with the original.
 *
 * Why this entry exists at all: the sanitizer is the same DETECTOR on the chat
 * path and on the agent loop, but not the same TREATMENT. Chat sends the
 * cleaned text; a tool result is forwarded byte-for-byte, because
 * mingly_edit_file matches its `oldText` against the REAL file and a proposal
 * built from normalised text would be refused as "not found". Forwarding the
 * cleaned text instead would break the edit tool, and lowering the block
 * threshold would make every file with a BOM or a zero-width space unreadable.
 * So the asymmetry stays — and this row is what turns it from silent into
 * provable. One row per guard pass that found something, which is the same unit
 * `coding.guard_blocked` records.
 *
 * Never the found value, never the content: only that it happened, which types,
 * and in which run.
 */
export function logCodingGuardFlagged(runId: string, details: CodingGuardFlaggedDetails): void {
  getActivityLogger().log({
    ...ACTOR_GUARD,
    action: 'coding.guard_flagged',
    entityType: ENTITY_TYPE,
    entityId: runId,
    details: {
      projectPath: projectRoot(details?.projectPath),
      provider: name(details?.provider),
      model: name(details?.model),
      policyVersion: name(details?.policyVersion),
      // Stated rather than left empty: an export filtered on guardBlocked must
      // not read this row as "the guard stopped the run", because it did not.
      guardBlocked: false,
      flaggedTypes: typeList(details?.types)
    }
  })
}

/** An undo finished: how many files went back, how many were left alone and why (codes, not text). */
export function logCodingRunUndone(runId: string, details: CodingUndoDetails): void {
  const reasons: Record<string, number> = {}
  const skipped = Array.isArray(details?.skipped) ? details.skipped : []
  for (const s of skipped) {
    const reason = typeof s?.reason === 'string' && REASON.test(s.reason) ? s.reason : UNKNOWN
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  getActivityLogger().log({
    ...ACTOR_USER,
    action: 'coding.run_undone',
    entityType: ENTITY_TYPE,
    entityId: runId,
    details: {
      projectPath: projectRoot(details?.projectPath),
      restoredCount: Array.isArray(details?.restored) ? details.restored.length : 0,
      skippedCount: skipped.length,
      interrupted: flag(details?.interrupted),
      skippedReasons: reasons
    }
  })
}

// ---------------------------------------------------------------------------
// What the run knew while it ran
// ---------------------------------------------------------------------------
//
// The apply happens after the run, in another call, and knows neither the model
// nor what the guard did. The executor records both here as the run goes. In
// memory like the proposals the apply works on: they die together, so an apply
// can never meet a missing record unless the executor failed to write it.
//
// DEBT: in memory, a run recorded 1000 runs ago is forgotten -> persist next to
// the snapshot ledger when an apply after a restart becomes possible.

export interface RunAuditContext {
  provider: string
  model: string
  guardRedirected: boolean
  guardBlocked: boolean
}

export const RUN_AUDIT_CONTEXT_MAX = 1000

const runContexts = new Map<string, RunAuditContext>()

/** The first record of a run wins: a later call cannot rewrite which model acted. */
export function recordRunAuditContext(runId: string, ctx: { provider: string; model: string }): void {
  if (typeof runId !== 'string' || runId === '' || runContexts.has(runId)) return
  runContexts.set(runId, {
    provider: name(ctx?.provider),
    model: name(ctx?.model),
    guardRedirected: false,
    guardBlocked: false
  })
  while (runContexts.size > RUN_AUDIT_CONTEXT_MAX) {
    const oldest = runContexts.keys().next().value
    if (oldest === undefined) break
    runContexts.delete(oldest)
  }
}

/** The guard withheld or anonymised content of this run. Only ever moves towards true. */
export function markGuardRedirected(runId: string): void {
  const ctx = runContexts.get(runId)
  if (ctx) ctx.guardRedirected = true
}

/** The guard ended this run. Only ever moves towards true. */
export function markGuardBlocked(runId: string): void {
  const ctx = runContexts.get(runId)
  if (ctx) ctx.guardBlocked = true
}

export function getRunAuditContext(runId: string): RunAuditContext | undefined {
  const ctx = runContexts.get(runId)
  return ctx ? { ...ctx } : undefined
}

/**
 * The context an entry is written with. A run nobody recorded gets UNKNOWN
 * names and the guard assumed to have acted: a reviewer looks at it, instead of
 * reading an invented "clean" record.
 */
export function resolveRunAuditContext(runId: string): RunAuditContext & { known: boolean } {
  const ctx = getRunAuditContext(runId)
  return ctx
    ? { ...ctx, known: true }
    : { provider: UNKNOWN, model: UNKNOWN, guardRedirected: true, guardBlocked: true, known: false }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Stable: a compliance officer's spreadsheet and scripts depend on this order.
 *
 * `note` carries the user's refusal reason on a `coding.change_rejected` row
 * and the explanation on an `export.truncated` row; the `action` column says
 * which. Every other column is a path, a number, a flag or a name.
 *
 * A new column is APPENDED, never inserted: every column before it keeps the
 * index a reader's script already uses, so an added one can only ever show up
 * as an extra field at the end. `flaggedTypes` was added that way.
 */
export const CODING_AUDIT_COLUMNS = [
  'id',
  'createdAt',
  'action',
  'runId',
  'projectPath',
  'filePath',
  'addedLines',
  'removedLines',
  'provider',
  'model',
  'policyVersion',
  'guardRedirected',
  'guardBlocked',
  'runContextKnown',
  'restoredCount',
  'skippedCount',
  'interrupted',
  'skippedReasons',
  'note',
  /** Sanitizer warning types of a `coding.guard_flagged` row; names, not text. */
  'flaggedTypes'
] as const

/** The whole export, in bytes. A row limit alone does not bound it. */
export const CODING_EXPORT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_LIMIT = 1000
const MAX_LIMIT = 10000
/** Room kept for the closing truncation row. */
const TRUNCATION_RESERVE = 512
/** One cell, whoever wrote it: entries in the table may predate this module. */
const MAX_CELL_CHARS = MAX_PATH_CHARS + TRUNCATED.length

/**
 * One cell, ready for the file. A cell that starts (after white space) with
 * `=`, `+`, `-` or `@` is executable in Excel and LibreOffice: it gets a
 * leading apostrophe, which marks it as text and keeps it readable. Tab and
 * carriage return are replaced by spaces first (hidden characters) and the
 * leading-white-space test covers what remains. Quoting follows
 * RFC 4180.
 */
function cell(value: unknown): string {
  let text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
  if (text.length > MAX_CELL_CHARS) text = text.slice(0, MAX_PATH_CHARS) + TRUNCATED
  // Whoever wrote the row: hidden and direction-changing characters never reach the file.
  text = stripHiddenCharacters(text)
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

function line(cells: readonly unknown[]): string {
  return cells.map(cell).join(',') + '\r\n'
}

function reasonsCell(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const parts: string[] = []
  for (const [reason, n] of Object.entries(value as Record<string, unknown>)) {
    parts.push(`${REASON.test(reason) ? reason : UNKNOWN}:${typeof n === 'number' && Number.isSafeInteger(n) ? n : 0}`)
  }
  return parts.join(';')
}

function rowFor(entry: {
  id: string
  createdAt: string
  action: string
  entityId: string
  details: Record<string, unknown> | null
}): string {
  const d = entry.details ?? {}
  return line([
    entry.id,
    entry.createdAt,
    entry.action,
    entry.entityId,
    d.projectPath,
    d.filePath,
    d.addedLines,
    d.removedLines,
    d.provider,
    d.model,
    d.policyVersion,
    d.guardRedirected,
    d.guardBlocked,
    d.runContextKnown,
    d.restoredCount,
    d.skippedCount,
    d.interrupted,
    reasonsCell(d.skippedReasons),
    // The only free-text cell: a refusal reason the user typed, or the note of
    // an export.truncated row. `cell` neutralises and bounds it like any other.
    d.note,
    // Joined here rather than in `cell`: a list is not a value `cell` knows,
    // and it would silently become an empty string.
    Array.isArray(d.flaggedTypes) ? d.flaggedTypes.join(';') : ''
  ])
}

function truncationRow(note: string): string {
  const cells: unknown[] = CODING_AUDIT_COLUMNS.map(() => '')
  cells[CODING_AUDIT_COLUMNS.indexOf('createdAt')] = new Date().toISOString()
  cells[CODING_AUDIT_COLUMNS.indexOf('action')] = 'export.truncated'
  cells[CODING_AUDIT_COLUMNS.indexOf('note')] = note
  return line(cells)
}

/** Strict ISO 8601: a date, optionally with a time and an offset. Free text is not a date. */
const ISO_SINCE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/

function parseSince(since: unknown): string | undefined {
  if (since === undefined || since === null) return undefined
  const match = typeof since === 'string' ? ISO_SINCE.exec(since) : null
  // A filter that cannot be read is refused: ignoring it, or reading "5" as a
  // year, would hand over a range nobody asked for.
  const refuse = (): never => {
    throw new Error('Invalid "since": expected an ISO 8601 date, e.g. 2026-11-18 or 2026-11-18T09:00:00Z')
  }
  if (!match) return refuse()
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const calendar = new Date(Date.UTC(year, month - 1, day))
  // "2026-02-31" parses to 3 March; a date that does not exist is refused.
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return refuse()
  }
  const time = Date.parse(since as string)
  if (!Number.isFinite(time)) return refuse()
  return new Date(time).toISOString()
}

function parseLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return DEFAULT_LIMIT
  return Math.min(limit, MAX_LIMIT)
}

/**
 * The coding audit entries as CSV, oldest first, with a header row. At most
 * `limit` rows (newest kept) and at most CODING_EXPORT_MAX_BYTES; a cut by
 * either bound ends in an `export.truncated` row that names it, so a short
 * export never passes for a complete one.
 */
export function exportCodingAudit(filter: { since?: string; limit?: number }): string {
  const since = parseSince(filter?.since)
  const limit = parseLimit(filter?.limit)
  // One more than asked for, to know whether the limit cut anything.
  const found = getActivityLogger().query({ entityType: ENTITY_TYPE, since, limit: limit + 1 })
  const cutByRows = found.length > limit

  // Both bounds drop the OLDEST entries. `found` is newest first; take rows from
  // the front under the byte bound, then put what was kept in chronological
  // order. An auditor asking about recent activity must never receive old
  // activity in its place.
  const header = line(CODING_AUDIT_COLUMNS)
  let bytes = Buffer.byteLength(header, 'utf8')
  const kept: string[] = []
  let cutBySize = false
  for (const entry of found.slice(0, limit)) {
    const row = rowFor(entry)
    const size = Buffer.byteLength(row, 'utf8')
    if (bytes + size + TRUNCATION_RESERVE > CODING_EXPORT_MAX_BYTES) {
      cutBySize = true
      break
    }
    kept.push(row)
    bytes += size
  }
  kept.reverse()

  // The marker comes first: it describes entries BEFORE the first row shown.
  let out = header
  if (cutBySize) {
    out += truncationRow(
      `Incomplete: size limit of ${CODING_EXPORT_MAX_BYTES} bytes reached. The ${kept.length} newest entries are shown; ` +
        `all older entries${cutByRows ? ' (and those beyond the row limit)' : ''} are missing`
    )
  } else if (cutByRows) {
    out += truncationRow(`Incomplete: row limit of ${limit} reached. The ${kept.length} newest entries are shown; all older entries are missing`)
  }
  return out + kept.join('')
}
