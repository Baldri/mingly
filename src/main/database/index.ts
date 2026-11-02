import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import path from 'path'
import fs from 'fs'
import { createLogger } from '../../shared/logger'

const log = createLogger('Database')

/**
 * Tenant that owns all data of a single-tenant installation.
 * Migration 11 stores this value as the column default of every tenant_id,
 * so it must never change once a database has been migrated.
 */
export const DEFAULT_TENANT_ID = 'default'

let db: SqlJsDatabase | null = null
let dbPath: string = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Resolve the data directory.
 * In Electron: uses app.getPath('userData').
 * In headless server mode: uses the provided dataDir parameter or ./data fallback.
 */
function resolveDataDir(dataDir?: string): string {
  if (dataDir) return dataDir
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron')
    return app.getPath('userData')
  } catch {
    return path.join(process.cwd(), 'data')
  }
}

/**
 * Initialize the database using sql.js (WASM-based, no native modules).
 * Must be called once during app startup before any database operations.
 *
 * @param dataDir Optional data directory override. If omitted, uses Electron
 *                userData (desktop) or ./data (headless server).
 */
export async function initializeDatabase(dataDir?: string): Promise<void> {
  if (db) return

  const userDataPath = resolveDataDir(dataDir)
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true })
  }

  dbPath = path.join(userDataPath, 'mingly.db')

  log.info('Initializing sql.js database', { path: dbPath })

  // Locate the WASM binary shipped with sql.js
  const sqlJsDir = path.dirname(require.resolve('sql.js'))

  const SQL = await initSqlJs({
    locateFile: () => path.join(sqlJsDir, 'sql-wasm.wasm')
  })

  // Load existing database file if it exists
  if (fs.existsSync(dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(dbPath)
      db = new SQL.Database(fileBuffer)
      log.info('Loaded existing database from disk')
    } catch (err) {
      log.error('Failed to load database file, creating new', { error: String(err) })
      db = new SQL.Database()
    }
  } else {
    db = new SQL.Database()
    log.info('Created new database')
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON')

  // Run migrations
  runMigrations(db)

  // Save after migrations
  saveDatabase()
}

/**
 * Get the database instance. Throws if not initialized.
 */
export function getDatabase(): SqlJsDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.')
  }
  return db
}

/**
 * Save the database to disk. Debounced to avoid excessive writes.
 */
export function saveDatabase(): void {
  if (!db) return

  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (err) {
    log.error('Failed to save database', { error: String(err) })
  }
}

/**
 * Schedule a debounced save (100ms). Use after write operations.
 */
export function scheduleSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveDatabase()
    saveTimer = null
  }, 100)
}

/**
 * Close the database and save to disk.
 */
export function closeDatabase(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }

  if (db) {
    saveDatabase()
    db.close()
    db = null
    log.info('Database closed and saved')
  }
}

// ── Helper functions for sql.js ──────────────────────────────────

/**
 * Execute a SQL statement with parameters and return no results.
 * Schedules a save after the operation.
 */
export function dbRun(sql: string, params: any[] = []): void {
  const database = getDatabase()
  database.run(sql, params)
  scheduleSave()
}

/**
 * Execute a SQL query and return all matching rows as objects.
 */
export function dbAll(sql: string, params: any[] = []): Record<string, any>[] {
  const database = getDatabase()
  const stmt = database.prepare(sql)

  if (params.length > 0) {
    stmt.bind(params)
  }

  const results: Record<string, any>[] = []
  while (stmt.step()) {
    results.push(stmt.getAsObject())
  }
  stmt.free()

  return results
}

/**
 * Execute a SQL query and return the first matching row as an object, or null.
 */
export function dbGet(sql: string, params: any[] = []): Record<string, any> | null {
  const database = getDatabase()
  const stmt = database.prepare(sql)

  if (params.length > 0) {
    stmt.bind(params)
  }

  let result: Record<string, any> | null = null
  if (stmt.step()) {
    result = stmt.getAsObject()
  }
  stmt.free()

  return result
}

