/**
 * Swiss/German street detection in the Swiss layer.
 *
 * Why this exists: swapping layer 3 to bert-base-multilingual-cased-ner-hrl
 * bought person detection but dropped two labels the previous model had —
 * STREET and BUILDINGNUM. The street itself survives, but comes back as LOC,
 * so shield mode replaced it with a CITY. Measured 2026-08-05:
 *
 *   "… wohnt an der Bahnhofstrasse 12 in Zürich."
 *   ->  "… wohnt an der Lausanne 12 in Aarau."
 *
 * The plaintext was gone, but shield mode promises *plausible* substitutes,
 * and the house number was left untouched. A street name is a deterministic
 * pattern in this language, so it belongs in the pattern layer rather than
 * in a model — which also recovers the number.
 */
import { describe, it, expect } from 'vitest'
import { detectSwissPII } from '../../src/main/privacy/swiss-detector'

const addresses = (text: string) =>
  detectSwissPII(text).filter(e => e.category === 'ADDRESS').map(e => e.original)

describe('detectSwissPII — streets', () => {
  it('finds a street with its house number as one span', () => {
    expect(addresses('Der Patient wohnt an der Bahnhofstrasse 12 in Zürich.')).toEqual(['Bahnhofstrasse 12'])
  })

  it('finds a street without a number', () => {
    expect(addresses('Treffpunkt ist die Seestrasse.')).toEqual(['Seestrasse'])
  })

  it('handles a number with a letter suffix', () => {
    expect(addresses('Kirchgasse 4a, 8001 Zürich')).toEqual(['Kirchgasse 4a'])
  })

  it('covers the common Swiss suffixes', () => {
    expect(addresses('Rosenweg 3')).toEqual(['Rosenweg 3'])
    expect(addresses('Bundesplatz 1')).toEqual(['Bundesplatz 1'])
    expect(addresses('Lindenallee 22')).toEqual(['Lindenallee 22'])
  })

  it('reports offsets that match the source text', () => {
    const text = 'Wir treffen uns an der Mühleweg 7.'
    const [e] = detectSwissPII(text).filter(x => x.category === 'ADDRESS')
    expect(text.slice(e.start, e.end)).toBe(e.original)
  })

  // ── False-positive guards ─────────────────────────────────────────
  it('does not treat a bare noun as a street', () => {
    expect(addresses('Der Weg ist das Ziel.')).toEqual([])
    expect(addresses('Die Bewegung war spürbar.')).toEqual([])
  })

  it('does not fire on lowercase prose', () => {
    expect(addresses('wir gehen den weg entlang')).toEqual([])
  })

  it('leaves text without any street alone', () => {
    expect(addresses('Heute ist ein schöner Tag in Bern.')).toEqual([])
  })
})
