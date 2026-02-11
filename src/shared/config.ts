/**
 * Mingly Environment Configuration
 *
 * Centralizes environment detection and version reading.
 * Works in both Electron and headless Node.js contexts.
 */

import path from 'path'
import fs from 'fs'
import type { LogLevel } from './logger'

export interface MinglyConfig {
  /** true when NODE_ENV !== 'production' */
  isDevelopment: boolean
  /** true when NODE_ENV === 'production' */
  isProduction: boolean
  /** Semantic version from package.json */
  version: string
  /** Active log level */
  logLevel: LogLevel
  /** true when running inside Electron */
  isElectron: boolean
}

let cachedConfig: MinglyConfig | null = null

function readVersion(): string {
  try {
    // Works from dist/main, dist-server/server, or src/shared
    const candidates = [
      path.resolve(__dirname, '../../package.json'),
      path.resolve(__dirname, '../../../package.json'),
      path.resolve(process.cwd(), 'package.json'),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
        if (pkg.version) return pkg.version
      }
    }
  } catch {
    // ignore
  }
  return '0.0.0'
}

function detectElectron(): boolean {
  try {
    require('electron')
    return true
  } catch {
    return false
  }
}

function resolveLogLevel(): LogLevel {
  const env = process.env.MINGLY_LOG_LEVEL || process.env.LOG_LEVEL
  if (env && ['debug', 'info', 'warn', 'error'].includes(env)) {
    return env as LogLevel
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

/**
 * Get the application configuration. Cached after first call.
 */
export function getConfig(): MinglyConfig {
  if (cachedConfig) return cachedConfig

  const nodeEnv = process.env.NODE_ENV || 'development'

  cachedConfig = {
    isDevelopment: nodeEnv !== 'production',
    isProduction: nodeEnv === 'production',
    version: readVersion(),
    logLevel: resolveLogLevel(),
    isElectron: detectElectron(),
  }

  return cachedConfig
}

/**
 * Reset cached config (useful for testing).
 */
export function resetConfig(): void {
  cachedConfig = null
}