// ── Migrations ───────────────────────────────────────────────────

export function getSchemaVersion(database: SqlJsDatabase): number {
  // Use a metadata table instead of PRAGMA user_version (more reliable in sql.js)
  try {
    const stmt = database.prepare('SELECT value FROM _meta WHERE key = ?')
    stmt.bind(['schema_version'])
    let version = 0
    if (stmt.step()) {
      const row = stmt.getAsObject()
      version = Number(row.value)
    }
    stmt.free()
    return version
  } catch {
    // _meta table doesn't exist yet
    return 0
  }
}

function setSchemaVersion(database: SqlJsDatabase, version: number): void {
  database.run(
    'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)',
    ['schema_version', String(version)]
  )
}

function runMigrations(database: SqlJsDatabase): void {
  // Ensure _meta table exists
  database.run(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  const version = getSchemaVersion(database)
  log.info('Database schema version', { version })

  if (version < 1) {
    log.info('Running migration 1: Create core tables')
    migration1(database)
    setSchemaVersion(database, 1)
  }

  if (version < 2) {
    log.info('Running migration 2: Create tracking_events table')
    migration2(database)
    setSchemaVersion(database, 2)
  }

  if (version < 3) {
    log.info('Running migration 3: Create message_attachments table')
    migration3(database)
    setSchemaVersion(database, 3)
  }

  if (version < 4) {
    log.info('Running migration 4: Create prompt_templates table')
    migration4(database)
    setSchemaVersion(database, 4)
  }

  if (version < 5) {
    log.info('Running migration 5: Create comparison tables')
    migration5(database)
    setSchemaVersion(database, 5)
  }

  if (version < 6) {
    log.info('Running migration 6: Add billing_type column and conversation_costs view')
    migration6(database)
    setSchemaVersion(database, 6)
  }

  if (version < 7) {
    log.info('Running migration 7: Create conversation_sessions table')
    migration7(database)
    setSchemaVersion(database, 7)
  }

  if (version < 8) {
    log.info('Running migration 8: Create activity_log table')
    migration8(database)
    setSchemaVersion(database, 8)
  }

  if (version < 9) {
    log.info('Running migration 9: Add template_id to conversations')
    migration9(database)
    setSchemaVersion(database, 9)
  }

  if (version < 10) {
    log.info('Running migration 10: Add project_id and rag_collection_name to conversations')
    migration10(database)
    setSchemaVersion(database, 10)
  }

  if (version < 11) {
    log.info('Running migration 11: Add tenant_id to all tables')
    migration11(database)
    setSchemaVersion(database, 11)
  }

  if (version < 12) {
    log.info('Running migration 12: Create transcription_jobs and transcription_segments tables')
    migration12(database)
    setSchemaVersion(database, 12)
  }

  if (version < 13) {
    log.info('Running migration 13: Create transcription_retention table and job retention columns')
    migration13(database)
    setSchemaVersion(database, 13)
  }

  if (version < 14) {
    log.info('Running migration 14: Drop the tenant_id column default on the transcription tables')
    migration14(database)
    setSchemaVersion(database, 14)
  }
}

function migration1(database: SqlJsDatabase): void {
  // Conversations table
  database.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Messages table
  database.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `)

  // Index for faster message lookups
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at)
  `)

  // Settings table
  database.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  log.info('Migration 1 completed: core tables created')
}

function migration2(database: SqlJsDatabase): void {
  // Tracking events table for analytics
  database.run(`
    CREATE TABLE IF NOT EXISTS tracking_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      input_cost REAL NOT NULL DEFAULT 0,
      output_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      rag_used INTEGER NOT NULL DEFAULT 0,
      rag_source_count INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at INTEGER NOT NULL
    )
  `)

  // Indexes for common queries
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_tracking_created
    ON tracking_events(created_at)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_tracking_conversation
    ON tracking_events(conversation_id)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_tracking_provider
    ON tracking_events(provider, created_at)
  `)

  log.info('Migration 2 completed: tracking_events table created')
}

function migration3(database: SqlJsDatabase): void {
  // Image and file attachments for multimodal messages
  database.run(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'image',
      mime_type TEXT NOT NULL,
      data TEXT NOT NULL,
      filename TEXT,
      width INTEGER,
      height INTEGER,
      original_size INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_attachments_message
    ON message_attachments(message_id)
  `)

  log.info('Migration 3 completed: message_attachments table created')
}

