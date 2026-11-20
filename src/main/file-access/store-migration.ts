/**
 * One-time migration of the two stores that are keyed by a directory id.
 *
 * The id used to cover only the first twelve bytes of the path (see
 * directory-id.ts), so the two files on disk hold keys that no longer match
 * what `directoryId` produces. The two files are NOT treated alike, and that is
 * the decision, not an oversight:
 *
 *  - `file-access.json` is RE-KEYED. Every entry carries its own `path`, so the
 *    new id is computable from the entry itself. A grant that an id collision
 *    once overwrote is not in the file at all (the Map only ever wrote its own
 *    values), so there is nothing to recover — only to re-key.
 *
 *  - `coding-modes.json` is DISCARDED. Its keys ARE the ambiguous id, so a
 *    stored `propose-run` belonged to whichever of the colliding projects was
 *    granted last, and which one that was can no longer be established. The
 *    mapping is not lost, it was never recorded. Carrying one over could give
 *    `propose-run` to a project the user never graded, which is exactly the
 *    case the fail-closed rule exists for: unknown value, take the stricter
 *    side. Everything falls back to `off` and the user grades again — a visible,
 *    small price against an invisible, large one.
 *
 * Properties, in the order they matter:
 *
 *  - IDEMPOTENT. Re-keying is deterministic, so a second run finds the ids it
 *    would compute and writes nothing. The discard is the one step that is not
 *    self-idempotent (it would eat a mode chosen after the migration), so
 *    coding-modes.json carries a schema version and the step is skipped once
 *    that version is there.
 *  - TEMP-AND-RENAME, via writeFileAtomicSync. Not SimpleStore.set: that writes
 *    in place, so an interruption can leave a half file that parses as an empty
 *    store — which for this file means every grant gone — and it swallows write
 *    errors, so it cannot tell us the write landed.
 *  - AN INTERRUPTION IS COMPLETABLE. Each file is replaced atomically and the
 *    two are independent, so a crash leaves each of them entirely old or
 *    entirely new, in any combination, and the next start finishes whatever is
 *    still old. No state exists that a later start cannot read.
 *  - A DAMAGED FILE IS MOVED ASIDE, never overwritten (the pattern
 *    snapshot-ledger.ts already uses). SimpleStore would read it as an empty
 *    store and destroy it with the first save; this way the user still has it.
 *
 * Nothing here throws. It runs from the FileAccessManager constructor, where a
 * throw makes getFileAccessManager() fail at start-up with no recovery but
 * deleting a file by hand. A failure is logged, and correctness does not depend
 * on it: loadAllowedDirectories re-keys its in-memory Map anyway, and the
 * coding mode store ignores a file that does not declare the schema version.
 */

import * as fs from 'fs'
import * as path from 'path'
import { writeFileAtomicSync } from '../coding/atomic-write'
import { currentDirectoryId } from './directory-id'

const FILE_ACCESS_FILE = 'file-access.json'
const CODING_MODES_FILE = 'coding-modes.json'

/** The keys of file-access.json that hold grants keyed by directory id. */
const GRANT_KEYS = ['allowedDirectories', 'unconfirmedDirectories'] as const

/**
 * The version coding-modes.json declares once its ambiguous keys are gone.
 *
 * Exported because the mode store reads the same marker: the discard has to
 * hold even if this migration could never write (a read-only userData, a full
 * disk), and a reader that ignores an unversioned file holds it unconditionally.
 */
export const CODING_MODES_SCHEMA_VERSION = 2
const SCHEMA_VERSION_KEY = 'schemaVersion'
const MODES_KEY = 'modes'

type Store = Record<string, unknown>

function isPlainRecord(value: unknown): value is Store {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep a file this app cannot parse, under a name nothing reads. */
function setAside(file: string): void {
  const kept = `${file}.corrupt-${Date.now()}`
  try {
    fs.renameSync(file, kept)
    console.warn(`📁 ⚠️ ${path.basename(file)} could not be read; kept as ${path.basename(kept)}`)
  } catch {
    // It stays where it is. The store that owns it reads it as empty, which is
    // the strict side for both of these files.
  }
}

/**
 * The store in `file`, or null when there is nothing to migrate: the file is
 * absent, unreadable, or damaged and now moved aside.
 */
function readStore(file: string): Store | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    // Absent is nothing to do. Anything else (no permission, a directory where
    // the file belongs) is left exactly as it is: the store that owns it reads
    // it next and fails the same way, which is an empty store.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`📁 ⚠️ Could not read ${path.basename(file)} for migration`)
    }
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!isPlainRecord(parsed)) {
    setAside(file)
    return null
  }
  return parsed
}

/**
 * One grant under its new id, or the entry itself when there is nothing to do.
 * Which entries those are is decided in currentDirectoryId, the one place the
 * loader and this migration both read.
 */
function rekeyGrant(entry: unknown): unknown {
  if (!isPlainRecord(entry)) return entry
  const id = currentDirectoryId(entry)
  return id === null ? entry : { ...entry, id }
}

function migrateGrants(file: string): void {
  const store = readStore(file)
  if (store === null) return

  let changed = false
  for (const key of GRANT_KEYS) {
    const list = store[key]
    if (!Array.isArray(list)) continue
    store[key] = list.map((entry) => {
      const next = rekeyGrant(entry)
      if (next !== entry) changed = true
      return next
    })
  }
  // Nothing to write is the idempotent case: the ids on disk are already the
  // ones directoryId produces.
  if (!changed) return

  writeFileAtomicSync(file, JSON.stringify(store, null, 2))
  console.log(`📁 Migrated the directory ids in ${path.basename(file)}`)
}

function discardCodingModes(file: string): void {
  const store = readStore(file)
  if (store === null) return

  const version = store[SCHEMA_VERSION_KEY]
  if (typeof version === 'number' && version >= CODING_MODES_SCHEMA_VERSION) return

  delete store[MODES_KEY]
  store[SCHEMA_VERSION_KEY] = CODING_MODES_SCHEMA_VERSION
  writeFileAtomicSync(file, JSON.stringify(store, null, 2))
  console.log('📁 Discarded the coding modes stored under the ambiguous directory ids')
}

/**
 * Migrate both stores in `userDataDir`. Safe to call more than once and from
 * more than one place; the order of the two files does not matter.
 */
export function migrateDirectoryIdStores(userDataDir: string): void {
  for (const [file, migrate] of [
    [FILE_ACCESS_FILE, migrateGrants],
    [CODING_MODES_FILE, discardCodingModes]
  ] as const) {
    try {
      migrate(path.join(userDataDir, file))
    } catch (error) {
      // Logged, not thrown: see the file header. Both stores are correct in
      // this session without the rewrite.
      console.error(`📁 ❌ Migration of ${file} failed:`, error)
    }
  }
}
