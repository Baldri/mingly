/**
 * Tenant column migration tests.
 * Uses a real sql.js database in a temp directory (no mocks) so the migration
 * and the upgrade path of an existing database file are actually executed.
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
  dbAll,
  dbGet,
  DEFAULT_TENANT_ID
} from '../../src/main/database/index'
import { configureLogger } from '../../src/shared/logger'

// All business tables. `_meta` holds schema metadata, not user data, and is
// deliberately excluded.
const TENANT_TABLES = [
  'conversations',
  'messages',
  'settings',
  'tracking_events',
  'message_attachments',
  'prompt_templates',
  'comparison_sessions',
  'comparison_results',
  'conversation_sessions',
  'activity_log'
] as const

// First migration that adds tenant_id. Later migrations raise the version
// further, so tests assert "at least" instead of pinning the latest version.
const TENANT_MIGRATION_VERSION = 11

interface TableInfoRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function tableInfo(table: string): TableInfoRow[] {
  return dbAll(`PRAGMA table_info(${table})`) as TableInfoRow[]
}

describe('tenant_id migration', () => {
  let tmpDir: string

  beforeAll(() => {
    // Migration progress is logged at info level; keep the test output clean
    configureLogger({ level: 'error' })
  })

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-tenant-'))
  })

  afterEach(() => {
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('legt tenant_id auf allen Tabellen an', async () => {
    await initializeDatabase(tmpDir)

    for (const table of TENANT_TABLES) {
      const cols = tableInfo(table)
      expect(cols.map(c => c.name), table).toContain('tenant_id')
    }
  })

  it('definiert tenant_id als TEXT NOT NULL DEFAULT \'default\'', async () => {
    await initializeDatabase(tmpDir)

    for (const table of TENANT_TABLES) {
      const col = tableInfo(table).find(c => c.name === 'tenant_id')
      expect(col, table).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'default'" })
    }
  })

  it('lässt _meta ohne tenant_id (Schema-Metadaten, keine Nutzdaten)', async () => {
    await initializeDatabase(tmpDir)

    expect(tableInfo('_meta').map(c => c.name)).not.toContain('tenant_id')
  })

  it('exportiert den Default-Mandanten als \'default\'', () => {
    expect(DEFAULT_TENANT_ID).toBe('default')
  })

  it('ordnet Altdaten dem Default-Mandanten zu, nicht NULL', async () => {
    // Build a genuine pre-migration database: take the current schema, strip
    // tenant_id again, stamp schema_version 10, store a conversation and a
    // setting, and persist the file. The next initializeDatabase() then has to
    // upgrade it exactly like an installation from before this change.
    await initializeDatabase(tmpDir)
    const legacy = getDatabase()
    for (const table of TENANT_TABLES) {
      legacy.run(`ALTER TABLE ${table} DROP COLUMN tenant_id`)
    }
    legacy.run("UPDATE _meta SET value = '10' WHERE key = 'schema_version'")
    legacy.run(
      `INSERT INTO conversations (id, title, provider, model, created_at, updated_at)
       VALUES ('conv-old', 'Alt', 'anthropic', 'claude', 1, 1)`
    )
    legacy.run("INSERT INTO settings (key, value, updated_at) VALUES ('old-key', 'old-value', 1)")
    closeDatabase()

    await initializeDatabase(tmpDir)

    expect(getSchemaVersion(getDatabase())).toBeGreaterThanOrEqual(TENANT_MIGRATION_VERSION)
    expect(dbGet('SELECT tenant_id FROM conversations WHERE id = ?', ['conv-old'])).toEqual({
      tenant_id: 'default'
    })
    expect(dbGet('SELECT tenant_id FROM settings WHERE key = ?', ['old-key'])).toEqual({
      tenant_id: 'default'
    })
  })

  it('erhöht schema_version auf mindestens 11', async () => {
    await initializeDatabase(tmpDir)

    expect(getSchemaVersion(getDatabase())).toBeGreaterThanOrEqual(TENANT_MIGRATION_VERSION)
  })

  it('startet eine bereits migrierte Datenbank erneut ohne Fehler', async () => {
    await initializeDatabase(tmpDir)
    closeDatabase()

    await expect(initializeDatabase(tmpDir)).resolves.toBeUndefined()
    expect(tableInfo('conversations').map(c => c.name)).toContain('tenant_id')
  })
})

/**
 * The three transcription tables get the column WITHOUT a default (migration 14).
 *
 * Migration 11 needed one: it added `tenant_id` to tables that already held
 * rows, and the default is what gave those rows an owner. A table created with
 * the column never had that problem, so there the default only hides a caller
 * who forgot the tenant - it files the row under the default tenant instead of
 * failing. That asymmetry is deliberate and is pinned in both directions here.
 */
