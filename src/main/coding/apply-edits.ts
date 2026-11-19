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
import { createHash, randomBytes } from 'crypto'
import { CODING_MODE_ORDER, parseCodingMode, type CodingMode } from '../../shared/coding-types'
import { hasPermission, type AllowedDirectory } from '../../shared/file-access-types'
import { atLeast } from '../policy/policy-types'
import { resolveRealPath } from '../file-access/real-path-guard'
import { editStillMatches, getEditProposalStore, type EditProposalStore } from './edit-proposals'
import { isProbablyBinary } from './path-policy'
import { resolveReadableFile, defaultReadToolDeps, type Scope } from './read-tools'
import { ensureProjectWorkspace, type ProjectWorkspace } from './project-workspace'
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
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/
const BATCH_NAME = /^batch-(\d{1,9})$/
const SNAPSHOT_FILE = /^\d{1,6}\.bak$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const WORKSPACE_DIR = '.mingly'

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0

// ---------------------------------------------------------------------------
// Outcomes and reasons
// ---------------------------------------------------------------------------

export type ApplyOutcome =
  | { kind: 'applied'; paths: string[] }
  | { kind: 'refused'; reason: string }

export type UndoOutcome =
  | { kind: 'restored'; paths: string[] }
  | { kind: 'refused'; reason: string }

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
const REFUSE_WORKSPACE = 'Nothing was written: the project workspace does not belong to this grant.'
const REFUSE_SNAPSHOT =
  'Nothing was written: the snapshot could not be made, and no file is changed without one.'
const REFUSE_BUSY = 'Nothing was written: another apply or undo is running for this project.'
const REFUSE_PARTIAL =
  'A write failed after other files were already written, and not every file could be restored. ' +
  'Run undo for this run to restore what the snapshot still allows.'

function refused(reason: string): { kind: 'refused'; reason: string } {
  return { kind: 'refused', reason }
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
  store: Pick<EditProposalStore, 'pending' | 'resolve'>
  findGrant(directoryId: string): Promise<AllowedDirectory | undefined>
  getMode(directoryId: string): CodingMode | Promise<CodingMode>
  /** Overrides APPLY_MAX_SNAPSHOT_BYTES. */
  maxSnapshotBytes?: number
  hooks?: ApplyHooks
}

/** Loaded lazily: the mode store pulls in electron. */
let modeStoreModule: Promise<typeof import('./coding-mode-store')> | undefined

