/**
 * Migrations have to survive being replayed.
 *
 * `runMigrations` has no enclosing transaction and writes the schema version
 * only after the last statement of a step. A migration that fails partway
 * therefore leaves its columns behind and its version unwritten, so the next
 * start replays it — and `ALTER TABLE ... ADD COLUMN` is not repeatable. Before
 * this was fixed, the second run died on "duplicate column name" and the
 * database could not be opened again from inside the app at all.
 *
 * Measured 2026-10-27: every `CREATE` in the schema already carries
 * `IF NOT EXISTS`, so `ADD COLUMN` was the only statement that could not run
 * twice. Stamping the version back and re-initialising is the cheapest way to
 * exercise all of them at once.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  initializeDatabase,
  closeDatabase,
  getDatabase,
  getSchemaVersion,
  dbAll
} from '../../src/main/database/index'
import { configureLogger } from '../../src/shared/logger'

/** Every column that a migration adds with `ALTER TABLE ... ADD COLUMN`. */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string, number]> = [
  ['tracking_events', 'billing_type', 6],
  ['conversations', 'template_id', 9],
  ['conversations', 'project_id', 10],
  ['conversations', 'rag_collection_name', 10],
  ['conversations', 'tenant_id', 11],
  ['transcription_jobs', 'audio_deleted_at', 13],
  ['transcription_jobs', 'attempts', 13]
]

/** The first migration that adds a column; replaying from below it covers all. */
const BEFORE_FIRST_ADD_COLUMN = 5

function columnsOf(table: string): string[] {
  return (dbAll(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map(c => c.name)
}

describe('Wiederholbarkeit der Migrationen', () => {
  let tmpDir: string

  beforeAll(() => {
    configureLogger({ level: 'error' })
  })

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-replay-'))
  })

  afterEach(() => {
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('spielt alle Migrationen mit ADD COLUMN erneut ein, ohne zu scheitern', async () => {
    await initializeDatabase(tmpDir)

    // Positive control first: without it a green run could mean "the columns
    // were never there", which is the one way this test could lie.
    for (const [table, column] of ADDED_COLUMNS) {
      expect(columnsOf(table), `${table}.${column} vor dem erneuten Lauf`).toContain(column)
    }

    // The state a migration leaves behind when it dies after its first ALTER:
    // columns present, version not yet raised.
    getDatabase().run(
      `UPDATE _meta SET value = '${BEFORE_FIRST_ADD_COLUMN}' WHERE key = 'schema_version'`
    )
    closeDatabase()

    await expect(initializeDatabase(tmpDir)).resolves.toBeUndefined()

    for (const [table, column] of ADDED_COLUMNS) {
      const columns = columnsOf(table)
      expect(columns, `${table}.${column} nach dem erneuten Lauf`).toContain(column)
      // Exactly once: a replay that somehow appended a second column would be
      // just as broken as one that threw.
      expect(columns.filter(name => name === column), `${table}.${column} doppelt`).toHaveLength(1)
    }

    expect(getSchemaVersion(getDatabase())).toBeGreaterThanOrEqual(13)
  })

  it('startet eine unveraenderte Datenbank wiederholt ohne Fehler', async () => {
    // The ordinary path, as a control for the test above: nothing is stamped
    // back, so no migration replays and nothing may change.
    await initializeDatabase(tmpDir)
    const before = getSchemaVersion(getDatabase())
    closeDatabase()

    await expect(initializeDatabase(tmpDir)).resolves.toBeUndefined()
    expect(getSchemaVersion(getDatabase())).toBe(before)
  })
})
