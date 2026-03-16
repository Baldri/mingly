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
  const { pipeline, env } = await import('@xenova/transformers')
  env.cacheDir = cacheDir
  env.allowRemoteModels = false // model must be pre-downloaded via model-manager
  // Use non-quantized (fp32) for full PII detection quality
  pipe = await pipeline('token-classification', modelId, { quantized: false })
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

/**
 * Merge adjacent sub-word tokens into full entities.
 *
 * piiranha-v1 specifics:
 * - Labels use I-* prefix only (I-GIVENNAME, I-SURNAME, I-CITY, etc.)
 * - start/end offsets may be null (ONNX models)
 * - Adjacent tokens with same/related label are merged
 * - word field contains sub-word tokens (may have leading space)
 */
function mergeTokens(tokens: any[], text: string): any[] {
  const entities: any[] = []
  let current: {
    category: string
    rawLabels: string[]
    words: string[]
    startIdx: number
    endIdx: number
    score: number
    start: number | null
    end: number | null
  } | null = null

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const label = token.entity || token.entity_group || ''

    // Skip O (Other) tokens
    if (label === 'O') {
      if (current) {
        entities.push(finalizeEntity(current, text))
        current = null
      }
      continue
    }

    // Strip I- prefix to get raw label
    const rawLabel = label.startsWith('I-') ? label.substring(2) : label
    const category = mapLabel(rawLabel)

    if (!category) {
      if (current) {
        entities.push(finalizeEntity(current, text))
        current = null
      }
      continue
    }

    // Should this token be merged with current entity?
    const shouldMerge = current !== null &&
      areMergeableLabels(current.rawLabels[0], rawLabel) &&
      i === current.endIdx + 1

    if (shouldMerge && current) {
      current.words.push(token.word)
      current.rawLabels.push(rawLabel)
      current.endIdx = i
      current.score = Math.min(current.score, token.score)
      if (token.end !== null && token.end !== undefined) {
        current.end = token.end
      }
    } else {
      if (current) entities.push(finalizeEntity(current, text))
      current = {
        category,
        rawLabels: [rawLabel],
        words: [token.word],
        startIdx: i,
        endIdx: i,
        score: token.score,
        start: token.start,
        end: token.end
      }
    }
  }

  if (current) entities.push(finalizeEntity(current, text))
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

function finalizeEntity(
  e: {
    category: string
    rawLabels: string[]
    words: string[]
    score: number
    start: number | null
    end: number | null
  },
  text: string
) {
  // If GIVENNAME + SURNAME were merged, category is PERSON
  const hasName = e.rawLabels.some(l => l === 'GIVENNAME' || l === 'SURNAME')
  const category = hasName ? 'PERSON' : e.category

  // Reconstruct text from word tokens
  const reconstructed = e.words.join('').replace(/^\s+/, '')

  // Try to find the reconstructed text in the original
  let start = e.start
  let end = e.end

  if (start === null || start === undefined || end === null || end === undefined) {
    // Offset reconstruction: find the token sequence in the original text
    const searchResult = findInText(text, reconstructed)
    start = searchResult.start
    end = searchResult.end
  }

  return {
    category,
    original: reconstructed,
    start: start ?? 0,
    end: end ?? reconstructed.length,
    confidence: Math.round(e.score * 100) / 100,
    source: 'ner'
  }
}

/**
 * Find a reconstructed token string in the original text.
 * Handles sub-word artifacts (partial matches, whitespace differences).
 */
function findInText(text: string, needle: string): { start: number; end: number } {
  // Direct search first
  const idx = text.indexOf(needle)
  if (idx !== -1) {
    return { start: idx, end: idx + needle.length }
  }

  // Case-insensitive search
  const lowerIdx = text.toLowerCase().indexOf(needle.toLowerCase())
  if (lowerIdx !== -1) {
    return { start: lowerIdx, end: lowerIdx + needle.length }
  }

  // Normalized search (collapse whitespace)
  const normalized = needle.replace(/\s+/g, ' ').trim()
  const normIdx = text.indexOf(normalized)
  if (normIdx !== -1) {
    return { start: normIdx, end: normIdx + normalized.length }
  }

  return { start: 0, end: needle.length }
}

/**
 * Map piiranha-v1 NER labels to PIICategory.
 *
 * piiranha labels: GIVENNAME, SURNAME, CITY, STREET, BUILDINGNUM,
 * ZIPCODE, EMAIL, TELEPHONENUM, DATEOFBIRTH, SOCIALNUM, CREDITCARDNUMBER,
 * ACCOUNTNUM, IDCARDNUM, DRIVERLICENSENUM, TAXNUM, PASSWORD, USERNAME
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
