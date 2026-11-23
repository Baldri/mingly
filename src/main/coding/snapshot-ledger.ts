/**
 * The ledger of snapshot batches this app created.
 *
 * A manifest inside `<project>/.mingly/snapshots/` is written to a place the
 * project (and anyone who can put files in the repository) controls, so it
 * proves nothing by itself: a crafted tree there would make undo write someone
 * else's bytes into the user's files and call it a restore. This ledger lives in
 * the app's userData, which the project cannot write. Each row names a batch
 * (run id, batch number) and the SHA-256 of the manifest as it was written. The
 * real project root is kept in the row as DIAGNOSTIC DATA only and is not part
 * of the key: a moved project must still find its own row. The authority is the
 * manifest hash; paths are only keys and may change while it stays. Undo restores a batch only when the manifest on disk still
 * has that hash; a batch with no row is not ours and is refused.
 *
 * Consequence, accepted: if the row is gone (userData cleared, project moved to
 * another machine) undo refuses even a genuine snapshot. Do NOT repair that by
 * trusting the disk again; that is the hole this closes.
 *
 * Bounded as a whole: at most LEDGER_MAX_ROWS, oldest dropped first. A dropped
 * row makes that old batch refuse (fail closed), never be trusted.
 */

import * as fs from 'fs'
import * as path from 'path'
import { writeFileAtomic } from './atomic-write'

export const LEDGER_MAX_ROWS = 5000

/** The get/set shape of SimpleStore, so tests can supply a plain double. */
export interface LedgerBacking {
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
}

export interface SnapshotLedger {
  record(root: string, runId: string, batch: number, manifestSha256: string): Promise<void>
  /** The recorded manifest hash, or undefined when this app never created the batch. */
  lookup(runId: string, batch: number): Promise<string | undefined>
}

interface Row {
  key: string
  sha: string
  /** Where the batch was created. Informational: never compared. */
  root: string
}

const ROWS_KEY = 'batches'

function keyOf(runId: string, batch: number): string {
  return `${runId}\u0000${batch}`
}

export function createSnapshotLedger(backing: LedgerBacking, maxRows: number = LEDGER_MAX_ROWS): SnapshotLedger {
  const read = (): Row[] => {
    const stored = backing.get(ROWS_KEY, [])
    if (!Array.isArray(stored)) return []
    return stored.filter(
      (r): r is Row =>
        typeof r === 'object' && r !== null && typeof (r as Row).key === 'string' && typeof (r as Row).sha === 'string' &&
        typeof (r as Row).root === 'string'
    )
  }
  return {
    async record(root, runId, batch, manifestSha256) {
      const key = keyOf(runId, batch)
      const rows = read().filter((r) => r.key !== key)
      rows.push({ key, sha: manifestSha256, root })
      backing.set(ROWS_KEY, rows.slice(-maxRows))
    },
    async lookup(runId, batch) {
      return read().find((r) => r.key === keyOf(runId, batch))?.sha
    }
  }
}

function parseRows(raw: string): Row[] | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    const rows = (parsed as { rows?: unknown } | null)?.rows
    if (!Array.isArray(rows)) return null
    return rows.filter(
      (r): r is Row =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Row).key === 'string' &&
        typeof (r as Row).sha === 'string' &&
        typeof (r as Row).root === 'string'
    )
  } catch {
    return null
  }
}

/**
 * The ledger as a file, written with the same temp-and-rename discipline as the
 * project files. It does NOT use SimpleStore, on purpose: SimpleStore.save()
 * swallows write errors (the ledger's whole value is that a failed record stops
 * the apply) and writes in place (a crash mid-write leaves a half file that
 * loads as empty, dropping every row). Here a write failure propagates, a write
 * is all-or-nothing, and a file that does not parse is moved aside rather than
 * overwritten: lookups treat it as "no rows" (undo refuses, fail closed), and
 * the next record starts a fresh file.
 *
 * Calls are serialized in-process, so two records cannot lose each other's row.
 */
export function createFileSnapshotLedger(filePath: string, maxRows: number = LEDGER_MAX_ROWS): SnapshotLedger {
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn)
    chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const load = async (): Promise<{ rows: Row[]; corrupt: boolean }> => {
    let raw: string
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], corrupt: false }
      throw error
    }
    const rows = parseRows(raw)
    return rows === null ? { rows: [], corrupt: true } : { rows, corrupt: false }
  }

  return {
    record: (root, runId, batch, manifestSha256) =>
      serial(async () => {
        const { rows, corrupt } = await load()
        if (corrupt) await fs.promises.rename(filePath, `${filePath}.corrupt-${Date.now()}`)
        const key = keyOf(runId, batch)
        const next = rows.filter((r) => r.key !== key)
        next.push({ key, sha: manifestSha256, root })
        await writeFileAtomic(filePath, JSON.stringify({ version: 1, rows: next.slice(-maxRows) }), { mode: 0o600 })
      }),
    lookup: (runId, batch) =>
      serial(async () => {
        const { rows } = await load()
        return rows.find((r) => r.key === keyOf(runId, batch))?.sha
      })
  }
}

/** Loaded lazily: `electron` is not available when this module is merely imported. */
let instance: Promise<SnapshotLedger> | undefined

export function getSnapshotLedger(): SnapshotLedger {
  const load = (): Promise<SnapshotLedger> => {
    instance ??= import('electron').then(({ app }) =>
      createFileSnapshotLedger(path.join(app.getPath('userData'), 'coding-snapshots.json'))
    )
    return instance
  }
  return {
    async record(root, runId, batch, sha) {
      return (await load()).record(root, runId, batch, sha)
    },
    async lookup(runId, batch) {
      return (await load()).lookup(runId, batch)
    }
  }
}
