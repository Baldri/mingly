#!/usr/bin/env node
/**
 * Mingly Server — Headless Node.js Entry Point
 *
 * Runs the Mingly API server without Electron, exposing the same
 * REST + WebSocket API as the desktop app's server mode.
 *
 * Configuration via environment variables:
 *   MINGLY_PORT         HTTP port (default: 3939)
 *   MINGLY_HOST         Bind address (default: 0.0.0.0)
 *   MINGLY_DATA_DIR     Database & storage directory (default: ./data)
 *   MINGLY_REQUIRE_AUTH Require API key (default: false)
 *   MINGLY_API_KEY      Server API key (required if auth enabled)
 *   MINGLY_LOG_LEVEL    Log level: debug|info|warn|error (default: info)
 *
 * Or via mingly-server.config.json in the working directory.
 */

import path from 'path'
import fs from 'fs'
import { initializeDatabase, closeDatabase } from '../main/database'
import { MinglyAPIServer } from '../main/server/mingly-api-server'
import type { MinglyServerConfig } from '../shared/deployment-types'
import { configureLogger, createLogger } from '../shared/logger'
import type { LogLevel } from '../shared/logger'

// ── Version ──────────────────────────────────────────────────────
const packageJsonPath = path.resolve(__dirname, '../../package.json')
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
const VERSION = pkg.version || '0.1.0'

const log = createLogger('Server')

// ── Configuration ────────────────────────────────────────────────

interface ServerEnvConfig {
  port: number
  host: string
  dataDir: string
  requireAuth: boolean
  apiKey?: string
  logLevel: string
}

function loadConfig(): ServerEnvConfig {
  // 1. Defaults
  const config: ServerEnvConfig = {
    port: 3939,
    host: '0.0.0.0',
    dataDir: path.resolve(process.cwd(), 'data'),
    requireAuth: false,
    logLevel: 'info',
  }

  // 2. Config file (optional)
  const configPath = path.resolve(process.cwd(), 'mingly-server.config.json')
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (fileConfig.port) config.port = Number(fileConfig.port)
      if (fileConfig.host) config.host = String(fileConfig.host)
      if (fileConfig.dataDir) config.dataDir = path.resolve(fileConfig.dataDir)
      if (fileConfig.requireAuth !== undefined) config.requireAuth = Boolean(fileConfig.requireAuth)
      if (fileConfig.apiKey) config.apiKey = String(fileConfig.apiKey)
      if (fileConfig.logLevel) config.logLevel = String(fileConfig.logLevel)
      log.info('Config loaded from file', { path: configPath })
    } catch (err) {
      log.warn('Failed to parse config file', { path: configPath, error: String(err) })
    }
  }

  // 3. Environment variables (override config file)
  if (process.env.MINGLY_PORT) config.port = Number(process.env.MINGLY_PORT)
  if (process.env.MINGLY_HOST) config.host = process.env.MINGLY_HOST
  if (process.env.MINGLY_DATA_DIR) config.dataDir = path.resolve(process.env.MINGLY_DATA_DIR)
  if (process.env.MINGLY_REQUIRE_AUTH) config.requireAuth = process.env.MINGLY_REQUIRE_AUTH === 'true'
  if (process.env.MINGLY_API_KEY) config.apiKey = process.env.MINGLY_API_KEY
  if (process.env.MINGLY_LOG_LEVEL) config.logLevel = process.env.MINGLY_LOG_LEVEL

  return config
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig()

  // Configure logger: JSON mode in production, human-readable in dev
  const logLevel = config.logLevel as LogLevel
  configureLogger({
    level: logLevel,
    json: process.env.NODE_ENV === 'production',
  })

  // Banner (always human-readable on stdout)
  console.log('')
  console.log('  ╔══════════════════════════════════════╗')
  console.log('  ║         Mingly Server v' + VERSION.padEnd(14) + '║')
  console.log('  ║   Multi-LLM API Server (Headless)    ║')
  console.log('  ╚══════════════════════════════════════╝')
  console.log('')
  console.log(`  Port:      ${config.port}`)
  console.log(`  Host:      ${config.host}`)
  console.log(`  Data:      ${config.dataDir}`)
  console.log(`  Auth:      ${config.requireAuth ? 'required' : 'disabled'}`)
  console.log(`  Log Level: ${config.logLevel}`)
  console.log('')

  // 1. Initialize database
  log.info('Initializing database...')
  await initializeDatabase(config.dataDir)
  log.info('Database ready')

  // 2. Create and start API server
  const serverConfig: MinglyServerConfig = {
    port: config.port,
    host: config.host,
    requireAuth: config.requireAuth,
    apiKey: config.apiKey,
    enableWebSocket: true,
    maxSessions: 50,
    corsOrigins: ['*'],
    enableDiscovery: false,
    serverName: `Mingly Server v${VERSION}`,
  }

  const apiServer = new MinglyAPIServer(serverConfig)
  await apiServer.start()

  log.info('Mingly Server is running', {
    rest: `http://${config.host}:${config.port}`,
    ws: `ws://${config.host}:${config.port}/ws`,
    health: `http://${config.host}:${config.port}/health`,
  })

  // 3. Graceful shutdown
  let isShuttingDown = false
  async function shutdown(signal: string) {
    if (isShuttingDown) return
    isShuttingDown = true
    log.info('Shutting down gracefully', { signal })

    try {
      await apiServer.stop()
      log.info('API server stopped')
    } catch (err) {
      log.error('Error stopping API server', { error: String(err) })
    }

    try {
      closeDatabase()
      log.info('Database closed')
    } catch (err) {
      log.error('Error closing database', { error: String(err) })
    }

    log.info('Goodbye')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: String(err), stack: err.stack })
  })
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) })
  })
}

main().catch((err) => {
  log.error('Fatal startup error', { error: String(err), stack: err instanceof Error ? err.stack : undefined })
  process.exit(1)
})
