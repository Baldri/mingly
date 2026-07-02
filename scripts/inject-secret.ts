/**
 * Build-time secret injection for license validation.
 *
 * Reads MINGLY_LICENSE_SECRET from environment (or .env file) and generates
 * a TypeScript module that exports the secret. This file is gitignored so the
 * secret never leaks into the public repository.
 *
 * Usage: npx tsx scripts/inject-secret.ts
 * Called automatically via `prebuild:main` in package.json (also runs in CI
 * before typecheck/tests, since license-activation.ts imports the module).
 */

import { writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

const OUTPUT_PATH = join(__dirname, '..', 'src', 'main', 'services', '_license-secret.ts')
const ENV_PATH = join(__dirname, '..', '.env')
const DEV_FALLBACK = 'mingly-dev-secret-not-for-production'

function loadEnvSecret(): string | undefined {
  if (process.env.MINGLY_LICENSE_SECRET) {
    return process.env.MINGLY_LICENSE_SECRET
  }

  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, 'utf-8')
    const match = content.match(/^MINGLY_LICENSE_SECRET=(.+)$/m)
    if (match && match[1] && match[1] !== 'your-secret-here') {
      return match[1].trim()
    }
  }

  return undefined
}

const secret = loadEnvSecret()
const isProduction = !!secret

if (!secret) {
  console.log('[inject-secret] No MINGLY_LICENSE_SECRET found — using dev fallback')
} else {
  console.log('[inject-secret] Production secret injected')
}

const output = `// AUTO-GENERATED — do not edit. Regenerated on every build.
export const LICENSE_HMAC_SECRET = '${secret || DEV_FALLBACK}'
export const IS_PRODUCTION_SECRET = ${isProduction}
`

writeFileSync(OUTPUT_PATH, output, 'utf-8')
console.log(`[inject-secret] Written to ${OUTPUT_PATH}`)
