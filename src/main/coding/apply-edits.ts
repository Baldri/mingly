/**
 * Applying an accepted edit package: snapshot, atomic write, undo.
 *
 * The only code in the coding mode that writes to a user's files. What it
 * promises is reversibility and approval, so every decision here fails closed:
 * when anything is uncertain, NOTHING is written. A half-applied package is
 * worse than a refusal, because the user cannot tell what state the files are
 * in.
 *
 * The order, and why it is fixed:
 *
 *   1. grant (read + edit) and mode, looked up again NOW. Acceptance and write
 *      are separated by any amount of time.
 *   2. everything that needs no file content: the pending package, the path
 *      discipline for EVERY file (blocklist on the path as given, containment,
 *      blocklist again on the resolved path), duplicates, the workspace.
 *   3. pass 1, per file: open, verify with `editStillMatches` (R67: the hash
 *      proves the file is the one the human's diff was computed against, which
 *      a re-count of the old text cannot), copy to the snapshot. Nothing in the
 *      project has been touched yet; a failure here removes the snapshot batch
 *      and refuses.
 *   4. pass 2, ONE FILE AT A TIME (R69): resolve the path again, open it, check
 *      again against the hash recorded in pass 1, write, next file. A change
 *      that lands after file 1 was written refuses file 2 and file 1 is rolled
 *      back from the snapshot.
 *
 * Writes go to a temp file in the target's own directory and are renamed over
 * the target. The verified file descriptor stays open for the whole check, and
 * right before the rename the path must still be the same inode (dev + ino)
 * the descriptor refers to (R69 condition 3: no second, unchecked open of the
 * path between check and write). Rename never follows a link at the final
 * component, it replaces it.
 *
 * Residual window, stated rather than hidden: Node has no `renameat`, so the
 * rename itself is by path. Between the identity check and the rename a
 * directory component could still be swapped. The check is repeated as late as
 * possible and the directory is re-resolved on both sides of the temp file.
 * DEBT: rename by path, window of one syscall pair -> a native renameat or
 * a directory descriptor API in Electron's Node.
 *
 * Refusals that depend on the file system share ONE text, so a refusal is not
 * an existence oracle; the ones that depend only on the caller's own input or
 * on the grant and mode may differ.
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { CODING_MODE_ORDER, parseCodingMode, type CodingMode } from '../../shared/coding-types'
import { hasPermission, type AllowedDirectory } from '../../shared/file-access-types'
import { atLeast } from '../policy/policy-types'
import { resolveRealPath } from '../file-access/real-path-guard'
import { editStillMatches, getEditProposalStore, packageDigest, type EditProposalStore } from './edit-proposals'
import { isProbablyBinary } from './path-policy'
import { resolveReadableFile, defaultReadToolDeps, type Scope } from './read-tools'
import { ensureProjectWorkspace, type ProjectWorkspace } from './project-workspace'
import { writeFileAtomic, ContentChanged } from './atomic-write'
import { getSnapshotLedger, type SnapshotLedger } from './snapshot-ledger'
import { getRunDirectoryRegistry, type RunDirectoryRegistry } from './run-directories'
import { currentPolicyVersion, logCodingChange, logCodingRunUndone, resolveRunAuditContext } from './coding-audit'
import type { ProposedEdit } from '../../shared/coding-types'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Same ceiling the read and edit tools use: a file above it was never proposed. */
const APPLY_FILE_MAX_BYTES = 2 * 1024 * 1024
/**
 * Total bytes one apply may copy into the snapshot. Bounds the PRODUCT of
 * (files in the package x file size): the per-file cap alone would allow
 * 200 x 2 MiB.
 */
export const APPLY_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
/** Snapshot batches one run may hold; also the most undo will walk. */
const MAX_BATCHES = 100
/** Entries one manifest may list. */
const MAX_MANIFEST_ENTRIES = 1000
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024
const MANIFEST_NAME = 'manifest.json'
/**
 * Written into the batch before the first project file is renamed, removed
 * after the last (or after a complete rollback). Its presence later means an
 * apply was interrupted or left a partial state. Informational: the ledger, not
 * this file, decides what may be restored.
 */
const MARKER_NAME = 'IN-PROGRESS'
const STALE_TEMP = /^\.mingly-tmp-[0-9a-f]{16}$/
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/
const BATCH_NAME = /^batch-(\d{1,9})$/
const SNAPSHOT_FILE = /^\d{1,6}\.bak$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const WORKSPACE_DIR = '.mingly'

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0

export { writeFileAtomic, type AtomicWriteOptions } from './atomic-write'

// ---------------------------------------------------------------------------
// Outcomes and reasons
// ---------------------------------------------------------------------------

export type ApplyOutcome =
  | { kind: 'applied'; paths: string[]; edits: ProposedEdit[] }
  | { kind: 'refused'; reason: string }

/** Why a file was left alone by undo. */
export type SkipReason =
  | 'changed-since-apply'
  | 'snapshot-damaged'
  | 'path-not-allowed'
  | 'unreadable'
  | 'write-failed'
  /** An interrupted apply never wrote this file (it still holds its old content). */
  | 'not-written-interrupted'
  /** Batch level: this app has no row for the batch. */
  | 'batch-not-recorded'
  /** Batch level: the manifest on disk is not the one that was recorded. */
  | 'batch-manifest-changed'
  /** Batch level: recorded, but the manifest is gone. */
  | 'batch-manifest-missing'
  /** Batch level: recorded and unchanged, but it does not parse. */
  | 'batch-manifest-invalid'

export interface SkippedFile {
  path: string
  reason: SkipReason
}