function migration4(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'custom',
      variables TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_templates_category
    ON prompt_templates(category)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_templates_favorite
    ON prompt_templates(is_favorite)
  `)

  log.info('Migration 4 completed: prompt_templates table created')
}

function migration5(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS comparison_sessions (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      models TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS comparison_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      response TEXT NOT NULL,
      tokens INTEGER,
      cost REAL,
      latency_ms INTEGER,
      is_winner INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES comparison_sessions(id) ON DELETE CASCADE
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_comparison_results_session
    ON comparison_results(session_id)
  `)

  log.info('Migration 5 completed: comparison tables created')
}

function migration6(database: SqlJsDatabase): void {
  // Add billing_type column to tracking_events (api | subscription | free)
  addColumnIfMissing(database, 'tracking_events', 'billing_type', "TEXT NOT NULL DEFAULT 'api'")

  // Create a convenience view that aggregates costs per conversation
  database.run(`
    CREATE VIEW IF NOT EXISTS conversation_costs AS
    SELECT
      conversation_id,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(total_cost) as total_cost,
      COUNT(*) as message_count,
      MIN(created_at) as first_message,
      MAX(created_at) as last_message
    FROM tracking_events
    GROUP BY conversation_id
  `)

  log.info('Migration 6 completed: billing_type column and conversation_costs view created')
}

function migration7(database: SqlJsDatabase): void {
  // Session state persistence for provider-specific data (thread IDs, etc.)
  database.run(`
    CREATE TABLE IF NOT EXISTS conversation_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      session_params TEXT,
      session_display_id TEXT,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id, provider)
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_convsess_conversation
    ON conversation_sessions(conversation_id)
  `)

  log.info('Migration 7 completed: conversation_sessions table created')
}

function migration8(database: SqlJsDatabase): void {
  // Activity log for audit trail (Phase 4.1 — shared interface)
  database.run(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL DEFAULT 'local',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_action
    ON activity_log(action)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_entity
    ON activity_log(entity_type, entity_id)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_created
    ON activity_log(created_at)
  `)

  log.info('Migration 8 completed: activity_log table created')
}

function migration9(database: SqlJsDatabase): void {
  // Add template_id to conversations for prompt template association
  addColumnIfMissing(database, 'conversations', 'template_id', 'TEXT')

  log.info('Migration 9 completed: template_id column added to conversations')
}

function migration10(database: SqlJsDatabase): void {
  // Link conversations to RAG-Wissen projects for per-conversation context injection
  addColumnIfMissing(database, 'conversations', 'project_id', 'TEXT')
  addColumnIfMissing(database, 'conversations', 'rag_collection_name', 'TEXT')
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_conversations_project
    ON conversations(project_id)
  `)

  log.info('Migration 10 completed: project_id and rag_collection_name added to conversations')
}

function migration11(database: SqlJsDatabase): void {
  // Every row belongs to a tenant so the product can later run multi-tenant
  // without a data migration per customer. `_meta` is excluded on purpose:
  // it holds schema metadata, not user data.
  const tenantTables = [
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
  ]

  // The column default (not NULL) assigns existing rows to the default tenant,
  // so legacy data never ends up without an owner or with a foreign one.
  for (const table of tenantTables) {
    addColumnIfMissing(
      database,
      table,
      'tenant_id',
      `TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`
    )
  }

  log.info('Migration 11 completed: tenant_id column added to all tables')
}

