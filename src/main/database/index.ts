import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import path from 'path'
import fs from 'fs'
import { createLogger } from '../../shared/logger'

const log = createLogger('Database')

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

function getSchemaVersion(database: SqlJsDatabase): number {
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