/**
 * Undo reports BOTH groups. A file that was changed after the apply is left
 * alone (later work is never overwritten), and it must not vanish from the
 * answer: a partial undo that looks complete is the one impression a safety
 * net must never give.
 */
export interface UndoResult {
  restored: string[]
  skipped: SkippedFile[]
  /** Present (true) only when an apply of this run was interrupted or left a partial state. */
  interrupted?: true
}

export type UndoOutcome =
  | ({ kind: 'restored' } & UndoResult)
  | { kind: 'refused'; reason: string; skipped?: SkippedFile[] }

export type RejectOutcome =
  | { kind: 'rejected'; count: number }
  | { kind: 'refused'; reason: string }

/** The one text for everything that depends on the file system. */
const REFUSE_FS =
  'Nothing was written: a file could not be verified as unchanged since it was proposed. ' +
  'Review the proposal again.'
const REFUSE_GRANT =
  'Nothing was written: the directory grant or the coding mode no longer allows edits.'
const REFUSE_NOTHING = 'Nothing was written: there is nothing pending for this run.'
const REFUSE_INPUT = 'Nothing was done: the request is not a valid run and directory.'
const REFUSE_RUN_DIRECTORY =
  'Nothing was done: this run is not known to belong to that directory. The request and the ' +
  'main process disagree about which project the run worked on.'
const REFUSE_WORKSPACE = 'Nothing was written: the project workspace does not belong to this grant.'
const REFUSE_SNAPSHOT =
  'Nothing was written: the snapshot could not be made, and no file is changed without one.'
const REFUSE_NO_SNAPSHOT =
  'Nothing was restored: there is no snapshot for this run in this directory.'
const REFUSE_UNRECORDED =
  'Nothing was restored: this snapshot has no record in this app (it was not created here, its ' +
  'manifest was changed afterwards, or the record is gone). It will not be restored.'
const REFUSE_WITHDRAWN =
  'Permission was withdrawn while the package was being applied. Files already written cannot be ' +
  'restored without permission and stay applied; restore the grant and run undo for this run.'
const REFUSE_MIXED =
  'Nothing was restored: the files of the recorded snapshot were changed after the apply, and other ' +
  'batches of this run have no valid record. See the list for each.'
const REFUSE_BATCH_UNUSABLE =
  'Nothing was restored: the snapshot batches of this run are missing or unreadable.'
const REFUSE_INTERRUPTED =
  'Nothing was written: an earlier apply of this run was interrupted and may have left some files ' +
  'written and others not. Stale temporary files were removed. Run undo for this run first; it ' +
  'reports which files were written.'
const REFUSE_PACKAGE_CHANGED =
  'Nothing was written: the proposals changed after they were shown and must be reviewed again.'
const REFUSE_BUSY = 'Nothing was written: another apply or undo is running for this project.'
const REFUSE_PARTIAL =
  'A write failed after other files were already written, and not every file could be restored. ' +
  'Run undo for this run to restore what the snapshot still allows.'

function refused(reason: string): { kind: 'refused'; reason: string } {
  return { kind: 'refused', reason }
}

/** The grant or the mode no longer allows the write that was about to happen. */
class AuthorityLost extends Error {
  constructor(readonly grantGone: boolean) {
    super('authority lost')
  }
}

/** Thrown inside the apply and mapped to one refusal at the boundary. */
class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ApplyHooks {
  /** After file `index` was opened and verified, before it is written. Test seam. */
  afterVerify?(index: number): void | Promise<void>
  /** After file `index` was written. Test seam. */
  afterWrite?(index: number): void | Promise<void>
}

export interface ApplyDeps {
  store: Pick<EditProposalStore, 'pending' | 'resolve' | 'resolveApplied'>
  findGrant(directoryId: string): Promise<AllowedDirectory | undefined>
  getMode(directoryId: string): CodingMode | Promise<CodingMode>
  /** Which directory each run started in; the handlers validate the renderer's claim against it. */
  runDirectories: Pick<RunDirectoryRegistry, 'get'>
  /** Batches this app created, kept outside the project (see snapshot-ledger.ts). */
  ledger: SnapshotLedger
  /** Overrides APPLY_MAX_SNAPSHOT_BYTES. */
  maxSnapshotBytes?: number
  hooks?: ApplyHooks
}

/** Loaded lazily: the mode store pulls in electron. */
let modeStoreModule: Promise<typeof import('./coding-mode-store')> | undefined

