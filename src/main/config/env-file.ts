/**
 * Minimal .env support for the Electron main process.
 *
 * Why this exists at all: nothing in the app loaded a .env file, so a
 * variable like INFOMANIAK_PRODUCT_ID was never set in a packaged,
 * GUI-launched build — and the Swiss endpoint simply failed to register,
 * without saying so.
 *
 * Deliberately hand-rolled rather than pulling in a dependency: the surface
 * needed here is KEY=value, comments and blank lines. Anything richer
 * (multi-line values, variable expansion) is not supported and would be a
 * reason to reach for a library instead of growing this file.
 *
 * This is the developer and power-user path. The durable home for end-user
 * configuration is the settings store — a .env file next to a packaged app is
 * something a user has to know about, not something the app offers.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'

/** Parse .env content. Malformed lines are skipped, never thrown on. */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const separator = line.indexOf('=')
    if (separator <= 0) continue

    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = line.slice(separator + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)

    result[key] = value
  }

  return result
}

/**
 * Apply the first readable candidate to process.env and return its path.
 *
 * An existing variable always wins. A .env left behind by an earlier install
 * must not be able to redirect a process that was started with an explicit
 * value — that would make the environment the app runs in unpredictable from
 * the outside.
 */
export function applyEnvFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue

      for (const [key, value] of Object.entries(
        parseEnvFile(readFileSync(candidate, 'utf8'))
      )) {
        if (process.env[key] === undefined) process.env[key] = value
      }

      return candidate
    } catch {
      // An unreadable candidate is not a reason to fail startup — try the next.
      continue
    }
  }

  return null
}
