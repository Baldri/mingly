/**
 * Transcript export: segments in, one txt or SRT document out.
 *
 * Not in services/export-service.ts, although the plan named that file. That
 * module exports CHATS - an `ExportService` class with a singleton, an
 * `ExportOptions` carrying `Message[]`, title, provider and model, and its own
 * `ExportFormat = 'markdown' | 'json' | 'html'`. A transcript shares none of
 * that, and a second, overlapping format union in the same file would be read
 * as one. The rest of the transcription code lives here.
 *
 * The one part of this that is more than formatting is the SRT structure. A
 * segment text carrying a forged block would hand its number, timestamps and
 * speaker to whoever is being transcribed. SRT separates blocks with a blank
 * line, but the danger is NOT the blank line: measured with ffprobe on
 * 2026-10-26, two blocks with NO blank line between them read as two cues, and
 * two separated by a line of three spaces do as well (controls in the same
 * run: one, two and three clean segments read as one, two and three cues).
 * ffmpeg resynchronises on a number line followed by a timestamp line, with no
 * blank line needed.
 *
 * What keeps one segment one block is therefore the FOLD, not the absence of a
 * blank line: every line break in speaker and text becomes a space before
 * anything is written, so a forged block never gets a line of its own. In the
 * same run, both folded attack documents - with and without a speaker prefix -
 * read as exactly one cue. Anyone who later lets a line break through, and a
 * real multi-line cue is valid SRT and a plausible next feature, takes that
 * guarantee with them and cannot lean on this comment.
 *
 * Data that cannot be rendered correctly is refused at the door rather than
 * written as a plausible-looking lie: a timestamp that is not a millisecond
 * value, a cue that ends before it starts, an `index` that would reorder its
 * neighbours, a U+0000 that empties the whole document. Note what this
 * deliberately does NOT do: escape, quote or drop any text. The text is
 * written as it was spoken; only its line breaks lose their structural power.
 */

import type { TranscriptionSegment } from '../database/models/transcription'
import type { TranscriptExportFormat } from '../../shared/types'

// Defined in src/shared/types.ts, because the preload bridge for
// `TRANSCRIPTION_EXPORT` types the format and src/preload is type-checked with
// the renderer, which must not import from src/main. Re-exported here so this
// module stays the import site the main process already uses.
export type { TranscriptExportFormat }

/**
 * Every character a plausible consumer reads as a line break: ECMAScript's own
 * LineTerminators, plus the rest of the set Python's `str.splitlines()` breaks
 * on - the language the transcription service is written in. The characters
 * are deliberately not spelled out a second time here; this string and
 * `LINE_BREAK_CHARS` in tests/unit/transcription-export.test.ts are the two
 * notations of the set, and the test walks every one of them against the block
 * count.
 *
 * Narrowing this to CR and LF is what let the other eight carry a complete
 * forged SRT block through the fold. Measured on 2026-10-26: `str.splitlines()`
 * breaks on exactly ten characters, and TAB, SP, NBSP, U+3000, U+200A, U+FEFF,
 * U+001F, U+0000, U+007F, U+180E and U+2060 are not among them.
 */
const LINE_BREAK = '\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029'

/**
 * Whitespace that is not a line break: tab, NBSP, U+3000 and the rest. It is
 * swallowed ALONGSIDE a break, so that a break padded with tabs leaves one
 * space rather than three, but it never acts as a break itself.
 *
 * Excluding `LINE_BREAK` from the class is defensive and, measured, not
 * observable: an A/B over 111 inputs on 2026-10-26 found zero differences
 * against a plain `[^\S]`, because the alternation below already contains the
 * break class and backtracking arrives at the same span. That A/B has NO
 * valid positive control: the only change that makes the two classes differ is
 * narrowing `LINE_BREAK` itself, which is a different variable and the very
 * capability under test. Read the zero as "no observable effect here", not as
 * "measured safe".
 * It stays because the class should mean what its name says - note that `\S`
 * alone does NOT exclude U+2028 and U+2029, which are whitespace in
 * JavaScript; only `[^\S...]` reaches them at all.
 */
const HORIZONTAL_SPACE = `[^\\S${LINE_BREAK}]`

/**
 * A run of line breaks with the horizontal whitespace around it. Composed
 * instead of written as a literal so that the class above appears once rather
 * than three times - and because a regex literal cannot carry U+2028 or
 * U+2029 raw at all.
 */
const LINE_BREAK_RUN = new RegExp(
  `${HORIZONTAL_SPACE}*[${LINE_BREAK}](?:${HORIZONTAL_SPACE}|[${LINE_BREAK}])*`,
  'g'
)

/** Built from its code point: a NUL in source is invisible and easy to lose. */
const NUL = String.fromCharCode(0)

