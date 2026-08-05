/**
 * Token-stream -> entity merging in ner-worker.ts.
 *
 * The fixtures below are VERBATIM pipeline output, captured 2026-08-05 from
 * the two models run locally — not hand-written. They exist because the two
 * tokenizers mark sub-words in opposite ways, and a bare token means the
 * OPPOSITE thing in each:
 *
 *   BERT / WordPiece      "Z" "##ür" "##cher"   -> "##" marks a continuation,
 *                                                   a bare token starts a word
 *   DeBERTa / SentencePiece "Bahnhof" "strasse" -> a bare token CONTINUES the
 *                                                   previous word
 *
 * Reconstructing the text from token strings therefore cannot work from the
 * token shape alone. Worse, it fails even with the style known: WordPiece
 * emits "-" as its own bare token, so any "bare token starts a new word" rule
 * turns "Zürcher-Gehrig AG" into "Zürcher - Gehrig AG" — a string that is
 * then not findable in the source text.
 *
 * mergeTokens() therefore does not reconstruct. It ALIGNS each token back
 * onto the original text and takes the entity's text from the source. These
 * tests pin that: every `original` below must be a literal substring of its
 * input at the reported offsets.
 */
import { describe, it, expect } from 'vitest'
// The explicit `.ts` extension is required, not cosmetic: the esbuild output
// `src/main/privacy/ner-worker.js` sits next to the source (gitignored, built
// by `npm run build:ner-worker:src` so the worker resolves beside its source
// when running from TypeScript). Vite resolves `.js` BEFORE `.ts`, so the
// extensionless specifier silently imports that stale bundle instead — which
// fails with "mergeTokens is not a function" whenever the bundle predates the
// source. Measured 2026-08-05.
import { mergeTokens } from '../../src/main/privacy/ner-worker.ts'

const BERT_ORG_TEXT = 'Zürcher-Gehrig AG, Ansprechpartner: Beat Zimmermann.'
const BERT_ORG_TOKENS = [
  ['B-ORG', 'Z'], ['I-ORG', '##ür'], ['I-ORG', '##cher'], ['I-ORG', '-'], ['I-ORG', 'G'],
  ['I-ORG', '##ehr'], ['I-ORG', '##ig'], ['I-ORG', 'AG'], ['O', ','], ['O', 'Ans'],
  ['O', '##pre'], ['O', '##ch'], ['O', '##part'], ['O', '##ner'], ['O', ':'],
  ['B-PER', 'Beat'], ['I-PER', 'Zimmermann'], ['O', '.']
]

const BERT_ADDR_TEXT = 'Der Patient Hans Müller wohnt an der Bahnhofstrasse 12 in Zürich.'
const BERT_ADDR_TOKENS = [
  ['O', 'Der'], ['O', 'Pat'], ['O', '##ient'], ['B-PER', 'Hans'], ['I-PER', 'Müller'],
  ['O', 'wo'], ['O', '##hnt'], ['O', 'an'], ['O', 'der'], ['B-LOC', 'Bahnhof'],
  ['I-LOC', '##stras'], ['I-LOC', '##se'], ['O', '12'], ['O', 'in'], ['B-LOC', 'Zürich'], ['O', '.']
]

/** DeBERTa/SentencePiece — the previous model. Kept so the alignment stays
 *  correct for a tokenizer whose bare tokens CONTINUE a word. */
const DEBERTA_ADDR_TEXT = 'Der Patient Hans Müller wohnt an der Bahnhofstrasse 12 in Zürich.'
const DEBERTA_ADDR_TOKENS = [
  ['O', 'Der'], ['O', 'Patient'], ['O', 'Hans'], ['O', 'Müller'], ['O', 'wohn'], ['O', 't'],
  ['O', 'an'], ['O', 'der'], ['I-STREET', 'Bahnhof'], ['I-STREET', 'strasse'],
  ['I-BUILDINGNUM', '12'], ['O', 'in'], ['I-CITY', 'Zürich'], ['O', '.']
]

const toTokens = (pairs: string[][]) => pairs.map(([entity, word]) => ({ entity, word, score: 0.99 }))

