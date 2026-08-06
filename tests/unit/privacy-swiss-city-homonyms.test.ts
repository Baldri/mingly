/**
 * Swiss city names that are also ordinary German words.
 *
 * `SWISS_CITIES` matched as bare words, so every "Zug" became a LOCATION and
 * shield mode substituted a city for it. Measured 2026-08-05:
 *
 *   "Der Zug nach Zürich faellt aus."  ->  "Der Luzern nach Baden faellt aus."
 *
 * Which names are actually ambiguous was measured, not guessed — an earlier
 * claim that "Chur" belongs here was wrong; it is not a German word. Only
 * "Zug" (train, move, draught) and "Baden" (bathing) fired in non-place
 * sentences.
 *
 * Removing them from the list is not an option: NER does not reliably catch
 * them either — "Ich wohne in Zug." produced no NER entity, only the Swiss
 * match. So the name stays and gains a context requirement.
 */
import { describe, it, expect } from 'vitest'
import { detectSwissPII } from '../../src/main/privacy/swiss-detector'

const locations = (text: string) =>
  detectSwissPII(text).filter(e => e.category === 'LOCATION').map(e => e.original)

describe('detectSwissPII — ambiguous city names need a locative cue', () => {
  it('does not treat the vehicle as a city', () => {
    expect(locations('Der Zug nach Zürich faellt aus.')).not.toContain('Zug')
    expect(locations('Er hat einen Zug gemacht.')).toEqual([])
    expect(locations('Im Zug war es voll.')).toEqual([])
  })

  it('does not treat bathing as a city', () => {
    expect(locations('Nach dem Baden gingen wir essen.')).toEqual([])
    expect(locations('Das Baden ist hier verboten.')).toEqual([])
  })

  it('still finds them as places after a locative cue', () => {
    expect(locations('Ich wohne in Zug.')).toContain('Zug')
    expect(locations('Wir fahren nach Baden.')).toContain('Baden')
    expect(locations('Der Kunde kommt aus Zug.')).toContain('Zug')
    expect(locations('Ein Termin bei Baden.')).toContain('Baden')
  })

  it('accepts a postal code as the cue', () => {
    // The PLZ+city pattern covers "6300 Zug" as one span; the bare-city pass
    // must not additionally reject the name when a PLZ precedes it.
    expect(locations('6300 Zug').join(' ')).toContain('Zug')
  })

  it('leaves unambiguous cities alone — no cue required', () => {
    expect(locations('Chur liegt in Graubuenden.')).toContain('Chur')
    expect(locations('Zürich ist die groesste Stadt.')).toContain('Zürich')
    expect(locations('Olten hat einen Bahnhof.')).toContain('Olten')
  })

  it('still detects the unambiguous city in a sentence containing an ambiguous word', () => {
    expect(locations('Der Zug nach Zürich faellt aus.')).toContain('Zürich')
  })
})