/**
 * The value as one line: no line break of any kind, no leading or trailing
 * whitespace.
 *
 * The fold runs before the trim on purpose. `trim()` goes by JavaScript's
 * whitespace, which does not include U+0085 or U+001C, so a text made of
 * nothing but those would survive as a line of control characters; folded to a
 * space first, it trims away to nothing and the segment drops out.
 */
function foldToSingleLine(value: string): string {
  return value.replace(LINE_BREAK_RUN, ' ').trim()
}

/**
 * Refuse the two inputs that no format can render correctly, before a single
 * character is written and before the order is established.
 *
 * `index`: `a.index - b.index` yields NaN for a non-finite index, which the
 * specification reads as "equal", so the comparator stops being transitive and
 * the damage lands on the HEALTHY segments beside it. Measured on 2026-10-26
 * with an unguarded sort: indices NaN, 0, NaN, 1, -5 came out in the order
 * NaN, 0, NaN, -5, 1, so index 0 preceded index -5 and index 1 ended up last.
 * In a transcript the order IS the content.
 *
 * U+0000: measured with ffprobe on 2026-10-26 over the whole C0 range plus
 * U+007F - 26 characters once the ten line breaks are taken out - exactly one
 * is harmful. A U+0000 in the text makes the SRT document read as ZERO cues,
 * and a single one in the first of three segments takes all three with it
 * (control without it: three cues). The other 25 read as one cue and pass
 * through untouched, so this is NOT a rule about control characters. It is
 * refused rather than stripped for the two reasons this module already states:
 * a file that looks well-formed and carries no subtitles is precisely the
 * plausible-looking lie the header rules out, and a broken segment must not
 * damage the healthy ones.
 *
 * Both checks sit on the INPUT rather than inside a format, because unlike a
 * timestamp, `text` and `speaker` are rendered by both formats. For txt there
 * is no comparable measurement of damage; the refusal is uniform because the
 * field is the same field.
 */
function assertExportable(segments: readonly TranscriptionSegment[]): void {
  segments.forEach((segment, position) => {
    if (!Number.isFinite(segment.index)) {
      throw new RangeError(
        `Cannot export transcript: the segment at input position ${position} has index ` +
          `${segment.index}, which would reorder the segments around it`
      )
    }

    for (const [field, value] of [
      ['text', segment.text],
      ['speaker', segment.speaker]
    ] as const) {
      if (value.includes(NUL)) {
        throw new RangeError(
          `Cannot export transcript: the ${field} of the segment at input position ` +
            `${position} (index ${segment.index}) contains U+0000, which makes an SRT ` +
            `document parse as empty`
        )
      }
    }
  })
}

/** How a refusal made while writing SRT names the segment it refuses. */
function segmentLabel(position: number, segment: TranscriptionSegment): string {
  return `the segment at transcript position ${position} (index ${segment.index})`
}

/**
 * The largest millisecond value that still formats exactly. Beyond it the
 * division carries a fraction and an exponent into the hour field; the exact
 * string that produced is pinned in the test, not quoted here as well.
 */
const MAX_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER

/**
 * `HH:MM:SS,mmm` - comma, not period, and zero-padded 2/2/2/3.
 *
 * Padding never truncates: a recording of 100 hours keeps its three-digit hour
 * rather than silently reading as the start of the file. A value that is not a
 * millisecond value in range has no correct rendering at all, so it throws
 * instead of producing a plausible-looking wrong one.
 *
 * A fractional value rounds to the nearest millisecond, the only precision the
 * format has. The service never sends one - `int(round(...))` at
 * pipeline.py:176 hands over whole numbers - so the rounding is here for other
 * callers. (Measured on 2026-10-26: Python's `round` sends halves to the even
 * neighbour and JavaScript's away from zero, so 1500.5 would differ; that
 * divergence cannot surface while the service sends integers.)
 */
function formatTimestamp(ms: number, field: string, where: string): string {
  if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(Math.round(ms))) {
    throw new RangeError(
      `Cannot export as SRT: ${field} of ${where} is ${ms}, ` +
        `expected a millisecond value between 0 and ${MAX_TIMESTAMP_MS}`
    )
  }

  const total = Math.round(ms)
  const millis = total % 1000
  const totalSeconds = (total - millis) / 1000
  const seconds = totalSeconds % 60
  const totalMinutes = (totalSeconds - seconds) / 60
  const minutes = totalMinutes % 60
  const hours = (totalMinutes - minutes) / 60

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * One segment as one line: `SPEAKER_00: Guten Tag`.
 *
 * `speaker` is a required string, so a segment without a known speaker carries
 * the empty string rather than `undefined`, and a bare ": Guten Tag" would
 * claim a speaker named "". Today's service never sends it - pipeline.py:178
 * maps both a missing and an empty speaker to `SPEAKER_UNKNOWN` - but nothing
 * between there and here enforces that: the HTTP client only checks for a
 * string (transcription-http-client.ts:128) and the model stores what it is
 * given. Empty is handled, not assumed away.
 *
 * A speaker with no text keeps the speaker and the colon: someone was speaking
 * at that point, and dropping the line would silently shorten the transcript.
 * Only a segment with neither returns the empty string, and its caller leaves
 * it out.
 */