describe('mergeTokens — WordPiece (BERT)', () => {
  it('joins ## continuations and a bare hyphen into the source spelling', () => {
    const out = mergeTokens(toTokens(BERT_ORG_TOKENS), BERT_ORG_TEXT)
    const org = out.find(e => e.category === 'ORGANIZATION')
    expect(org).toBeDefined()
    // The naive "bare token starts a new word" rule would yield
    // "Zürcher - Gehrig AG" here — with spaces that do not exist in the source.
    expect(org!.original).toBe('Zürcher-Gehrig AG')
    expect(BERT_ORG_TEXT.slice(org!.start, org!.end)).toBe(org!.original)
  })

  it('merges B-PER + I-PER into one person with a space from the source', () => {
    const out = mergeTokens(toTokens(BERT_ORG_TOKENS), BERT_ORG_TEXT)
    const person = out.find(e => e.category === 'PERSON')
    expect(person).toBeDefined()
    // join('') would produce "BeatZimmermann"; the space comes from the text.
    expect(person!.original).toBe('Beat Zimmermann')
    expect(BERT_ORG_TEXT.slice(person!.start, person!.end)).toBe(person!.original)
  })

  it('keeps a multi-piece location intact', () => {
    const out = mergeTokens(toTokens(BERT_ADDR_TOKENS), BERT_ADDR_TEXT)
    const spans = out.map(e => `${e.category}:${e.original}`)
    expect(spans).toContain('PERSON:Hans Müller')
    expect(spans).toContain('LOCATION:Bahnhofstrasse')
    expect(spans).toContain('LOCATION:Zürich')
    for (const e of out) expect(BERT_ADDR_TEXT.slice(e.start, e.end)).toBe(e.original)
  })

  it('starts a new entity on B- even when the previous token carries the same label', () => {
    // "Meier" and "Keller" are two people, not one — B- is the only signal.
    const text = 'Meier Keller'
    const out = mergeTokens(toTokens([['B-PER', 'Meier'], ['B-PER', 'Keller']]), text)
    expect(out).toHaveLength(2)
    expect(out.map(e => e.original)).toEqual(['Meier', 'Keller'])
  })
})

describe('mergeTokens — SentencePiece (DeBERTa), bare token continues a word', () => {
  it('joins bare continuation pieces without inventing a space', () => {
    const out = mergeTokens(toTokens(DEBERTA_ADDR_TOKENS), DEBERTA_ADDR_TEXT)
    const spans = out.map(e => `${e.category}:${e.original}`)
    expect(spans).toContain('ADDRESS:Bahnhofstrasse')
    expect(spans).toContain('ADDRESS:12')
    expect(spans).toContain('LOCATION:Zürich')
    for (const e of out) expect(DEBERTA_ADDR_TEXT.slice(e.start, e.end)).toBe(e.original)
  })

  it('does not merge STREET into BUILDINGNUM despite adjacency', () => {
    const out = mergeTokens(toTokens(DEBERTA_ADDR_TOKENS), DEBERTA_ADDR_TEXT)
    const addr = out.filter(e => e.category === 'ADDRESS').map(e => e.original)
    expect(addr).toEqual(['Bahnhofstrasse', '12'])
  })
})

describe('mergeTokens — countries are not personal data', () => {
  /**
   * The model tags countries and continents as LOC, which the anonymizer then
   * substitutes with a Swiss CITY. Measured 2026-08-05 after the model swap:
   *
   *   "… das Wetter in der Schweiz."       -> "… das Wetter in der Luzern."
   *   "… exportiert nach Deutschland …"    -> "… exportiert nach Luzern …"
   *
   * A country on its own does not identify a person, so redacting it buys no
   * privacy while destroying the sentence the model downstream has to work
   * with. The red-team catalog covers this as a critical-tier false-positive
   * check ("no-pii-text"), which this regression broke.
   */
  const loc = (word: string, text: string) =>
    mergeTokens(toTokens([['B-LOC', word]]), text).map(e => `${e.category}:${e.original}`)

  it('drops countries and continents', () => {
    expect(loc('Schweiz', 'Wetter in der Schweiz')).toEqual([])
    expect(loc('Deutschland', 'Export nach Deutschland')).toEqual([])
    expect(loc('Europa', 'Wetter in Europa')).toEqual([])
  })

  it('still reports cities and streets', () => {
    expect(loc('Zürich', 'Der Zug nach Zürich')).toEqual(['LOCATION:Zürich'])
    expect(loc('Boston', 'I live in Boston')).toEqual(['LOCATION:Boston'])
  })

  it('matches case-insensitively but only as a whole span', () => {
    expect(loc('schweiz', 'ich wohne in schweiz')).toEqual([])
    // "Schweizer" is not the country; it must survive as a location token.
    expect(loc('Schweizerhof', 'Hotel Schweizerhof')).toEqual(['LOCATION:Schweizerhof'])
  })
})

describe('mergeTokens — robustness', () => {
  it('returns nothing for an all-O stream', () => {
    expect(mergeTokens(toTokens([['O', 'Heute'], ['O', 'ist'], ['O', 'schön']]), 'Heute ist schön')).toEqual([])
  })

  it('skips special tokens without consuming source text', () => {
    const text = 'Anna Meier'
    const out = mergeTokens(
      toTokens([['O', '[CLS]'], ['B-PER', 'Anna'], ['I-PER', 'Meier'], ['O', '[SEP]']]),
      text
    )
    expect(out).toHaveLength(1)
    expect(out[0].original).toBe('Anna Meier')
    expect(out[0].start).toBe(0)
    expect(out[0].end).toBe(text.length)
  })

  it('drops an entity whose tokens cannot be located instead of guessing offsets', () => {
    // [UNK] has no counterpart in the source. Emitting start:0 for it — as the
    // previous findInText fallback did — would redact the wrong characters.
    const out = mergeTokens(toTokens([['B-PER', '[UNK]']]), 'Guten Tag')
    expect(out).toEqual([])
  })
})