describe('tenant_id auf den Transkriptions-Tabellen', () => {
  const TRANSCRIPTION_TABLES = [
    'transcription_jobs',
    'transcription_segments',
    'transcription_retention'
  ] as const

  let tmpDir: string

  beforeAll(() => {
    configureLogger({ level: 'error' })
  })

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-tenant-new-'))
  })

  afterEach(() => {
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('legt tenant_id ohne Vorgabewert an', async () => {
    await initializeDatabase(tmpDir)

    for (const table of TRANSCRIPTION_TABLES) {
      const col = tableInfo(table).find(c => c.name === 'tenant_id')
      expect(col, table).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: null })
    }

    // Positive control in the same run: the tables from migration 11 KEEP their
    // default. Without this a green run could also mean "no table has one".
    expect(tableInfo('conversations').find(c => c.name === 'tenant_id')).toMatchObject({
      dflt_value: `'${DEFAULT_TENANT_ID}'`
    })
  })

  it('weist ein Einfuegen ohne Mandant zurueck, statt es dem Vorgabe-Mandanten zuzuschlagen', async () => {
    await initializeDatabase(tmpDir)
    const db = getDatabase()

    expect(() =>
      db.run(`INSERT INTO transcription_jobs
        (id, workspace_id, audio_path, state, target_id, created_at, updated_at)
        VALUES ('ohne', 'ws1', '/a.wav', 'queued', 'local', 1, 1)`)
    ).toThrow()

    // Positive control in the same run: with a tenant the very same insert works.
    db.run(`INSERT INTO transcription_jobs
      (id, tenant_id, workspace_id, audio_path, state, target_id, created_at, updated_at)
      VALUES ('mit', 'mandant-a', 'ws1', '/a.wav', 'queued', 'local', 1, 1)`)
    expect(dbGet('SELECT tenant_id FROM transcription_jobs WHERE id = ?', ['mit'])).toEqual({
      tenant_id: 'mandant-a'
    })
  })

  it('traegt Auftraege UND Segmente durch den Umbau', async () => {
    // The rebuild drops the parent table. `initializeDatabase` turns foreign
    // keys ON right before the migrations run, and the cascade on
    // `transcription_segments` follows that implicit DELETE - so a rebuild that
    // does not switch them off deletes every transcript. This test is what
    // stands between that and a release.
    await initializeDatabase(tmpDir)
    const seeded = getDatabase()
    seeded.run(`INSERT INTO transcription_jobs
      (id, tenant_id, workspace_id, audio_path, state, target_id, created_at, updated_at)
      VALUES ('job-1', 'mandant-a', 'ws1', '/a.wav', 'done', 'local', 1, 2)`)
    seeded.run(`INSERT INTO transcription_segments
      (job_id, tenant_id, segment_index, start_ms, end_ms, speaker, text)
      VALUES ('job-1', 'mandant-a', 0, 0, 1000, 'SPEAKER_00', 'Streng vertraulicher Satz')`)
    // Back to the state before migration 14, so it runs again on real data.
    seeded.run("UPDATE _meta SET value = '13' WHERE key = 'schema_version'")
    closeDatabase()

    await initializeDatabase(tmpDir)

    expect(dbAll('SELECT id, tenant_id FROM transcription_jobs')).toEqual([
      { id: 'job-1', tenant_id: 'mandant-a' }
    ])
    expect(dbAll('SELECT job_id, text FROM transcription_segments')).toEqual([
      { job_id: 'job-1', text: 'Streng vertraulicher Satz' }
    ])
    // The index went with the dropped table and has to be back.
    const indexes = dbAll("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transcription_jobs'")
    expect(indexes.map(r => r.name)).toContain('idx_transcription_jobs_state')
  })
})
