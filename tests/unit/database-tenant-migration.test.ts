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