export function defaultApplyDeps(): ApplyDeps {
  return {
    store: getEditProposalStore(),
    runDirectories: getRunDirectoryRegistry(),
    ledger: getSnapshotLedger(),
    findGrant: (id) => defaultReadToolDeps.findGrant(id),
    async getMode(id) {
      modeStoreModule ??= import('./coding-mode-store')
      const { getCodingModeStore } = await modeStoreModule
      return getCodingModeStore().getMode(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf-8') : data).digest('hex')
}

/** One project is touched by one apply or undo at a time. */
const busyProjects = new Set<string>()

function pathKey(p: string): string {
  return p.normalize('NFKC').toLowerCase()
}

/** True for `.mingly` and everything below it, spelled any way the folding sees. */
function isInsideWorkspace(realRelPosix: string): boolean {
  const first = realRelPosix.split('/')[0] ?? ''
  return pathKey(first) === WORKSPACE_DIR
}

function permitsEdit(grant: AllowedDirectory | undefined): grant is AllowedDirectory {
  return !!grant && hasPermission(grant, 'read') && hasPermission(grant, 'edit')
}

/**
 * Bytes of a regular, single-link file through an open descriptor, or null.
 * The descriptor is closed unless `keep` asks otherwise and the read succeeded.
 */
interface OpenedFile {
  handle: fs.promises.FileHandle
  data: Buffer
  dev: number
  ino: number
}

async function openAndRead(
  realTarget: string,
  budget?: { remaining: number }
): Promise<OpenedFile | null> {
  let handle: fs.promises.FileHandle | undefined
  try {
    // O_NOFOLLOW: the final component was resolved a moment ago; if it has been
    // swapped for a link since, the open fails instead of following it.
    handle = await fs.promises.open(realTarget, fs.constants.O_RDONLY | O_NOFOLLOW)
    const stat = await handle.stat()
    // nlink > 1: a rename would break the link and leave the other name on the
    // old content; two names for one file also defeat a per-name identity.
    if (!stat.isFile() || stat.nlink !== 1) throw new Refusal(REFUSE_FS)
    if (stat.size > APPLY_FILE_MAX_BYTES) throw new Refusal(REFUSE_FS)
    if (budget && stat.size > budget.remaining) throw new Refusal(REFUSE_FS)

    const buffer = Buffer.alloc(stat.size)
    let position = 0
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, position, stat.size - position, position)
      if (bytesRead === 0) break
      position += bytesRead
    }
    if (position !== stat.size) throw new Refusal(REFUSE_FS)
    if (budget) budget.remaining -= stat.size
    return { handle, data: buffer, dev: stat.dev, ino: stat.ino }
  } catch {
    await handle?.close().catch(() => undefined)
    return null
  }
}

interface VerifiedFile extends OpenedFile {
  realTarget: string
  realRelPosix: string
  text: string
}

/**
 * Path discipline (one implementation, shared with the read and edit tools),
 * the workspace exclusion, then the content checks. Null on anything doubtful.
 * The returned descriptor stays open: the caller closes it.
 */
async function openVerified(
  edit: ProposedEdit,
  scope: Scope,
  budget?: { remaining: number }
): Promise<VerifiedFile | null> {
  const resolved = await resolveReadableFile(edit.path, scope)
  if (resolved.kind !== 'ok') return null
  if (isInsideWorkspace(resolved.realRelPosix)) return null

  const opened = await openAndRead(resolved.realTarget, budget)
  if (!opened) return null
  try {
    if (isProbablyBinary(opened.data.subarray(0, Math.min(opened.data.length, 8192)))) throw new Refusal(REFUSE_FS)
    const text = opened.data.toString('utf-8')
    // Bytes that are not valid UTF-8 would not survive a write of the text.
    if (!Buffer.from(text, 'utf-8').equals(opened.data)) throw new Refusal(REFUSE_FS)
    // R67. The hash of the whole file and the position of the old text.
    if (!editStillMatches(edit, text)) throw new Refusal(REFUSE_FS)
    return { ...opened, realTarget: resolved.realTarget, realRelPosix: resolved.realRelPosix, text }
  } catch {
    await opened.handle.close().catch(() => undefined)
    return null
  }
}

/**
 * Re-read the verified descriptor and compare the content with what was
 * verified. An in-place save through another descriptor is visible here, which
 * a dev+ino comparison cannot see.
 */
async function assertHandleContent(handle: fs.promises.FileHandle, expectedSha: string): Promise<void> {
  const stat = await handle.stat()
  if (!stat.isFile() || stat.size > APPLY_FILE_MAX_BYTES) throw new ContentChanged()
  const buffer = Buffer.alloc(stat.size)
  let position = 0
  while (position < stat.size) {
    const { bytesRead } = await handle.read(buffer, position, stat.size - position, position)
    if (bytesRead === 0) break
    position += bytesRead
  }
  if (position !== stat.size || sha256(buffer) !== expectedSha) throw new ContentChanged()
}

function replaceAtMatch(edit: ProposedEdit, text: string): string {
  return text.slice(0, edit.matchIndex) + edit.newText + text.slice(edit.matchIndex + edit.oldText.length)
}

// ---------------------------------------------------------------------------
// Scope and snapshot directory
// ---------------------------------------------------------------------------

/**
 * The same Scope the read and edit tools build, for a project root the CALLER
 * derived from the grant. The workspace must be the one ensureProjectWorkspace
 * puts under that root, so a hand-assembled one cannot pass.
 */
async function buildScope(
  projectRoot: string,
  ws: ProjectWorkspace,
  runId: string
): Promise<Scope | null> {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return null
  if (!ws || typeof ws.root !== 'string' || typeof ws.snapshotDir !== 'string') return null
  const root = path.resolve(projectRoot)
  if (ws.root !== path.join(root, WORKSPACE_DIR)) return null
  if (ws.snapshotDir !== path.join(ws.root, 'snapshots', runId)) return null
  const realRoot = await resolveRealPath(root)
  if (realRoot === null) return null
  return { root, realRoot, workspaceRel: WORKSPACE_DIR }
}

/** The snapshot directory must be the real one, not a link that leads elsewhere. */
async function assertSnapshotDir(ws: ProjectWorkspace, scope: Scope, runId: string): Promise<void> {
  const stat = await fs.promises.lstat(ws.snapshotDir)
  if (!stat.isDirectory()) throw new Error('snapshot directory is not a plain directory')
  const real = await fs.promises.realpath(ws.snapshotDir)
  if (real !== path.join(scope.realRoot, WORKSPACE_DIR, 'snapshots', runId)) {
    throw new Error('snapshot directory resolves elsewhere')
  }
}

async function listBatches(snapshotDir: string): Promise<number[]> {
  const names = await fs.promises.readdir(snapshotDir)
  const numbers: number[] = []
  for (const name of names) {
    const match = BATCH_NAME.exec(name)
    if (match) numbers.push(Number(match[1]))
  }
  return numbers.sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

interface ManifestEntry {
  /** Project-relative, posix, as resolved. */
  rel: string
  /** `<k>.bak` inside the batch directory. */
  file: string
  /** sha256 of the content before the write (what the snapshot holds). */
  before: string
  /** sha256 of the content this apply wrote. */
  after: string
}

interface Manifest {
  version: 1
  entries: ManifestEntry[]
}

function parseManifest(raw: string): Manifest {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest is not an object')
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.entries)) throw new Error('manifest has the wrong shape')
  if (record.entries.length > MAX_MANIFEST_ENTRIES) throw new Error('manifest has too many entries')
  const entries: ManifestEntry[] = record.entries.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('manifest entry is not an object')
    const e = item as Record<string, unknown>
    if (
      typeof e.rel !== 'string' ||
      e.rel === '' ||
      e.rel.length > 4096 ||
      typeof e.file !== 'string' ||
      !SNAPSHOT_FILE.test(e.file) ||
      typeof e.before !== 'string' ||
      !SHA256_HEX.test(e.before) ||
      typeof e.after !== 'string' ||
      !SHA256_HEX.test(e.after)
    ) {
      throw new Error('manifest entry is malformed')
    }
    return { rel: e.rel, file: e.file, before: e.before, after: e.after }
  })
  return { version: 1, entries }
}