function migration12(database: SqlJsDatabase): void {
  // Transcription jobs. tenant_id follows the migration-11 convention (same
  // column definition), so the "every table carries a tenant" rule holds for
  // tables created after it as well.
  database.run(`
    CREATE TABLE IF NOT EXISTS transcription_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
      workspace_id TEXT NOT NULL,
      audio_path TEXT NOT NULL,
      state TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      target_id TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Serves listByState: one tenant, one state, oldest first
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_transcription_jobs_state
    ON transcription_jobs(tenant_id, state, created_at)
  `)

  // `segment_index` instead of `index`, which is a reserved SQL word.
  // The foreign key is declared like the ones on messages and attachments, but
  // is NOT enforced at runtime: sql.js resets PRAGMA foreign_keys to 0 on every
  // export(), i.e. on every saveDatabase(). Whoever deletes a job must delete
  // its segments explicitly; the cascade only applies once enforcement is on.
  database.run(`
    CREATE TABLE IF NOT EXISTS transcription_segments (
      job_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
      segment_index INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (job_id, segment_index),
      FOREIGN KEY (job_id) REFERENCES transcription_jobs(id) ON DELETE CASCADE
    )
  `)

  log.info('Migration 12 completed: transcription_jobs and transcription_segments tables created')
}

function migration13(database: SqlJsDatabase): void {
  // Retention periods per workspace, in a table of their own rather than in
  // `settings`: that table's PRIMARY KEY is `key` alone, so it is global. A
  // tenant_id column would not make a key unique per tenant, and two tenants
  // holding the same key would collide on the primary key.
  //
  // The primary key is (tenant_id, workspace_id), so one workspace of one
  // tenant has exactly one pair of periods, and an UPSERT cannot grow a second
  // row for it.
  database.run(`
    CREATE TABLE IF NOT EXISTS transcription_retention (
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
      workspace_id TEXT NOT NULL,
      audio_days INTEGER NOT NULL,
      transcript_days INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id)
    )
  `)

  // When the audio of this job was removed by the retention run, NULL while it
  // is still there. Without it the two periods cannot run apart: a job whose
  // audio has expired but whose transcript has not would be found again by
  // every later run, and the count it returns would be a lie. The file system
  // is not that marker - a file can be missing for reasons the retention run
  // did not cause, and a missing file must not count as a deletion for ever.
  addColumnIfMissing(database, 'transcription_jobs', 'audio_deleted_at', 'INTEGER')

  // How often this job has been handed to the service. UNUSED in this
  // migration's task - the column exists so that the cap can be wired without a
  // second migration. The reason it is needed: the runner's in-memory `tracked`
  // entry is dropped on requeue, i.e. exactly on the retry, so nothing counts
  // attempts today, and a job with a permanently wrong configuration repeats
  // without end - with a database write per job per pass, every five seconds.
  addColumnIfMissing(database, 'transcription_jobs', 'attempts', 'INTEGER NOT NULL DEFAULT 0')

  log.info('Migration 13 completed: transcription_retention table and job retention columns added')
}

/**
 * Take the column default off `tenant_id` on the three transcription tables.
 *
 * Migrations 12 and 13 gave the column `DEFAULT '<default tenant>'`, following
 * migration 11, which needed one: it added the column to tables that already
 * held rows, and the default is what assigned those rows an owner. A table
 * created WITH the column never had that problem, and the default only hides a
 * caller that forgot the tenant - it silently files the row under the default
 * tenant instead of failing. Without it, `NOT NULL` makes that caller fail
 * loudly, which is the point.
 *
 * Why a migration of its own rather than an edit to 12 and 13: a migration is a
 * snapshot. Editing one in place would leave two installations that both report
 * schema version 13 with different schemas - including Holger's own database,
 * which a packaged build has already migrated.
 *
 * SQLite cannot drop a default in place, so each table is rebuilt.
 */
