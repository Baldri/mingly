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
 * Characters the request path refuses to put in a header.
 *
 * `Headers.set` is NOT the authority here, although it is what the client
 * calls: measured on this Node, it rejects only NUL, CR and LF, while `fetch`
 * then rejects every other C0 control character and DEL with
 * UND_ERR_INVALID_ARG. The client cannot tell that apart from a refused
 * connection and reports it as "service unreachable" - a misconfigured key
 * shown as an outage, which is precisely what its own comment forbids.
 *
 * Tab (0x09) and non-ASCII characters are deliberately NOT in here: both were
 * measured to go over the wire fine (HTTP 200), so refusing them would be a
 * false alarm on a configuration that works.
 */
const UNSENDABLE_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F]/

/** Why a key cannot be sent, or `undefined` when it can. */
function describeUnusableKey(apiKey: string): string | undefined {
  if (UNSENDABLE_CHARACTERS.test(apiKey)) {
    return 'enthaelt Steuerzeichen, die ein HTTP-Header nicht tragen kann (etwa Zeilenumbrueche)'
  }
  return undefined
}

/**
 * Put the resolved key on the shared HTTP client - or take it off.
 *
 * `undefined` clears it, so a key removed from the environment stops being
 * sent instead of living on in a client that was configured once. The client
 * then omits the Authorization header entirely, which is what a loopback
 * service without a key expects.
 *
 * A key that cannot be sent is REFUSED here, where it is configured, and not
 * left for the first request. Discovered there it is an exception from inside
 * a job's turn, which the runner does not treat as an answer from the service:
 * it surfaced as a log warning and nothing at all on the job row, so the queue
 * looked idle while every pass failed. Here it is one visible error about a
 * setting, which is the only place anyone can fix it.
 *
 * The message never carries the value. It ends up in the log, and a secret
 * does not belong there.
 */
export function applyTranscriptionApiKey(apiKey: string | undefined): void {
  if (apiKey !== undefined) {
    const problem = describeUnusableKey(apiKey)
    if (problem !== undefined) throw new Error(`${ENV_VAR} ${problem}`)
  }

  getTranscriptionHttpClient().updateConfig({ apiKey })
}