async function readSmallFile(file: string, maxBytes: number): Promise<Buffer | null> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) return null
    const buffer = Buffer.alloc(stat.size)
    let position = 0
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, position, stat.size - position, position)
      if (bytesRead === 0) break
      position += bytesRead
    }
    return position === stat.size ? buffer : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Restoring one file (shared by the rollback and by undo)
// ---------------------------------------------------------------------------

type RestoreResult = { kind: 'restored' } | { kind: 'skipped'; reason: SkipReason }

const SKIPPED = (reason: SkipReason): RestoreResult => ({ kind: 'skipped', reason })

/**
 * Put one file back to its snapshot, but only when that is provably safe:
 * the path passes the discipline again, the file on disk is still exactly what
 * this apply wrote (so work the user did afterwards is never overwritten), and
 * the snapshot still has the hash recorded for it (so a damaged snapshot is
 * never written over a good file). Anything else is `skipped`, not guessed at.
 */
async function restoreEntry(
  entry: ManifestEntry,
  batchDir: string,
  scope: Scope,
  interrupted = false
): Promise<RestoreResult> {
  const resolved = await resolveReadableFile(entry.rel, scope)
  if (resolved.kind !== 'ok') return SKIPPED('path-not-allowed')
  if (isInsideWorkspace(resolved.realRelPosix)) return SKIPPED('path-not-allowed')

  const current = await openAndRead(resolved.realTarget)
  if (!current) return SKIPPED('unreadable')
  try {
    if (sha256(current.data) !== entry.after) {
      // After an interrupted apply a file that still holds its OLD content was
      // never written; that is not the same as "the user changed it".
      return SKIPPED(interrupted && sha256(current.data) === entry.before ? 'not-written-interrupted' : 'changed-since-apply')
    }
    const snapshot = await readSmallFile(path.join(batchDir, entry.file), APPLY_FILE_MAX_BYTES)
    if (!snapshot || sha256(snapshot) !== entry.before) return SKIPPED('snapshot-damaged')
    try {
      await writeFileAtomic(resolved.realTarget, snapshot, {
        expectIdentity: { dev: current.dev, ino: current.ino },
        verifyBeforeRename: () => assertHandleContent(current.handle, entry.after)
      })
    } catch (error) {
      return SKIPPED(error instanceof ContentChanged ? 'changed-since-apply' : 'write-failed')
    }
    return { kind: 'restored' }
  } finally {
    await current.handle.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// applyPendingEdits
// ---------------------------------------------------------------------------

export async function applyPendingEdits(
  runId: string,
  ws: ProjectWorkspace,
  dir: AllowedDirectory,
  deps: ApplyDeps = defaultApplyDeps(),
  options: { expectedDigest?: string } = {}
): Promise<ApplyOutcome> {
  try {
    return await applyInner(runId, ws, dir, deps, options)
  } catch (error) {
    // Anything unexpected is a refusal, never a partial success.
    return refused(error instanceof Refusal ? error.reason : REFUSE_FS)
  }
}

async function applyInner(
  runId: string,
  ws: ProjectWorkspace,
  dir: AllowedDirectory,
  deps: ApplyDeps,
  options: { expectedDigest?: string }
): Promise<ApplyOutcome> {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) throw new Refusal(REFUSE_INPUT)
  if (!dir || typeof dir.id !== 'string') throw new Refusal(REFUSE_INPUT)

  // 1. Grant and mode, looked up again now. The `dir` the caller passed is only
  // a name for the grant: what it allows is read afresh.
  const grant = await deps.findGrant(dir.id)
  if (!permitsEdit(grant)) throw new Refusal(REFUSE_GRANT)
  const mode = parseCodingMode(await deps.getMode(dir.id))
  if (!atLeast(CODING_MODE_ORDER, mode, 'propose')) throw new Refusal(REFUSE_GRANT)

  // 2. Everything that needs no file content.
  const edits = deps.store.pending(runId)
  if (edits.length === 0) throw new Refusal(REFUSE_NOTHING)
  // The human approved a set. When the caller says which set, this is the one
  // snapshot of the run's package that is checked, applied and later released:
  // nothing added afterwards rides along.
  if (options.expectedDigest !== undefined && packageDigest(edits) !== options.expectedDigest) {
    throw new Refusal(REFUSE_PACKAGE_CHANGED)
  }

  const scope = await buildScope(grant.path, ws, runId)
  if (!scope) throw new Refusal(REFUSE_WORKSPACE)

  if (busyProjects.has(scope.realRoot)) throw new Refusal(REFUSE_BUSY)
  busyProjects.add(scope.realRoot)
  try {
    // An earlier apply of this run that never finished leaves a marker. Sweep
    // its temp files and stop: new writes on top of an unknown state are worse
    // than a refusal.
    try {
      await assertSnapshotDir(ws, scope, runId)
      const earlier = await listBatches(ws.snapshotDir)
      const interrupted: number[] = []
      for (const number of earlier) {
        if (await hasMarker(path.join(ws.snapshotDir, `batch-${number}`))) interrupted.push(number)
      }
      if (interrupted.length > 0) {
        // A marker next to a batch whose every file already holds the recorded
        // result is a COMPLETE apply whose marker was not cleared: heal it.
        // Anything else is a genuine partial state and stays a refusal.
        let allComplete = true
        for (const number of interrupted) {
          const manifest = await readVouchedManifest(ws, runId, number, deps.ledger)
          if (manifest) await sweepStaleTemps(scope, manifest.entries)
          if (!manifest || !(await batchComplete(manifest, scope))) allComplete = false
        }
        if (!allComplete) throw new Refusal(REFUSE_INTERRUPTED)
        for (const number of interrupted) await clearMarker(path.join(ws.snapshotDir, `batch-${number}`))
      }
    } catch (error) {
      throw error instanceof Refusal ? error : new Refusal(REFUSE_SNAPSHOT)
    }

    const seen = new Set<string>()
    for (const edit of edits) {
      const resolved = await resolveReadableFile(edit.path, scope)
      if (resolved.kind !== 'ok' || isInsideWorkspace(resolved.realRelPosix)) throw new Refusal(REFUSE_FS)
      // Two proposals that now name one file (a link made after proposing).
      if (seen.has(resolved.realTarget)) throw new Refusal(REFUSE_FS)
      seen.add(resolved.realTarget)
    }

    // 3. Pass 1: verify and snapshot. The project is untouched.
    const entries: ManifestEntry[] = []
    const batchDir = await makeBatchDir(ws, scope, runId)
    try {
      const budget = { remaining: deps.maxSnapshotBytes ?? APPLY_MAX_SNAPSHOT_BYTES }
      for (let i = 0; i < edits.length; i++) {
        const verified = await openVerified(edits[i], scope, budget)
        if (!verified) throw new Refusal(REFUSE_FS)
        try {
          const file = `${i}.bak`
          await writeNewFile(path.join(batchDir, file), verified.data)
          entries.push({
            rel: verified.realRelPosix,
            file,
            before: sha256(verified.data),
            after: sha256(replaceAtMatch(edits[i], verified.text))
          })
        } finally {
          await verified.handle.close().catch(() => undefined)
        }
      }
      const manifest: Manifest = { version: 1, entries }
      const manifestJson = JSON.stringify(manifest)
      await writeFileAtomic(path.join(batchDir, MANIFEST_NAME), manifestJson, { mode: 0o600 })
      // The authority for undo: a row outside the project, written BEFORE the
      // first project file is touched. If it cannot be written, nothing is.
      await deps.ledger.record(scope.realRoot, runId, batchNumber(batchDir), sha256(manifestJson))
      // Detectable from here on: if the process dies during pass 2 the marker is
      // still there. Written before any project file is touched.
      await writeNewFile(path.join(batchDir, MARKER_NAME), Buffer.from(JSON.stringify({ startedAt: Date.now() })))
    } catch (error) {
      await fs.promises.rm(batchDir, { recursive: true, force: true }).catch(() => undefined)
      // A failed verification keeps its reason; anything else here is the snapshot.
      throw error instanceof Refusal ? error : new Refusal(REFUSE_SNAPSHOT)
    }

    // 4. Pass 2: check and write, one file at a time.
    const grantAllows = async (): Promise<boolean> => {
      const fresh = await deps.findGrant(dir.id)
      return permitsEdit(fresh) && path.resolve(fresh.path) === scope.root
    }
    const recheckAuthority = async (): Promise<void> => {
      if (!(await grantAllows())) throw new AuthorityLost(true)
      const now = parseCodingMode(await deps.getMode(dir.id))
      if (!atLeast(CODING_MODE_ORDER, now, 'propose')) throw new AuthorityLost(false)
    }
    const written: number[] = []
    try {
      for (let i = 0; i < edits.length; i++) {
        const verified = await openVerified(edits[i], scope)
        if (!verified) throw new Refusal(REFUSE_FS)
        try {
          // No separate `before`/`after` re-hash here, deliberately: openVerified
          // has just run editStillMatches, which compares the hash of the content
          // just read with the proposal's baseSha256, and pass 1 verified the same
          // hash. The same text gives the same replacement, so both manifest
          // hashes follow. They were redundant (removing them changed no result)
          // and an untested branch that looks like a check is worse than none.
          const next = replaceAtMatch(edits[i], verified.text)
          await deps.hooks?.afterVerify?.(i)
          // Grant and mode again, immediately before THIS write: the user may
          // change their mind halfway through the package.
          await recheckAuthority()
          await writeFileAtomic(verified.realTarget, next, {
            expectIdentity: { dev: verified.dev, ino: verified.ino },
            verifyBeforeRename: () => assertHandleContent(verified.handle, entries[i].before)
          })
          written.push(i)
        } finally {
          await verified.handle.close().catch(() => undefined)
        }
        await deps.hooks?.afterWrite?.(i)
      }
    } catch (error) {
      // A rollback is a write too: without the grant there is none. (The mode
      // is not needed for it, as for undo.)
      const mayWrite = !(error instanceof AuthorityLost && error.grantGone) && (await grantAllows())
      if (!mayWrite) {
        // Partial state keeps the marker; nothing written does not need it.
        if (written.length > 0) throw new Refusal(REFUSE_WITHDRAWN)
        await clearMarker(batchDir)
        throw new Refusal(REFUSE_GRANT)
      }
      const stuck = await rollBack(written, entries, batchDir, scope)
      if (stuck > 0) throw new Refusal(REFUSE_PARTIAL)
      await clearMarker(batchDir)
      if (error instanceof AuthorityLost) throw new Refusal(REFUSE_GRANT)
      throw error instanceof Refusal ? error : new Refusal(REFUSE_FS)
    }

    await clearMarker(batchDir)
    auditAppliedChanges(runId, scope.realRoot, entries, edits)
    return { kind: 'applied', paths: entries.map((e) => e.rel), edits }
  } finally {
    busyProjects.delete(scope.realRoot)
  }
}

/**
 * One audit entry per file that was written, after the whole package is on disk
 * and never for a refused or rolled-back apply. Everything it passes on is a
 * path or a number (see coding-audit.ts for why nothing else can be recorded).
 *
 * A failing audit store must not turn a finished apply into a refusal: the
 * files ARE written, and "nothing was written" would be false. The store's own
 * logger reports the failure.
 * DEBT: a lost audit row is only logged -> block the apply on a failed audit
 * write once the audit store is durable enough to make that refusal rare.
 */
function auditAppliedChanges(
  runId: string,
  projectRoot: string,
  entries: ManifestEntry[],
  edits: ProposedEdit[]
): void {
  try {
    const run = resolveRunAuditContext(runId)
    const policyVersion = currentPolicyVersion()
    entries.forEach((entry, i) => {
      logCodingChange(runId, {
        projectPath: projectRoot,
        filePath: entry.rel,
        addedLines: edits[i].addedLines,
        removedLines: edits[i].removedLines,
        provider: run.provider,
        model: run.model,
        policyVersion,
        guardRedirected: run.guardRedirected,
        guardBlocked: run.guardBlocked
      })
    })
  } catch {
    // See above: the apply stands.
  }
}

/** Newest first; returns how many written files could NOT be put back. */
async function rollBack(
  written: number[],
  entries: ManifestEntry[],
  batchDir: string,
  scope: Scope
): Promise<number> {
  let stuck = 0
  for (const index of [...written].reverse()) {
    try {
      if ((await restoreEntry(entries[index], batchDir, scope)).kind !== 'restored') stuck++
    } catch {
      stuck++
    }
  }
  return stuck
}

function batchNumber(batchDir: string): number {
  return Number(BATCH_NAME.exec(path.basename(batchDir))?.[1])
}

async function hasMarker(batchDir: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(path.join(batchDir, MARKER_NAME))).isFile()
  } catch {
    return false
  }
}

