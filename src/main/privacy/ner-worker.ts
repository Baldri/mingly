// src/main/privacy/ner-worker.ts
// Worker thread for piiranha-v1 NER inference.
// piiranha uses I-* labels only (no B-* prefix) and may return null start/end offsets.
// This worker handles sub-word token merging and offset reconstruction.

import { parentPort } from 'worker_threads'

type WorkerMessage =
  | { type: 'init'; modelId: string; cacheDir: string }
  | { type: 'detect'; text: string; requestId: string }
  | { type: 'shutdown' }

let pipe: any = null

async function initPipeline(modelId: string, cacheDir: string): Promise<void> {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = cacheDir
  env.allowRemoteModels = false // model must be pre-downloaded via model-manager
  // fp32 (non-quantized) for full PII detection quality
  pipe = await pipeline('token-classification', modelId, { dtype: 'fp32' })
  parentPort?.postMessage({ type: 'ready' })
}

async function detect(text: string, requestId: string): Promise<void> {
  if (!pipe) {
    parentPort?.postMessage({ type: 'error', requestId, message: 'Pipeline not initialized' })
    return
  }

  try {
    const results = await pipe(text, { ignore_labels: [] })
    const entities = mergeTokens(results, text)
    parentPort?.postMessage({ type: 'result', requestId, entities })
  } catch (error: any) {
    parentPort?.postMessage({ type: 'error', requestId, message: error.message })
  }
}

/** Tokens the tokenizer adds; they have no counterpart in the source text. */
const SPECIAL_TOKEN = /^\[(CLS|SEP|PAD|UNK|MASK)\]$/

