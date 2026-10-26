/**
 * Where the transcription service's API key comes from.
 *
 * `TRANSCRIPTION_API_KEY` is the variable the Python service itself reads
 * (transcription-server/server.py), so Mingly reads the same one: a key
 * configured on one side and unknown to the other means every submit and
 * every poll is answered with 401 - and because 401 is treated as "wait, do
 * not fail the job" (Ruling 23), the job would sit in the queue for ever with
 * a reason nobody can act on.
 *
 * Resolved at the moment of use, never cached: `applyEnvFile` fills
 * `process.env` at startup, and the key can be changed in that file and
 * reloaded without restarting the queue.
 *
 * No settings field yet - the key is a developer and power-user setting, like
 * the spool directory. When one is added, resolve it the way
 * infomaniak-config.ts does: settings first, environment as the fallback,
 * because a value somebody typed into the app beats one the process happened
 * to inherit.
 */

import { getTranscriptionHttpClient } from '../transcription/transcription-http-client'

const ENV_VAR = 'TRANSCRIPTION_API_KEY'

/** Blank, whitespace-only and unset all mean the same thing: no key. */
function normalise(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function resolveTranscriptionApiKey(): string | undefined {
  return normalise(process.env[ENV_VAR])
}

/**
 * Put the resolved key on the shared HTTP client - or take it off.
 *
 * `undefined` clears it, so a key removed from the environment stops being
 * sent instead of living on in a client that was configured once. The client
 * then omits the Authorization header entirely, which is what a loopback
 * service without a key expects.
 */
export function applyTranscriptionApiKey(apiKey: string | undefined): void {
  getTranscriptionHttpClient().updateConfig({ apiKey })
}