/** Best effort: a marker that cannot be removed only makes the next apply refuse, which is safe. */
async function clearMarker(batchDir: string): Promise<void> {
  await fs.promises.unlink(path.join(batchDir, MARKER_NAME)).catch(() => undefined)
}

/**
 * Remove the temp files an interrupted write leaves, in the directories the
 * batch touched and nowhere else. Only names this module generates, only plain
 * files, and only under the project lock, so no write of ours is in flight.
 */
async function sweepStaleTemps(scope: Scope, entries: ManifestEntry[]): Promise<void> {
  const dirs = new Set<string>()
  for (const entry of entries) {
    const resolved = await resolveReadableFile(entry.rel, scope)
    if (resolved.kind === 'ok') dirs.add(path.dirname(resolved.realTarget))
  }
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await fs.promises.readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!STALE_TEMP.test(name)) continue
      const full = path.join(dir, name)
      try {
        if ((await fs.promises.lstat(full)).isFile()) await fs.promises.unlink(full)
      } catch {
        // Left for the next sweep.
      }
    }
  }
}

/** Every file of the batch holds exactly the content this apply recorded as its result. */
async function batchComplete(manifest: Manifest, scope: Scope): Promise<boolean> {
  for (const entry of manifest.entries) {
    const resolved = await resolveReadableFile(entry.rel, scope)
    if (resolved.kind !== 'ok' || isInsideWorkspace(resolved.realRelPosix)) return false
    const current = await openAndRead(resolved.realTarget)
    if (!current) return false
    await current.handle.close().catch(() => undefined)
    if (sha256(current.data) !== entry.after) return false
  }
  return true
}

