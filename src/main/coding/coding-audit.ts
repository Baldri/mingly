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
 *     The audit entry types have no free-text field at all.
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
import { DEFAULT_POLICY } from '../policy/policy-engine'

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
  guardBlocked: boolean
}

/** What a blocked guard records: where and under whom, never why (a reason can quote the content). */
export interface CodingGuardBlockedDetails {
  projectPath: string
  provider: string
  model: string
  policyVersion: string
}

export interface CodingUndoDetails {
  projectPath: string
  restored: readonly string[]
  skipped: ReadonlyArray<{ path: string; reason: string }>
  interrupted: boolean
}

/** A path is kept up to this length; beyond it the entry says it was cut. */
const MAX_PATH_CHARS = 1024
const TRUNCATED = '…[truncated]'
/** Provider id, model id, policy version: a name, not text. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const REASON = /^[a-z][a-z-]{0,39}$/

function name(value: unknown): string {
  return typeof value === 'string' && NAME.test(value) ? value : UNKNOWN
}

function path(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN
  return value.length > MAX_PATH_CHARS ? value.slice(0, MAX_PATH_CHARS) + TRUNCATED : value
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

function changeDetails(d: CodingAuditDetails): CodingAuditDetails {
  return {
    projectPath: path(d?.projectPath),
    filePath: path(d?.filePath),
    addedLines: count(d?.addedLines),
    removedLines: count(d?.removedLines),
    provider: name(d?.provider),
    model: name(d?.model),
    policyVersion: name(d?.policyVersion),
    guardRedirected: flag(d?.guardRedirected),
    guardBlocked: flag(d?.guardBlocked)
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
      projectPath: path(details?.projectPath),
      provider: name(details?.provider),
      model: name(details?.model),
      policyVersion: name(details?.policyVersion),
      guardBlocked: true
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
      projectPath: path(details?.projectPath),
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
export function resolveRunAuditContext(runId: string): RunAuditContext {
  return getRunAuditContext(runId) ?? { provider: UNKNOWN, model: UNKNOWN, guardRedirected: true, guardBlocked: true }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Stable: a compliance officer's spreadsheet and scripts depend on this order. */
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
  'restoredCount',
  'skippedCount',
  'interrupted',
  'skippedReasons',
  'note'
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
 * carriage return are white space and covered by the same test. Quoting follows
 * RFC 4180.
 */
function cell(value: unknown): string {
  let text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
  if (text.length > MAX_CELL_CHARS) text = text.slice(0, MAX_PATH_CHARS) + TRUNCATED
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
    d.restoredCount,
    d.skippedCount,
    d.interrupted,
    reasonsCell(d.skippedReasons),
    ''
  ])
}

function truncationRow(note: string): string {
  const cells: unknown[] = CODING_AUDIT_COLUMNS.map(() => '')
  cells[CODING_AUDIT_COLUMNS.indexOf('createdAt')] = new Date().toISOString()
  cells[CODING_AUDIT_COLUMNS.indexOf('action')] = 'export.truncated'
  cells[CODING_AUDIT_COLUMNS.indexOf('note')] = note
  return line(cells)
}

function parseSince(since: unknown): string | undefined {
  if (since === undefined || since === null) return undefined
  const time = typeof since === 'string' ? Date.parse(since) : Number.NaN
  // A filter that cannot be read is refused: ignoring it would widen the export
  // beyond what was asked for.
  if (!Number.isFinite(time)) throw new Error('Invalid "since": expected an ISO 8601 date')
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
  const chronological = found.slice(0, limit).reverse()

  let out = line(CODING_AUDIT_COLUMNS)
  let bytes = Buffer.byteLength(out, 'utf8')
  let cutBySize = false
  let written = 0
  for (const entry of chronological) {
    const row = rowFor(entry)
    const size = Buffer.byteLength(row, 'utf8')
    if (bytes + size + TRUNCATION_RESERVE > CODING_EXPORT_MAX_BYTES) {
      cutBySize = true
      break
    }
    out += row
    bytes += size
    written++
  }
  if (cutBySize) {
    out += truncationRow(`Export stopped at the size limit of ${CODING_EXPORT_MAX_BYTES} bytes after ${written} of ${chronological.length} rows`)
  } else if (cutByRows) {
    out += truncationRow(`Export stopped at the row limit of ${limit}; older entries exist`)
  }
  return out
}
