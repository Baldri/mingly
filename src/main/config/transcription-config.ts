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
 * Resolved at the moment of use, never cached. What that buys is the RUNNING
 * process's own environment: a key set or removed there is picked up by the
 * next pass, without restarting the queue. Not the `.env` file - `applyEnvFile`
 * fills `process.env` from it exactly once, at module load (src/main/index.ts,
 * one call site, no watcher), so an edit to the FILE takes effect at the next
 * app start.
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
 * Tab (0x09) is deliberately NOT in here, and neither is U+0080..U+00FF: both
 * were measured to go over the wire fine (HTTP 200), so refusing them would be
 * a false alarm on a configuration that works. That measured range is Latin-1
 * and stops there - it is the whole range a header value can carry byte for
 * byte. Above it the request path refuses as well, for a different reason; see
 * MAX_HEADER_CODEPOINT.
 */
const UNSENDABLE_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F]/

/**
 * The highest codepoint a header value can carry.
 *
 * A header value is a byte string, so `Headers.set` throws a TypeError for
 * anything above U+00FF - measured on this Node: `Ā` (U+0100), `€` (U+20AC)
 * and an emoji all throw, while `ü` and `ÿ` pass and reach the service with
 * HTTP 200. Checking C0 and DEL alone let such a key through here, and it then
 * surfaced once per job as a wait reason instead of once where it is
 * configured - the outcome `applyTranscriptionApiKey` exists to prevent.
 *
 * It gets its OWN reason rather than joining the control characters, because
 * cause and remedy differ: a control character is usually a stray line break
 * from copying an otherwise correct key, a high codepoint usually means the
 * wrong value was pasted altogether.
 */
const MAX_HEADER_CODEPOINT = 0xff

/** Why a key cannot be sent, or `undefined` when it can. */
function describeUnusableKey(apiKey: string): string | undefined {
  if (UNSENDABLE_CHARACTERS.test(apiKey)) {
    return 'enthaelt Steuerzeichen, die ein HTTP-Header nicht tragen kann (etwa Zeilenumbrueche)'
  }

  // Per CODEPOINT, not per UTF-16 unit: a character outside the BMP is one
  // codepoint held in two units, and the rule is about codepoints - so
  // `for...of`, which iterates them, judges it once instead of twice over its
  // surrogate halves.
  for (const character of apiKey) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint > MAX_HEADER_CODEPOINT) {
      return (
        'enthaelt Zeichen jenseits von Latin-1 (etwa ein Eurozeichen oder ein Emoji), ' +
        'die ein HTTP-Header nicht tragen kann - hier steht vermutlich der falsche Wert'
      )
    }
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
