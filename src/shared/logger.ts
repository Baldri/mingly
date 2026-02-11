/**
 * Mingly Structured Logger
 *
 * Provides consistent, leveled logging across Electron and headless server modes.
 * - Development: human-readable colored output
 * - Production/Server: JSON lines for log aggregation (ELK, Datadog, etc.)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = 'info'
let jsonMode = false

/**
 * Configure the logger. Call once at startup.
 */
export function configureLogger(options: {
  level?: LogLevel
  json?: boolean
}): void {
  if (options.level) currentLevel = options.level
  if (options.json !== undefined) jsonMode = options.json
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]
}

function formatTimestamp(): string {
  return new Date().toISOString()
}

function writeLog(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>
): void {
  if (!shouldLog(level)) return

  if (jsonMode) {
    const entry: Record<string, unknown> = {
      ts: formatTimestamp(),
      level,
      component,
      msg: message,
    }
    if (data) entry.data = data
    const line = JSON.stringify(entry)
    if (level === 'error') {
      process.stderr.write(line + '\n')
    } else {
      process.stdout.write(line + '\n')
    }
    return
  }

  // Human-readable format: [TIMESTAMP] [LEVEL] [Component] Message
  const tag = `[${formatTimestamp()}] [${level.toUpperCase().padEnd(5)}] [${component}]`
  const args: unknown[] = [tag, message]
  if (data) args.push(data)

  switch (level) {
    case 'debug':
      console.debug(...args)
      break
    case 'info':
      console.log(...args)
      break
    case 'warn':
      console.warn(...args)
      break
    case 'error':
      console.error(...args)
      break
  }
}

/**
 * Create a scoped logger for a specific component.
 *
 * @example
 * const log = createLogger('Database')
 * log.info('Connected', { path: dbPath })
 * log.error('Migration failed', { version: 3 })
 */
export function createLogger(component: string) {
  return {
    debug(message: string, data?: Record<string, unknown>) {
      writeLog('debug', component, message, data)
    },
    info(message: string, data?: Record<string, unknown>) {
      writeLog('info', component, message, data)
    },
    warn(message: string, data?: Record<string, unknown>) {
      writeLog('warn', component, message, data)
    },
    error(message: string, data?: Record<string, unknown>) {
      writeLog('error', component, message, data)
    },
  }
}