export function defaultApplyDeps(): ApplyDeps {
  return {
    store: getEditProposalStore(),
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
  mode: number
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
    return { handle, data: buffer, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 }
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

function replaceAtMatch(edit: ProposedEdit, text: string): string {
  return text.slice(0, edit.matchIndex) + edit.newText + text.slice(edit.matchIndex + edit.oldText.length)
}

// ---------------------------------------------------------------------------
// The atomic write
// ---------------------------------------------------------------------------

export interface AtomicWriteOptions {
  /** Permission bits of the new file. Default: those of the file it replaces, else 0o644. */
  mode?: number
  /**
   * The inode the caller verified. Checked right before the rename: if the path
   * is no longer that file, nothing is renamed.
   */
  expectIdentity?: { dev: number; ino: number }
}

async function assertRealDirectory(dir: string): Promise<void> {
  if ((await fs.promises.realpath(dir)) !== dir) throw new Error('directory changed under the write')
}

/**
 * Write `content` to a temp file in the target's own directory, then rename it
 * over the target. `rename` inside one file system is atomic: an interruption
 * leaves the target entirely old or entirely new, and a temp file in /tmp would
 * not give that, because rename across file systems copies.
 */
export async function writeFileAtomic(
  target: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(target)
  const expected = options.expectIdentity
  if (expected) await assertRealDirectory(dir)

  let mode = options.mode
  if (mode === undefined) {
    try {
      mode = (await fs.promises.stat(target)).mode & 0o777
    } catch {
      mode = 0o644
    }
  }

  // Fixed length, independent of the target's name: a long file name must not
  // make the temp name too long.
  const temp = path.join(dir, `.mingly-tmp-${randomBytes(8).toString('hex')}`)
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      0o600
    )
    await handle.writeFile(content)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined

    if (expected) {
      await assertRealDirectory(dir)
      const now = await fs.promises.lstat(target)
      if (!now.isFile() || now.dev !== expected.dev || now.ino !== expected.ino) {
        throw new Error('target is no longer the file that was verified')
      }
    }
    await fs.promises.rename(temp, target)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.promises.unlink(temp).catch(() => undefined)
    throw error
  }
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

type RestoreResult = 'restored' | 'skipped'

/**
 * Put one file back to its snapshot, but only when that is provably safe:
 * the path passes the discipline again, the file on disk is still exactly what
 * this apply wrote (so work the user did afterwards is never overwritten), and
 * the snapshot still has the hash recorded for it (so a damaged snapshot is
 * never written over a good file). Anything else is `skipped`, not guessed at.
 */
async function restoreEntry(entry: ManifestEntry, batchDir: string, scope: Scope): Promise<RestoreResult> {
  const resolved = await resolveReadableFile(entry.rel, scope)
  if (resolved.kind !== 'ok') return 'skipped'
  if (isInsideWorkspace(resolved.realRelPosix)) return 'skipped'

  const current = await openAndRead(resolved.realTarget)
  if (!current) return 'skipped'
  try {
    if (sha256(current.data) !== entry.after) return 'skipped'
    const snapshot = await readSmallFile(path.join(batchDir, entry.file), APPLY_FILE_MAX_BYTES)
    if (!snapshot || sha256(snapshot) !== entry.before) return 'skipped'
    await writeFileAtomic(resolved.realTarget, snapshot, {
      mode: current.mode,
      expectIdentity: { dev: current.dev, ino: current.ino }
    })
    return 'restored'
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
  deps: ApplyDeps = defaultApplyDeps()
): Promise<ApplyOutcome> {
  try {
    return await applyInner(runId, ws, dir, deps)
  } catch (error) {
    // Anything unexpected is a refusal, never a partial success.
    return refused(error instanceof Refusal ? error.reason : REFUSE_FS)
  }
}

async function applyInner(
  runId: string,
  ws: ProjectWorkspace,
  dir: AllowedDirectory,
  deps: ApplyDeps
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

  const scope = await buildScope(grant.path, ws, runId)
  if (!scope) throw new Refusal(REFUSE_WORKSPACE)

  if (busyProjects.has(scope.realRoot)) throw new Refusal(REFUSE_BUSY)
  busyProjects.add(scope.realRoot)
  try {
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
      await writeFileAtomic(path.join(batchDir, MANIFEST_NAME), JSON.stringify(manifest), { mode: 0o600 })
    } catch (error) {
      await fs.promises.rm(batchDir, { recursive: true, force: true }).catch(() => undefined)
      // A failed verification keeps its reason; anything else here is the snapshot.
      throw error instanceof Refusal ? error : new Refusal(REFUSE_SNAPSHOT)
    }

    // 4. Pass 2: check and write, one file at a time.
    const written: number[] = []
    try {
      for (let i = 0; i < edits.length; i++) {
        const verified = await openVerified(edits[i], scope)
        if (!verified) throw new Refusal(REFUSE_FS)
        try {
          if (sha256(verified.data) !== entries[i].before) throw new Refusal(REFUSE_FS)
          const next = replaceAtMatch(edits[i], verified.text)
          if (sha256(next) !== entries[i].after) throw new Refusal(REFUSE_FS)
          await deps.hooks?.afterVerify?.(i)
          await writeFileAtomic(verified.realTarget, next, {
            mode: verified.mode,
            expectIdentity: { dev: verified.dev, ino: verified.ino }
          })
          written.push(i)
        } finally {
          await verified.handle.close().catch(() => undefined)
        }
        await deps.hooks?.afterWrite?.(i)
      }
    } catch (error) {
      const stuck = await rollBack(written, entries, batchDir, scope)
      if (stuck > 0) throw new Refusal(REFUSE_PARTIAL)
      throw error instanceof Refusal ? error : new Refusal(REFUSE_FS)
    }

    return { kind: 'applied', paths: entries.map((e) => e.rel) }
  } finally {
    busyProjects.delete(scope.realRoot)
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
      if ((await restoreEntry(entries[index], batchDir, scope)) !== 'restored') stuck++
    } catch {
      stuck++
    }
  }
  return stuck
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
 * return the paths that were restored. No git needed.
 *
 * A file is restored only when it still holds exactly what the apply wrote:
 * a file the user changed afterwards is left alone and does not appear in the
 * result. A malformed manifest throws before anything is restored.
 */
export async function undoRun(runId: string, ws: ProjectWorkspace): Promise<string[]> {
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

    // Parse every manifest before the first restore.
    const parsed: Array<{ batchDir: string; manifest: Manifest }> = []
    for (const number of [...batches].reverse()) {
      const batchDir = path.join(ws.snapshotDir, `batch-${number}`)
      const raw = await readSmallFile(path.join(batchDir, MANIFEST_NAME), MANIFEST_MAX_BYTES)
      if (!raw) throw new Error('manifest unreadable')
      parsed.push({ batchDir, manifest: parseManifest(raw.toString('utf-8')) })
    }

    const restored: string[] = []
    for (const { batchDir, manifest } of parsed) {
      for (const entry of [...manifest.entries].reverse()) {
        if ((await restoreEntry(entry, batchDir, scope)) === 'restored') restored.push(entry.rel)
      }
    }
    return restored
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

export async function acceptEditsForRun(
  runId: unknown,
  directoryId: unknown,
  deps: ApplyDeps = defaultApplyDeps()
): Promise<ApplyOutcome> {
  try {
    if (!validIds(runId, directoryId)) return refused(REFUSE_INPUT)
    const grant = await deps.findGrant(directoryId as string)
    if (!permitsEdit(grant)) return refused(REFUSE_GRANT)
    if (deps.store.pending(runId).length === 0) return refused(REFUSE_NOTHING)

    let ws: ProjectWorkspace
    try {
      ws = await ensureProjectWorkspace(path.resolve(grant.path), runId)
    } catch {
      return refused(REFUSE_WORKSPACE)
    }

    const outcome = await applyPendingEdits(runId, ws, grant, deps)
    // One source of truth: the store is told only after the write succeeded.
    // On a refusal the proposal stays, so the user sees why.
    if (outcome.kind === 'applied') deps.store.resolve(runId, true)
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
 * Undo needs the grant with read and edit (it writes), but not the mode: the
 * user who switched coding off afterwards still gets their files back.
 */
export async function undoRunForDirectory(
  runId: unknown,
  directoryId: unknown,
  deps: ApplyDeps = defaultApplyDeps()
): Promise<UndoOutcome> {
  try {
    if (!validIds(runId, directoryId)) return refused(REFUSE_INPUT)
    const grant = await deps.findGrant(directoryId as string)
    if (!permitsEdit(grant)) return refused(REFUSE_GRANT)

    let ws: ProjectWorkspace
    try {
      ws = await ensureProjectWorkspace(path.resolve(grant.path), runId)
    } catch {
      return refused(REFUSE_WORKSPACE)
    }
    return { kind: 'restored', paths: await undoRun(runId, ws) }
  } catch {
    return refused(REFUSE_FS)
  }
}
