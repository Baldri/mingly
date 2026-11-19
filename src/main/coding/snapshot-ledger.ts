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

/** Loaded lazily: SimpleStore pulls in electron. */
let instance: Promise<SnapshotLedger> | undefined

export function getSnapshotLedger(): SnapshotLedger {
  const load = (): Promise<SnapshotLedger> => {
    instance ??= import('../utils/simple-store').then(({ SimpleStore }) =>
      createSnapshotLedger(SimpleStore.create('coding-snapshots.json'))
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