/** The manifest of a batch, only if the ledger vouches for it and it parses. */
async function readVouchedManifest(
  ws: ProjectWorkspace,
  runId: string,
  number: number,
  ledger: SnapshotLedger
): Promise<Manifest | null> {
  try {
    const recorded = await ledger.lookup(runId, number)
    const raw = await readSmallFile(path.join(ws.snapshotDir, `batch-${number}`, MANIFEST_NAME), MANIFEST_MAX_BYTES)
    if (recorded === undefined || !raw || sha256(raw) !== recorded) return null
    return parseManifest(raw.toString('utf-8'))
  } catch {
    return null
  }
}

async function makeBatchDir(ws: ProjectWorkspace, scope: Scope, runId: string): Promise<string> {
  try {
    await assertSnapshotDir(ws, scope, runId)
    const existing = await listBatches(ws.snapshotDir)
    if (existing.length >= MAX_BATCHES) throw new Error('too many snapshot batches')
    const next = (existing.length > 0 ? existing[existing.length - 1] : 0) + 1
    const batchDir = path.join(ws.snapshotDir, `batch-${next}`)
    // Not recursive: an existing directory is an error, never reused.
    await fs.promises.mkdir(batchDir, { mode: 0o700 })
    return batchDir
  } catch {
    throw new Refusal(REFUSE_SNAPSHOT)
  }
}

