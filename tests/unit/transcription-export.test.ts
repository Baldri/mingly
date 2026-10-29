/**
 * Transcript export tests.
 *
 * The formatting itself is trivial; the structure is not. A segment text
 * carrying a forged block would hand its number and timestamps to whoever is
 * being transcribed, so every assertion about that case counts BLOCKS, not
 * characters: a `toContain` would pass just as happily on a document that fell
 * apart, and "does the character survive in the document" proves nothing at
 * all, because the document uses line breaks itself.
 *
 * Blocks are counted under the widest line concept in reach (`srtBlocks`), and
 * that counter is derived from this file's own documented table rather than
 * copied from the implementation — see `ANY_LINE_BREAK` for what the copy cost.
 *
 * The timestamp tests pin the whole string including the comma and the
 * padding, because "looks about right" is exactly how an off-by-one hour or a
 * dropped leading zero survives a review.
 */

import { describe, it, expect } from 'vitest'
import {
  exportTranscript,
  type TranscriptExportFormat
} from '../../src/main/transcription/transcript-export'
import type { TranscriptionSegment } from '../../src/main/database/models/transcription'

function segment(overrides: Partial<TranscriptionSegment> = {}): TranscriptionSegment {
  return {
    jobId: 'job-1',
    index: 0,
    startMs: 0,
    endMs: 1000,
    speaker: 'SPEAKER_00',
    text: 'Guten Tag',
    ...overrides
  }
}

/**
 * Built from their code points: a regex literal cannot carry U+2028 or U+2029
 * raw at all (it does not parse), and nothing in this file should carry them
 * raw in any case — they are invisible and shift every line number that a tool
 * with a wide line concept reports. A string or template literal WOULD accept
 * them since ES2019; the implementation file next door proved exactly that by
 * carrying two of them unnoticed through a whole review round.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const NUL = String.fromCharCode(0)

/**
 * The line breaks this file asserts about, as its own documented list. This is
 * one of the two notations of the set; the other is `LINE_BREAK` in the
 * implementation. Measured on 2026-10-26: `str.splitlines()` in Python breaks
 * on exactly these ten characters.
 */
const LINE_BREAK_CHARS: ReadonlyArray<readonly [string, string]> = [
  ['U+000A LF', '\u000a'],
  ['U+000D CR', '\u000d'],
  ['U+000D U+000A CRLF', '\u000d\u000a'],
  ['U+000B VT', '\u000b'],
  ['U+000C FF', '\u000c'],
  ['U+001C FS', '\u001c'],
  ['U+001D GS', '\u001d'],
  ['U+001E RS', '\u001e'],
  ['U+0085 NEL', '\u0085'],
  ['U+2028 LS', LINE_SEPARATOR],
  ['U+2029 PS', PARAGRAPH_SEPARATOR]
]

/** Whitespace and controls that must NOT be treated as a line break. */
const NON_BREAK_CHARS: ReadonlyArray<readonly [string, string]> = [
  ['U+0009 TAB', '\u0009'],
  ['U+00A0 NBSP', ' '],
  ['U+3000 IDEOGRAPHIC SPACE', '　'],
  ['U+200A HAIR SPACE', ' '],
  ['U+FEFF ZWNBSP', '﻿'],
  ['U+001F US', '\u001f'],
  ['U+0001 SOH', '\u0001']
]

/**
 * The measuring instrument, DERIVED from the table above instead of copied
 * from the implementation.
 *
 * It used to be a hand-kept second copy of the implementation's own class, and
 * that made the whole character table unable to fail: an instrument that does
 * not see a character as a boundary cannot see a forged block built from it
 * either, so subject and instrument shared one blind spot. Measured on
 * 2026-10-26: deleting U+001E from both left 63 of 63 tests green, and
 * narrowing both back to CR/LF — the original vulnerability — turned only 2 of
 * 63 red, none of them a table test. Deriving it here puts two INDEPENDENT
 * statements against each other: the implementation's set, and this file's
 * documented list.
 */
const ANY_LINE_BREAK = new RegExp(
  `[${[...new Set(LINE_BREAK_CHARS.flatMap(([, chars]) => [...chars]))]
    .map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')}]`,
  'g'
)