function migration14(database: SqlJsDatabase): void {
  // Foreign keys MUST be off while a parent table is dropped. `initializeDatabase`
  // turns them ON immediately before `runMigrations`, and `DROP TABLE
  // transcription_jobs` then performs an implicit DELETE that the ON DELETE
  // CASCADE on `transcription_segments` follows. Measured on this sql.js
  // (2026-10-28): with the pragma on, dropping the parent left 0 of 1 segments;
  // with it off, 1 of 1. A rebuild that forgets this deletes every transcript
  // in the installation.
  const hadForeignKeys = foreignKeysEnabled(database)
  database.run('PRAGMA foreign_keys = OFF')

  try {
    rebuildTable(
      database,
      'transcription_jobs',
      `CREATE TABLE transcription_jobs_new (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        audio_path TEXT NOT NULL,
        state TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        target_id TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        audio_deleted_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0
      )`,
      'id, tenant_id, workspace_id, audio_path, state, progress, target_id, error, ' +
        'created_at, updated_at, audio_deleted_at, attempts'
    )

    // The index went with the old table.
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_transcription_jobs_state
      ON transcription_jobs(tenant_id, state, created_at)
    `)

    rebuildTable(
      database,
      'transcription_segments',
      `CREATE TABLE transcription_segments_new (
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (job_id, segment_index),
        FOREIGN KEY (job_id) REFERENCES transcription_jobs(id) ON DELETE CASCADE
      )`,
      'job_id, tenant_id, segment_index, start_ms, end_ms, speaker, text'
    )

    rebuildTable(
      database,
      'transcription_retention',
      `CREATE TABLE transcription_retention_new (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        audio_days INTEGER NOT NULL,
        transcript_days INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id)
      )`,
      'tenant_id, workspace_id, audio_days, transcript_days'
    )
  } finally {
    database.run(`PRAGMA foreign_keys = ${hadForeignKeys ? 'ON' : 'OFF'}`)
  }

  log.info('Migration 14 completed: tenant_id default dropped on the transcription tables')
}

/** Whether foreign key enforcement is on right now. */
function foreignKeysEnabled(database: SqlJsDatabase): boolean {
  const stmt = database.prepare('PRAGMA foreign_keys')
  let enabled = false
  if (stmt.step()) enabled = Number(stmt.getAsObject().foreign_keys) === 1
  stmt.free()
  return enabled
}

/**
 * Rebuild one table under a new definition, carrying its rows across.
 *
 * Repeatable like the rest of the migrations: the scratch table is dropped
 * first, so a run that died halfway does not block the next one, and rebuilding
 * an already rebuilt table is a no-op in effect. The column list is written out
 * on both sides rather than relying on `SELECT *`, so a future column added to
 * one side and not the other fails here instead of shifting values silently.
 *
 * The caller is responsible for foreign keys being OFF and for recreating any
 * index, both of which go with the dropped table.
 */
function rebuildTable(
  database: SqlJsDatabase,
  table: string,
  createScratch: string,
  columns: string
): void {
  database.run(`DROP TABLE IF EXISTS ${table}_new`)
  database.run(createScratch)
  database.run(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`)
  database.run(`DROP TABLE ${table}`)
  database.run(`ALTER TABLE ${table}_new RENAME TO ${table}`)
}

/**
 * Add a column only if the table does not have it yet.
 *
 * `CREATE TABLE IF NOT EXISTS` makes a migration repeatable; `ALTER TABLE ADD
 * COLUMN` does not, and migrations run here WITHOUT an enclosing transaction.
 * A migration that fails after its first ALTER therefore leaves the schema
 * half applied and its version unwritten - and the next start replays it and
 * dies on "duplicate column name", with no way out from inside the app. The
 * column list is read instead of assumed, because that is the state the
 * decision depends on.
 */
function addColumnIfMissing(
  database: SqlJsDatabase,
  table: string,
  column: string,
  definition: string
): void {
  const stmt = database.prepare(`PRAGMA table_info(${table})`)
  let present = false
  while (stmt.step()) {
    if (stmt.getAsObject().name === column) present = true
  }
  stmt.free()

  if (present) {
    log.info('Column already present, skipping ALTER', { table, column })
    return
  }

  database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