/** A new file only: an existing one is never overwritten. */
async function writeNewFile(file: string, data: Buffer): Promise<void> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
    0o600
  )
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// undoRun
// ---------------------------------------------------------------------------

/**
 * Restore every file of the run from its snapshots, newest batch first, and
 * return what was restored AND what was left alone, with the reason. No git
 * needed.
 *
 * A file is restored only when it still holds exactly what the apply wrote:
 * a file the user changed afterwards is left alone and reported as skipped.
 * A malformed manifest throws before anything is restored.
 */
export async function undoRun(
  runId: string,
  ws: ProjectWorkspace,
  deps: Pick<ApplyDeps, 'ledger'> = defaultApplyDeps()
): Promise<UndoResult> {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) throw new Error('invalid run id')
  if (!ws || typeof ws.root !== 'string' || path.basename(ws.root) !== WORKSPACE_DIR) {
    throw new Error('invalid workspace')
  }
  const scope = await buildScope(path.dirname(ws.root), ws, runId)
  if (!scope) throw new Error('workspace does not match')
  if (busyProjects.has(scope.realRoot)) throw new Error(REFUSE_BUSY)
  busyProjects.add(scope.realRoot)
  try {
    await assertSnapshotDir(ws, scope, runId)
    const batches = await listBatches(ws.snapshotDir)
    if (batches.length > MAX_BATCHES) throw new Error('too many snapshot batches')
    let interruptedRun = false

    // Judge every batch before the first restore. A batch that cannot be
    // vouched for is REPORTED as skipped, and the others still restore: one
    // orphan directory (what a crash in pass 1 leaves) must not disable undo.
    const parsed: Array<{ batchDir: string; manifest: Manifest }> = []
    const skipped: SkippedFile[] = []
    for (const number of [...batches].reverse()) {
      const batchDir = path.join(ws.snapshotDir, `batch-${number}`)
      const batchPath = `${WORKSPACE_DIR}/snapshots/${runId}/batch-${number}`
      // The disk inside the project vouches for nothing. The manifest must be
      // byte-for-byte what this app recorded outside the project, else the
      // batch is not restored. Do not "repair" a missing record by trusting the disk.
      const recorded = await deps.ledger.lookup(runId, number)
      if (recorded === undefined) {
        skipped.push({ path: batchPath, reason: 'batch-not-recorded' })
        continue
      }
      const raw = await readSmallFile(path.join(batchDir, MANIFEST_NAME), MANIFEST_MAX_BYTES)
      if (!raw) {
        skipped.push({ path: batchPath, reason: 'batch-manifest-missing' })
        continue
      }
      if (recorded !== sha256(raw)) {
        skipped.push({ path: batchPath, reason: 'batch-manifest-changed' })
        continue
      }
      try {
        parsed.push({ batchDir, manifest: parseManifest(raw.toString('utf-8')) })
      } catch {
        skipped.push({ path: batchPath, reason: 'batch-manifest-invalid' })
      }
    }

    const restored: string[] = []
    for (const { batchDir, manifest } of parsed) {
      const interrupted = await hasMarker(batchDir)
      for (const entry of [...manifest.entries].reverse()) {
        const result = await restoreEntry(entry, batchDir, scope, interrupted)
        if (result.kind === 'restored') restored.push(entry.rel)
        else skipped.push({ path: entry.rel, reason: result.reason })
      }
      if (interrupted) {
        // Reported in this result; the stale temps of the interruption go too.
        interruptedRun = true
        await sweepStaleTemps(scope, manifest.entries)
        await clearMarker(batchDir)
      }
    }
    try {
      logCodingRunUndone(runId, { projectPath: scope.realRoot, restored, skipped, interrupted: interruptedRun })
    } catch {
      // The restore is done; a failing audit store does not undo it.
    }
    return interruptedRun ? { restored, skipped, interrupted: true } : { restored, skipped }
  } finally {
    busyProjects.delete(scope.realRoot)
  }
}

// ---------------------------------------------------------------------------
// What the IPC handlers do (R56)
// ---------------------------------------------------------------------------
//
// They live here, not in agent-handlers, so the whole decision is testable
// without Electron. A handler takes a run id and a directory id and nothing
// else: never a path from the renderer. The project path comes from the grant
// in the main process. A grant that is gone is NOT rebuilt around: writing into
// a directory without permission is the same write as any other. The workspace
// is rebuilt with ensureProjectWorkspace, which is idempotent; R33 forbids that
// for tool handlers DURING a run (a second instance races the first), not for
// these, which run after it.

function validIds(runId: unknown, directoryId: unknown): runId is string {
  return (
    typeof runId === 'string' &&
    SAFE_RUN_ID.test(runId) &&
    typeof directoryId === 'string' &&
    directoryId !== ''
  )
}