function formatBody(segment: TranscriptionSegment): string {
  const speaker = foldToSingleLine(segment.speaker)
  const text = foldToSingleLine(segment.text)

  if (speaker === '') return text
  if (text === '') return `${speaker}:`
  return `${speaker}: ${text}`
}

/**
 * Transcript order, without touching the caller's array.
 *
 * `TranscriptionModel.getSegments` already sorts by `segment_index`, but the
 * signature takes an array from anywhere, so the order is established here
 * rather than inherited - and a module that takes that responsibility has to
 * be able to keep it, which is why `assertExportable` has already refused a
 * non-finite `index` by the time this runs. `index` is the declared transcript
 * order (not `startMs`, which may overlap between speakers), and the sort is
 * stable, so two segments sharing an index stay in the order they arrived.
 */
function inTranscriptOrder(segments: TranscriptionSegment[]): TranscriptionSegment[] {
  return [...segments].sort((a, b) => a.index - b.index)
}

/**
 * One line per segment. A segment with neither speaker nor text is left out,
 * for the same reason as in SRT: it carries nothing, and a blank line in the
 * middle of a transcript reads as a missing passage rather than as an empty
 * one.
 *
 * Timestamps are not validated here, and that is not a second standard: this
 * format renders no timestamps, so it has no judgement to pass on them. Only
 * SRT refuses a cue it cannot place in time.
 */
function formatTxt(segments: TranscriptionSegment[]): string {
  return segments
    .map(formatBody)
    .filter(body => body !== '')
    .map(body => `${body}\n`)
    .join('')
}

/**
 * Blocks are numbered by POSITION, from 1 - `segment.index` counts from 0 and
 * may skip or repeat values, while an SRT block number is the document's own
 * running count. A segment with neither speaker nor text is left out entirely;
 * an empty cue is not representable, and numbering by position means it leaves
 * no gap behind.
 *
 * A cue that ends before it starts is refused: no player can place it, and
 * writing it anyway would push the decision onto whoever opens the file. A cue
 * of length zero (`endMs === startMs`) is NOT refused - it is valid SRT and
 * ffmpeg reads it, measured on 2026-10-26 - so the comparison has to stay
 * strict. Every block, including the last, ends in a blank line, because a
 * parser that reads a cue until the next blank line needs one after the final
 * cue too.
 */
function formatSrt(segments: TranscriptionSegment[]): string {
  const blocks: string[] = []

  segments.forEach((segment, position) => {
    const body = formatBody(segment)
    if (body === '') return

    const where = segmentLabel(position, segment)
    const start = formatTimestamp(segment.startMs, 'startMs', where)
    const end = formatTimestamp(segment.endMs, 'endMs', where)
    if (segment.endMs < segment.startMs) {
      throw new RangeError(
        `Cannot export as SRT: ${where} ends at ${segment.endMs} ms, ` +
          `before it starts at ${segment.startMs} ms`
      )
    }

    blocks.push(`${blocks.length + 1}\n${start} --> ${end}\n${body}\n\n`)
  })

  return blocks.join('')
}

/**
 * Format a transcript as plain text or SRT subtitles.
 *
 * Line endings are LF. CRLF is sometimes expected of SRT, but LF is what the
 * rest of Mingly's exports write (`export-service.ts` joins on `\n`), and one
 * convention across the app beats a per-format exception. How individual
 * players react to LF is not measured here. An empty list of segments gives an
 * empty string.
 */
export function exportTranscript(
  segments: TranscriptionSegment[],
  format: TranscriptExportFormat
): string {
  assertExportable(segments)
  const ordered = inTranscriptOrder(segments)

  switch (format) {
    case 'txt':
      return formatTxt(ordered)
    case 'srt':
      return formatSrt(ordered)
    default: {
      // Unreachable for a typed caller, and `TRANSCRIPTION_EXPORT` refuses an
      // unknown format at the boundary before it gets here
      // (`requireExportFormat` in ipc/transcription-handlers.ts). It stays as
      // the second line of defence rather than the first: a format that
      // arrives from the renderer must not fall through to one the caller did
      // not ask for, whatever the boundary does or stops doing.
      const unexpected: never = format
      throw new RangeError(`Unsupported transcript export format: ${String(unexpected)}`)
    }
  }
}