/** Strip sub-word markers so a token can be located in the source text. */
function tokenText(word: unknown): string {
  return String(word ?? '').replace(/^##/, '').replace(/^[▁\s]+/, '')
}

/** Drop the BIO prefix; `B-PER` and `I-PER` are the same label. */
function stripBioPrefix(label: string): string {
  return label.replace(/^[BI]-/, '')
}

interface AlignedToken {
  label: string
  rawLabel: string
  /** True for `B-*`: forces a new entity even next to the same label. */
  begin: boolean
  start: number
  end: number
  score: number
}

/**
 * Map each token back onto a character range of the ORIGINAL text.
 *
 * This replaces the previous approach of rebuilding the entity text from the
 * token strings, which cannot work: the two tokenizers we have used mark
 * sub-words in opposite ways, and a bare token means the opposite thing in
 * each — WordPiece marks continuations with "##" (so a bare token starts a
 * word), SentencePiece leaves continuations bare. Worse, even with the style
 * known, WordPiece emits "-" as its own bare token, so any "bare token starts
 * a word" rule turns "Zürcher-Gehrig AG" into "Zürcher - Gehrig AG" — a
 * string that then cannot be found in the source at all.
 *
 * Walking the text with a cursor sidesteps the question entirely and yields
 * exact offsets, so the entity text is a real substring rather than a
 * reconstruction. Tokens that cannot be located (special tokens, `[UNK]`)
 * return null and are dropped — the old `findInText` fallback returned
 * `start: 0` for those, which would redact the wrong characters.
 */
function alignTokens(tokens: any[], text: string): (AlignedToken | null)[] {
  let cursor = 0
  return tokens.map((token) => {
    const label = String(token.entity ?? token.entity_group ?? '')
    const rawWord = String(token.word ?? '').trim()
    const piece = tokenText(token.word)
    if (!piece || SPECIAL_TOKEN.test(rawWord)) return null

    let idx = text.indexOf(piece, cursor)
    if (idx === -1) idx = text.toLowerCase().indexOf(piece.toLowerCase(), cursor)
    if (idx === -1) return null

    const end = idx + piece.length
    cursor = end
    return {
      label,
      rawLabel: stripBioPrefix(label),
      begin: label.startsWith('B-'),
      start: idx,
      end,
      score: typeof token.score === 'number' ? token.score : 1
    }
  })
}

/**
 * Merge adjacent sub-word tokens into full entities.
 *
 * Exported for tests: the fixtures in
 * tests/unit/privacy-ner-token-alignment.test.ts are verbatim pipeline output
 * from both tokenizer families.
 */
export function mergeTokens(tokens: any[], text: string): any[] {
  const aligned = alignTokens(tokens, text)
  const entities: any[] = []

  let current: {
    category: string
    rawLabels: string[]
    start: number
    end: number
    score: number
    /** Index in the token stream, to require contiguity when merging. */
    tokenIdx: number
  } | null = null

  const flush = () => {
    if (current) {
      entities.push({
        category: current.category,
        original: text.slice(current.start, current.end),
        start: current.start,
        end: current.end,
        confidence: Math.round(current.score * 100) / 100,
        source: 'ner'
      })
      current = null
    }
  }

  for (let i = 0; i < aligned.length; i++) {
    const tok = aligned[i]
    if (!tok || tok.label === 'O' || tok.label === '') { flush(); continue }

    const category = mapLabel(tok.rawLabel)
    if (!category) { flush(); continue }

    const contiguous = current !== null && i === current.tokenIdx + 1
    const mergeable = current !== null && areMergeableLabels(current.rawLabels[0], tok.rawLabel)

    if (current && contiguous && mergeable && !tok.begin) {
      current.rawLabels.push(tok.rawLabel)
      current.end = tok.end
      current.score = Math.min(current.score, tok.score)
      current.tokenIdx = i
    } else {
      flush()
      current = {
        category,
        rawLabels: [tok.rawLabel],
        start: tok.start,
        end: tok.end,
        score: tok.score,
        tokenIdx: i
      }
    }
  }

  flush()
  return entities
}

/**
 * Check if two piiranha labels should be merged into one entity.
 * E.g., GIVENNAME + SURNAME → PERSON
 */
function areMergeableLabels(labelA: string, labelB: string): boolean {
  if (labelA === labelB) return true

  // GIVENNAME + SURNAME (or vice versa) merge into PERSON
  const nameLabels = new Set(['GIVENNAME', 'SURNAME'])
  if (nameLabels.has(labelA) && nameLabels.has(labelB)) return true

  return false
}

/**
 * Map NER labels to PIICategory. BIO prefixes are already stripped.
 *
 * ACTIVE MODEL — bert-base-multilingual-cased-ner-hrl: PER, ORG, LOC, DATE.
 * PREVIOUS MODEL — piiranha-v1: GIVENNAME, SURNAME, CITY, STREET,
 * BUILDINGNUM, ZIPCODE, EMAIL, TELEPHONENUM, DATEOFBIRTH, SOCIALNUM,
 * CREDITCARDNUMBER, ACCOUNTNUM, IDCARDNUM, DRIVERLICENSENUM, TAXNUM,
 * PASSWORD, USERNAME. Its labels stay mapped so a swap back needs no code
 * change — see model-manager.ts for why the swap happened.
 *
 * DATE is deliberately NOT mapped. The active model tags every date, not
 * only birth dates; routing them to DATE_OF_BIRTH would shift meeting dates
 * and deadlines as if they were personal data. Birth dates keep their
 * regex-layer coverage (`regex-detector.ts` matches a date with a cue such
 * as "geboren am" or "DOB:"). Measured cost of dropping DATE: a bare year
 * without a cue ("geboren 1980") is no longer detected — piiranha caught
 * that one at confidence 0.69.
 */
function mapLabel(label: string): string | null {
  const map: Record<string, string> = {
    // Person names
    GIVENNAME: 'PERSON',
    SURNAME: 'PERSON',
    // Locations
    CITY: 'LOCATION',
    STREET: 'ADDRESS',
    BUILDINGNUM: 'ADDRESS',
    ZIPCODE: 'LOCATION',
    // Contact
    EMAIL: 'EMAIL',
    TELEPHONENUM: 'PHONE',
    // Identity documents
    DATEOFBIRTH: 'DATE_OF_BIRTH',
    SOCIALNUM: 'AHV',
    CREDITCARDNUMBER: 'CREDIT_CARD',
    ACCOUNTNUM: 'IBAN',
    IDCARDNUM: 'PASSPORT',
    DRIVERLICENSENUM: 'PASSPORT',
    TAXNUM: 'AHV',
    // Digital identity
    PASSWORD: 'CUSTOM',
    USERNAME: 'CUSTOM',
    // Legacy BIO-style labels (for compatibility)
    PER: 'PERSON',
    PERSON: 'PERSON',
    ORG: 'ORGANIZATION',
    ORGANIZATION: 'ORGANIZATION',
    LOC: 'LOCATION',
    LOCATION: 'LOCATION',
    GPE: 'LOCATION',
    STREET_ADDRESS: 'ADDRESS',
    ADDRESS: 'ADDRESS'
  }
  return map[label] ?? null
}

// Message handler
parentPort?.on('message', async (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'init':
      await initPipeline(msg.modelId, msg.cacheDir)
      break
    case 'detect':
      await detect(msg.text, msg.requestId)
      break
    case 'shutdown':
      if (pipe?.dispose) await pipe.dispose()
      process.exit(0)
      break
  }
})