/**
 * The blocks of an SRT document under the widest reading of "line": every
 * character of the table counts as a break before blank lines are looked for.
 * A document that has one block under this reading has one block under every
 * narrower reading as well — which is the property the export has to hold.
 */
function srtBlocks(srt: string): string[] {
  const unified = srt.replace(ANY_LINE_BREAK, '\n')
  return unified.split(/\n[^\S\n]*\n/).filter(block => block.trim() !== '')
}

/** A forged block, complete with its own number and timestamps. */
function forgedBlock(separator: string): string {
  return [
    'Guten Tag',
    '',
    '2',
    '00:00:09,000 --> 00:00:10,000',
    'Ich stimme zu'
  ].join(separator)
}

describe('exportTranscript', () => {
  describe('SRT timestamps', () => {
    it('schreibt SRT-Zeitstempel als HH:MM:SS,mmm', () => {
      const srt = exportTranscript(
        [segment({ startMs: 3661500, endMs: 3665000 })],
        'srt'
      )
      expect(srt).toContain('01:01:01,500 --> 01:01:05,000')
    })

    it('polstert jedes Feld auf 2/2/2/3 Stellen', () => {
      const srt = exportTranscript([segment({ startMs: 0, endMs: 7 })], 'srt')
      expect(srt).toContain('00:00:00,000 --> 00:00:00,007')
    })

    it('kuerzt Stunden ab 100 nicht ab', () => {
      // 100 h exactly. Padding to two digits must not become truncating to
      // two digits - that would turn 100 h into 00 h and read as the start.
      const srt = exportTranscript(
        [segment({ startMs: 360_000_000, endMs: 360_000_001 })],
        'srt'
      )
      expect(srt).toContain('100:00:00,000 --> 100:00:00,001')
    })

    it('rundet gebrochene Millisekunden auf die naechste Millisekunde', () => {
      const srt = exportTranscript([segment({ startMs: 1500.7, endMs: 2000.2 })], 'srt')
      expect(srt).toContain('00:00:01,501 --> 00:00:02,000')
    })

    it('wirft bei negativen Zeitstempeln statt sie falsch zu formatieren', () => {
      expect(() => exportTranscript([segment({ startMs: -1 })], 'srt')).toThrow(/-1/)
    })

    it('wirft bei NaN und Infinity', () => {
      expect(() => exportTranscript([segment({ startMs: Number.NaN })], 'srt')).toThrow()
      expect(() =>
        exportTranscript([segment({ endMs: Number.POSITIVE_INFINITY })], 'srt')
      ).toThrow()
    })

    it('wirft bei Werten, die zu gross sind um exakt zu rechnen', () => {
      // Measured: MAX_VALUE formatted as "4.9935920412842105e+301:08:48,368" -
      // exponent and decimal point inside the hour field. Finite and >= 0 does
      // not cover it, the safe-integer range does. This is the only copy of
      // that string; the implementation comment points here instead of
      // repeating it.
      expect(() => exportTranscript([segment({ endMs: Number.MAX_VALUE })], 'srt')).toThrow(
        /millisecond value between 0 and 9007199254740991/
      )
      expect(() =>
        exportTranscript([segment({ endMs: Number.MAX_SAFE_INTEGER + 2 })], 'srt')
      ).toThrow(/millisecond value/)
      // Positive control in the same run: the boundary itself still formats.
      expect(() =>
        exportTranscript([segment({ endMs: Number.MAX_SAFE_INTEGER })], 'srt')
      ).not.toThrow()
    })

    it('wirft, wenn ein Cue vor seinem Anfang endet', () => {
      expect(() =>
        exportTranscript([segment({ startMs: 2000, endMs: 1000 })], 'srt')
      ).toThrow(/ends at 1000 ms, before it starts at 2000 ms/)
    })

    it('laesst einen Cue der Laenge null zu', () => {
      // endMs === startMs is valid SRT and ffmpeg reads it (measured
      // 2026-10-26). The refusal must stay strict: a creep from `<` to `<=`
      // would reject valid cues, and nothing else in the file would notice.
      const srt = exportTranscript([segment({ startMs: 1000, endMs: 1000 })], 'srt')
      expect(srt).toContain('00:00:01,000 --> 00:00:01,000')
      expect(srtBlocks(srt)).toHaveLength(1)
    })

    it('laesst txt ohne Zeitstempelpruefung durch', () => {
      // Not a second standard: txt renders no timestamps, so it has no
      // judgement to pass on them.
      const txt = exportTranscript(
        [segment({ startMs: 2000, endMs: 1000, text: 'trotzdem' })],
        'txt'
      )
      expect(txt).toBe('SPEAKER_00: trotzdem\n')
      expect(() =>
        exportTranscript([segment({ startMs: Number.NaN })], 'txt')
      ).not.toThrow()
    })

    it('nennt in der Meldung, welches Segment gemeint ist', () => {
      // One message for 5000 segments is useless. Two segments, the second
      // broken: the position must appear, and must not be the first one's.
      expect(() =>
        exportTranscript(
          [segment({ index: 0 }), segment({ index: 1, startMs: -1 })],
          'srt'
        )
      ).toThrow(/transcript position 1 \(index 1\)/)
    })
  })

  describe('SRT-Struktur', () => {
    it('zaehlt ab 1, auch wenn segment.index bei 0 beginnt', () => {
      const srt = exportTranscript([segment({ index: 0 })], 'srt')
      expect(srt.startsWith('1\n')).toBe(true)
    })

    it('nummeriert nach Position, nicht nach segment.index', () => {
      // An index that does not start at 0 must not leave a hole in the
      // numbering: SRT block numbers are the document's own count.
      const srt = exportTranscript(
        [segment({ index: 7, text: 'eins' }), segment({ index: 9, text: 'zwei' })],
        'srt'
      )
      expect(srtBlocks(srt).map(block => block.split('\n')[0])).toEqual(['1', '2'])
    })

    it('macht aus einer Leerzeile im Text keinen zweiten Block', () => {
      // The injection: the text carries a complete, forged block including its
      // own timestamps. One segment must stay one block.
      const srt = exportTranscript([segment({ text: forgedBlock('\n') })], 'srt')
      const blocks = srtBlocks(srt)

      expect(blocks).toHaveLength(1)
      // Number, timestamp line, one text line - the forged timestamp line has
      // no line of its own any more.
      expect(blocks[0].split('\n')).toHaveLength(3)
      expect(srt).toContain('Ich stimme zu')
    })

    it('macht auch aus einem einzelnen Umbruch keine zweite Zeile', () => {
      const srt = exportTranscript([segment({ text: 'eins\nzwei' })], 'srt')
      const [block] = srtBlocks(srt)
      expect(block.split('\n')).toHaveLength(3)
      expect(block.split('\n')[2]).toBe('SPEAKER_00: eins zwei')
    })

    it('macht aus einem Umbruch im Sprechernamen keinen zweiten Block', () => {
      const srt = exportTranscript([segment({ speaker: forgedBlock('\n') })], 'srt')
      expect(srtBlocks(srt)).toHaveLength(1)
    })

    it('stellt auch im SRT den Sprecher vor den Text', () => {
      const srt = exportTranscript([segment({ speaker: 'SPEAKER_03' })], 'srt')
      expect(srt).toContain('SPEAKER_03: Guten Tag')
    })

    it('schliesst den letzten Block mit einer Leerzeile ab', () => {
      const srt = exportTranscript([segment()], 'srt')
      expect(srt.endsWith('\n\n')).toBe(true)
    })
  })

  describe('Zeilenbegriff', () => {
    // The block counter has to be able to FIND a second block, for every
    // character it claims to read, or the table below is vacuous.
    it('Positivkontrolle: der Blockzaehler sieht zwei echte Bloecke', () => {
      const handBuilt =
        '1\n00:00:00,000 --> 00:00:01,000\neins\n\n2\n00:00:09,000 --> 00:00:10,000\nzwei\n\n'
      expect(srtBlocks(handBuilt)).toHaveLength(2)
    })

    it('Positivkontrolle: schlichter Text ist ein Block', () => {
      expect(srtBlocks('nur eine Zeile')).toHaveLength(1)
    })

    it('dokumentiert genau zehn Zeilengrenzen', () => {
      // A tripwire, not a third notation of the set. The counter is derived
      // from the table, so narrowing the table to "keep it in sync" with the
      // implementation would narrow the instrument with it and the table tests
      // below would quietly stop covering anything - they would simply not be
      // generated. Shrinking the documented set has to be a deliberate act.
      const characters = new Set(LINE_BREAK_CHARS.flatMap(([, chars]) => [...chars]))
      expect(characters.size).toBe(10)
    })

    for (const [name, separator] of LINE_BREAK_CHARS) {
      it(`Positivkontrolle: der Blockzaehler liest ${name} als Zeilengrenze`, () => {
        expect(srtBlocks(`eins${separator}${separator}zwei`)).toHaveLength(2)
      })

      it(`faltet ${name} und laesst daraus keinen zweiten Block entstehen`, () => {
        const srt = exportTranscript([segment({ text: forgedBlock(separator) })], 'srt')
        const blocks = srtBlocks(srt)

        expect(blocks).toHaveLength(1)
        // Number, timestamp line, one text line - nothing more.
        expect(blocks[0].split('\n')).toHaveLength(3)
        // The text is folded, not dropped.
        expect(srt).toContain('Ich stimme zu')
      })

      it(`faltet ${name} auch im Sprechernamen`, () => {
        const srt = exportTranscript([segment({ speaker: forgedBlock(separator) })], 'srt')
        expect(srtBlocks(srt)).toHaveLength(1)
      })
    }

    for (const [name, char] of NON_BREAK_CHARS) {
      it(`behandelt ${name} nicht als Zeilengrenze`, () => {
        const txt = exportTranscript([segment({ text: `eins${char}zwei` })], 'txt')
        expect(txt).toBe(`SPEAKER_00: eins${char}zwei\n`)
      })
    }

    it('schluckt horizontalen Leerraum neben einem Umbruch mit', () => {
      const txt = exportTranscript([segment({ text: 'eins \t\n  zwei' })], 'txt')
      expect(txt).toBe('SPEAKER_00: eins zwei\n')
    })

    it('laesst ein Segment aus lauter Steuerzeichen-Umbruechen ganz weg', () => {
      // `trim()` removes neither U+0085 nor U+001C, so before the fold this was
      // a block whose only text line was control characters. Folded to spaces,
      // the trim takes them and the segment drops out - decision 8.
      const srt = exportTranscript(
        [segment({ speaker: '', text: '\u0085\u0085\u001c' }), segment({ index: 1, text: 'zwei' })],
        'srt'
      )
      const blocks = srtBlocks(srt)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain('SPEAKER_00: zwei')
    })
  })

  describe('U+0000', () => {
    it('wirft, wenn der Text ein U+0000 enthaelt', () => {
      // Measured with ffprobe on 2026-10-26: an SRT document carrying one reads
      // as ZERO cues - a well-formed looking file with no subtitles at all.
      expect(() => exportTranscript([segment({ text: `Guten${NUL}Tag` })], 'srt')).toThrow(
        /the text of the segment at input position 0 \(index 0\) contains U\+0000/
      )
    })

    it('wirft auch, wenn der Sprechername eines enthaelt', () => {
      expect(() =>
        exportTranscript([segment({ speaker: `SPEAKER${NUL}00` })], 'srt')
      ).toThrow(/the speaker of the segment at input position 0/)
    })

    it('wirft in beiden Formaten und nennt das richtige Segment', () => {
      // One NUL in the first of three segments took all three down (measured:
      // 0 cues, control without it 3) - the same argument that makes a
      // non-finite index throw, so the check sits on the input, not in SRT.
      const segments = [
        segment({ index: 0, text: 'eins' }),
        segment({ index: 1, text: `zwei${NUL}x` }),
        segment({ index: 2, text: 'drei' })
      ]
      expect(() => exportTranscript(segments, 'srt')).toThrow(/input position 1 \(index 1\)/)
      expect(() => exportTranscript(segments, 'txt')).toThrow(/input position 1 \(index 1\)/)

      // Positive control in the same run: without the NUL all three export.
      const clean = segments.map(s => ({ ...s, text: s.text.replace(NUL, '') }))
      expect(exportTranscript(clean, 'txt')).toBe(
        'SPEAKER_00: eins\nSPEAKER_00: zweix\nSPEAKER_00: drei\n'
      )
    })

    it('laesst die uebrigen C0-Zeichen durch', () => {
      // Measured with ffprobe over the whole C0 range plus U+007F, 26
      // characters once the ten line breaks are taken out: only U+0000 is
      // harmful, the other 25 give one cue. This is no rule about control
      // characters, and U+0001 proves it is not one.
      const soh = String.fromCharCode(1)
      expect(exportTranscript([segment({ text: `Guten${soh}Tag` })], 'txt')).toBe(
        `SPEAKER_00: Guten${soh}Tag\n`
      )
      expect(() => exportTranscript([segment({ text: `Guten${soh}Tag` })], 'srt')).not.toThrow()
    })
  })

  describe('txt', () => {
    it('stellt im txt-Format den Sprecher vor den Text', () => {
      const txt = exportTranscript([segment({ speaker: 'SPEAKER_00', text: 'Guten Tag' })], 'txt')
      expect(txt).toBe('SPEAKER_00: Guten Tag\n')
    })

    it('schreibt eine Zeile je Segment, in Reihenfolge', () => {
      const txt = exportTranscript(
        [segment({ index: 0, text: 'eins' }), segment({ index: 1, text: 'zwei' })],
        'txt'
      )
      expect(txt).toBe('SPEAKER_00: eins\nSPEAKER_00: zwei\n')
    })

    it('laesst den Doppelpunkt weg, wenn kein Sprecher bekannt ist', () => {
      // `speaker` is a required string, so "unknown" arrives as the empty
      // string, never as undefined. ": Guten Tag" would be a lie about a
      // speaker named "".
      const txt = exportTranscript([segment({ speaker: '' })], 'txt')
      expect(txt).toBe('Guten Tag\n')
    })

    it('behandelt einen Sprecher aus lauter Leerzeichen wie keinen', () => {
      const txt = exportTranscript([segment({ speaker: '   ' })], 'txt')
      expect(txt).toBe('Guten Tag\n')
    })

    it('behaelt den Sprecher, wenn der Text leer ist', () => {
      // Someone was speaking at that point. Dropping the line would silently
      // shorten the transcript; only a segment with NEITHER field drops out.
      expect(exportTranscript([segment({ text: '' })], 'txt')).toBe('SPEAKER_00:\n')
      const srt = exportTranscript([segment({ text: '   ' })], 'srt')
      expect(srtBlocks(srt)).toHaveLength(1)
      expect(srt).toContain('SPEAKER_00:')
    })

    it('laesst ein leeres Segment weg, ohne eine Leerzeile zu hinterlassen', () => {
      // A blank line in the middle of a transcript reads as a missing passage.
      const txt = exportTranscript(
        [
          segment({ index: 0, text: 'eins' }),
          segment({ index: 1, speaker: '', text: '   ' }),
          segment({ index: 2, text: 'drei' })
        ],
        'txt'
      )
      expect(txt).toBe('SPEAKER_00: eins\nSPEAKER_00: drei\n')
    })

    it('faltet Umbrueche im Text in dieselbe Zeile', () => {
      const txt = exportTranscript([segment({ text: 'eins\n\nzwei' })], 'txt')
      expect(txt).toBe('SPEAKER_00: eins zwei\n')
    })
  })

  describe('Reihenfolge und Randfaelle', () => {
    it('sortiert nach index, auch wenn der Aufrufer es nicht tut', () => {
      const txt = exportTranscript(
        [segment({ index: 2, text: 'drei' }), segment({ index: 0, text: 'eins' }), segment({ index: 1, text: 'zwei' })],
        'txt'
      )
      expect(txt).toBe('SPEAKER_00: eins\nSPEAKER_00: zwei\nSPEAKER_00: drei\n')
    })

    it('laesst die Eingabereihenfolge bei gleichem index stehen', () => {
      const txt = exportTranscript(
        [segment({ index: 1, text: 'zuerst' }), segment({ index: 1, text: 'danach' })],
        'txt'
      )
      expect(txt).toBe('SPEAKER_00: zuerst\nSPEAKER_00: danach\n')
    })

    it('wirft bei nicht-endlichem index, statt die gesunden Segmente umzusortieren', () => {
      // Measured with an unguarded sort: indices NaN, 0, NaN, 1, -5 came out
      // as NaN, 0, NaN, -5, 1 - index 0 before index -5, index 1 last. The
      // damage lands on the healthy segments, and in a transcript the order IS
      // the content.
      const scrambling = [
        segment({ index: Number.NaN, text: 'a' }),
        segment({ index: 0, text: 'b' }),
        segment({ index: Number.NaN, text: 'c' }),
        segment({ index: 1, text: 'd' }),
        segment({ index: -5, text: 'e' })
      ]
      expect(() => exportTranscript(scrambling, 'srt')).toThrow(/input position 0 has index NaN/)
      expect(() => exportTranscript(scrambling, 'txt')).toThrow(/would reorder/)
      expect(() =>
        exportTranscript([segment({ index: Number.POSITIVE_INFINITY })], 'txt')
      ).toThrow(/input position 0 has index Infinity/)
      // Positive control: the same list with finite indices goes through.
      const sane = scrambling.map((s, position) => ({ ...s, index: position }))
      expect(exportTranscript(sane, 'txt')).toBe(
        ['a', 'b', 'c', 'd', 'e'].map(text => `SPEAKER_00: ${text}\n`).join('')
      )
    })

    it('prueft vor dem Sortieren, damit die Meldung die Eingabeposition nennt', () => {
      // The module claims twice that the check runs before the order is
      // established. Nothing held it: moving `assertExportable` after
      // `inTranscriptOrder` left all tests green (measured 2026-10-26).
      //
      // The broken segment has to come FIRST and the list needs a second
      // element, or the mutant survives: sorting a one-element array moves
      // nothing, and with the broken index last it is already where the sort
      // would put it. Here the sort would carry it to the end, so a check
      // that runs afterwards reports position 1.
      expect(() =>
        exportTranscript(
          [segment({ index: Number.POSITIVE_INFINITY }), segment({ index: 0 })],
          'txt'
        )
      ).toThrow(/input position 0 has index Infinity/)
    })

    it('veraendert das Array des Aufrufers nicht', () => {
      const segments = [segment({ index: 1, text: 'zwei' }), segment({ index: 0, text: 'eins' })]
      // Assert on the output too: "did not reorder" is trivially true of a
      // function that produced nothing.
      expect(srtBlocks(exportTranscript(segments, 'srt'))).toHaveLength(2)
      expect(segments.map(s => s.text)).toEqual(['zwei', 'eins'])
    })

    it('gibt fuer ein leeres Array einen leeren String zurueck', () => {
      expect(exportTranscript([], 'txt')).toBe('')
      expect(exportTranscript([], 'srt')).toBe('')
    })

    it('laesst ein Segment ohne Sprecher und ohne Text weg', () => {
      // An empty SRT cue is not representable, and the numbering must stay
      // contiguous - so the empty segment leaves no gap behind.
      const srt = exportTranscript(
        [segment({ index: 0, speaker: '', text: '  ' }), segment({ index: 1, text: 'zwei' })],
        'srt'
      )
      const blocks = srtBlocks(srt)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].split('\n')[0]).toBe('1')
    })

    it('schreibt LF, niemals CRLF', () => {
      const srt = exportTranscript([segment({ text: 'eins\r\nzwei' })], 'srt')
      const txt = exportTranscript([segment({ text: 'eins\r\nzwei' })], 'txt')
      // The CR must be gone from a document that actually carries the text -
      // an empty string contains no CR either.
      expect(txt).toBe('SPEAKER_00: eins zwei\n')
      expect(srt).toContain('SPEAKER_00: eins zwei')
      expect(srt).not.toContain('\r')
      expect(txt).not.toContain('\r')
    })

    it('wirft bei einem Format, das es nicht gibt', () => {
      // Unreachable for a typed caller, reachable from the IPC boundary once
      // there is one. Returning '' here would hand the caller a silently empty
      // file instead of an error.
      const unknown = 'pdf' as TranscriptExportFormat
      expect(() => exportTranscript([segment()], unknown)).toThrow(RangeError)
      expect(() => exportTranscript([segment()], unknown)).toThrow(
        /Unsupported transcript export format: pdf/
      )
      expect(() => exportTranscript([segment()], 'TXT' as TranscriptExportFormat)).toThrow(
        /Unsupported/
      )
      expect(() =>
        exportTranscript([segment()], undefined as unknown as TranscriptExportFormat)
      ).toThrow(/Unsupported/)
    })
  })
})