/** The run's snapshot directory physically exists under the grant (a real directory, not a link). */
async function snapshotPresent(grantPath: string, runId: string): Promise<boolean> {
  try {
    const dir = path.join(path.resolve(grantPath), WORKSPACE_DIR, 'snapshots', runId)
    return (await fs.promises.lstat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * ACCEPT keeps the registry as the only authority, on purpose and unlike undo:
 * pending proposals live in memory and die with the process, so accept cannot
 * work after a restart whatever is checked, and requiring the record costs
 * nothing. Undo works from files, so it must not depend on memory.
 *
 * The directory the run started in is the main process's record; the id the
 * renderer sent is only checked against it. No record, or a different id, is a
 * refusal: never a silent preference for either side, and never a fallback to
 * the parameter.
 */
function runBelongsTo(deps: Pick<ApplyDeps, 'runDirectories'>, runId: string, directoryId: unknown): boolean {
  const recorded = deps.runDirectories?.get(runId)
  return typeof recorded === 'string' && recorded === directoryId
}

export async function acceptEditsForRun(
  runId: unknown,
  directoryId: unknown,
  expectedDigest: unknown,
  deps: ApplyDeps = defaultApplyDeps()
): Promise<ApplyOutcome> {
  try {
    if (!validIds(runId, directoryId)) return refused(REFUSE_INPUT)
    // What the human approved is a package, named by its digest; "whatever the
    // run holds" is not an accept.
    if (typeof expectedDigest !== 'string' || expectedDigest === '') return refused(REFUSE_INPUT)
    if (!runBelongsTo(deps, runId, directoryId)) return refused(REFUSE_RUN_DIRECTORY)
    const grant = await deps.findGrant(directoryId as string)
    if (!permitsEdit(grant)) return refused(REFUSE_GRANT)
    if (deps.store.pending(runId).length === 0) return refused(REFUSE_NOTHING)

    let ws: ProjectWorkspace
    try {
      ws = await ensureProjectWorkspace(path.resolve(grant.path), runId)
    } catch {
      return refused(REFUSE_WORKSPACE)
    }

    const outcome = await applyPendingEdits(runId, ws, grant, deps, { expectedDigest })
    // One source of truth: the store is told only after the write succeeded,
    // and only about the proposals that were applied. On a refusal the proposal
    // stays, so the user sees why.
    if (outcome.kind === 'applied') deps.store.resolveApplied(runId, outcome.edits)
    return outcome
  } catch {
    return refused(REFUSE_FS)
  }
}

export function rejectEditsForRun(
  runId: unknown,
  deps: Pick<ApplyDeps, 'store'> = { store: getEditProposalStore() },
  reason?: string
): RejectOutcome {
  try {
    if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) return refused(REFUSE_INPUT)
    const count = deps.store.pending(runId).length
    deps.store.resolve(runId, false, typeof reason === 'string' ? reason : undefined)
    return { kind: 'rejected', count }
  } catch {
    return refused(REFUSE_INPUT)
  }
}

/**
 * Undo needs the grant with read and edit (it writes), and deliberately NOT the
 * coding mode. Undo is the safety net: someone switches coding off BECAUSE
 * something went wrong, and making undo depend on the mode would lock them out
 * of restoring their own files exactly then. The grant is the right gate: the
 * directory must still be one this app may write. Do not "tighten" this.
 */
export async function undoRunForDirectory(
  runId: unknown,
  directoryId: unknown,
  deps: ApplyDeps = defaultApplyDeps()
): Promise<UndoOutcome> {
  try {
    if (!validIds(runId, directoryId)) return refused(REFUSE_INPUT)
    // Within a session the registry is the stronger test: a renderer that
    // disagrees with the main process is refused and surfaced. It is only an
    // ADDITIONAL check here. After a restart it has no record, and undo must
    // still work: "what" may be restored is the ledger's manifest hash, "where"
    // is the user's own grant plus the snapshot being physically present under
    // it (checked below). Nothing is trusted that was not already trusted.
    const known = deps.runDirectories?.get(runId)
    if (known !== undefined && known !== directoryId) return refused(REFUSE_RUN_DIRECTORY)
    const grant = await deps.findGrant(directoryId as string)
    if (!permitsEdit(grant)) return refused(REFUSE_GRANT)
    if (!(await snapshotPresent(grant.path, runId))) return refused(REFUSE_NO_SNAPSHOT)

    let ws: ProjectWorkspace
    try {
      ws = await ensureProjectWorkspace(path.resolve(grant.path), runId)
    } catch {
      return refused(REFUSE_WORKSPACE)
    }
    const result = await undoRun(runId, ws, deps)
    // Nothing restored and the reason is a batch this app cannot vouch for: a
    // refusal that says so, with the list, not an empty success.
    const batchLevel = result.skipped.filter((f) => f.reason.startsWith('batch-'))
    if (result.restored.length === 0 && batchLevel.length > 0) {
      // A genuine batch whose files were all changed is not the same thing as an
      // unrecorded one: say which.
      const genuineButChanged = result.skipped.some((f) => !f.reason.startsWith('batch-'))
      return {
        kind: 'refused',
        reason: genuineButChanged
          ? REFUSE_MIXED
          : batchLevel.some((f) => f.reason === 'batch-not-recorded' || f.reason === 'batch-manifest-changed')
          ? REFUSE_UNRECORDED
          : REFUSE_BATCH_UNUSABLE,
        skipped: result.skipped
      }
    }
    return { kind: 'restored', ...result }
  } catch {
    return refused(REFUSE_FS)
  }
}
