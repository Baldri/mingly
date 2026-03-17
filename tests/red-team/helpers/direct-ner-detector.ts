/**
 * DirectNERDetector — Test helper that runs piiranha-v1 ONNX inference
 * directly in the main thread (no Worker thread needed).
 *
 * This is only for testing. Production uses NERDetector with Worker threads
 * to avoid blocking the Electron main process.
 *
 * Usage:
 *   const detector = await createDirectNERDetector()
 *   setNERDetector(detector)
 *   // ... run tests with 3-Layer detection ...
 *   detector.shutdown()
 */

import type { PIIEntity, PIICategory } from '../../../src/main/privacy/pii-types'
import { PII_SENSITIVITY } from '../../../src/main/privacy/pii-types'

const MODEL_ID = 'onnx-community/piiranha-v1-detect-personal-information-ONNX'
const CACHE_DIR = `${process.env.HOME}/.mingly/models`

// piiranha-v1 label → PIICategory mapping (mirrors ner-worker.ts)
const LABEL_MAP: Record<string, PIICategory | null> = {
  GIVENNAME: 'PERSON',
  SURNAME: 'PERSON',
  CITY: 'LOCATION',
  STREET: 'ADDRESS',
  BUILDINGNUM: 'ADDRESS',
  ZIPCODE: 'LOCATION',
  EMAIL: 'EMAIL',
  TELEPHONENUM: 'PHONE',
  DATEOFBIRTH: 'DATE_OF_BIRTH',
  SOCIALNUM: 'AHV',
  CREDITCARDNUMBER: 'CREDIT_CARD',
  ACCOUNTNUM: 'IBAN',
  IDCARDNUM: 'PASSPORT',
  DRIVERLICENSENUM: 'PASSPORT',
  TAXNUM: 'AHV',
  PASSWORD: 'CUSTOM',
  USERNAME: 'CUSTOM',
  PER: 'PERSON',
  PERSON: 'PERSON',
  ORG: 'ORGANIZATION',
  ORGANIZATION: 'ORGANIZATION',
  LOC: 'LOCATION',
  LOCATION: 'LOCATION',
  GPE: 'LOCATION',
  STREET_ADDRESS: 'ADDRESS',
  ADDRESS: 'ADDRESS',
}

const NAME_LABELS = new Set(['GIVENNAME', 'SURNAME'])

interface TokenResult {
  entity: string
  score: number
  word: string
  start: number | null
  end: number | null
}

function mergeTokens(tokens: TokenResult[], text: string): PIIEntity[] {
  const entities: PIIEntity[] = []
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
    const label = token.entity || ''

    if (label === 'O') {
      if (current) {
        entities.push(finalizeEntity(current, text))
        current = null
      }
      continue
    }

    const rawLabel = label.startsWith('I-') ? label.substring(2) : label
    const category = LABEL_MAP[rawLabel]

    if (!category) {
      if (current) {
        entities.push(finalizeEntity(current, text))
        current = null
      }
      continue
    }

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
        end: token.end,
      }
    }
  }

  if (current) entities.push(finalizeEntity(current, text))
  return entities
}

function areMergeableLabels(labelA: string, labelB: string): boolean {
  if (labelA === labelB) return true
  if (NAME_LABELS.has(labelA) && NAME_LABELS.has(labelB)) return true
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
): PIIEntity {
  const hasName = e.rawLabels.some(l => l === 'GIVENNAME' || l === 'SURNAME')
  const category = (hasName ? 'PERSON' : e.category) as PIICategory

  const reconstructed = e.words.join('').replace(/^\s+/, '')

  let start = e.start
  let end = e.end

  if (start === null || start === undefined || end === null || end === undefined) {
    const idx = text.indexOf(reconstructed)
    if (idx !== -1) {
      start = idx
      end = idx + reconstructed.length
    } else {
      const lowerIdx = text.toLowerCase().indexOf(reconstructed.toLowerCase())
      if (lowerIdx !== -1) {
        start = lowerIdx
        end = lowerIdx + reconstructed.length
      } else {
        start = 0
        end = reconstructed.length
      }
    }
  }

  return {
    category,
    original: reconstructed,
    start: start ?? 0,
    end: end ?? reconstructed.length,
    confidence: Math.round(e.score * 100) / 100,
    source: 'ner' as const,
    sensitivity: PII_SENSITIVITY[category] ?? 'medium',
  }
}

/**
 * Creates a DirectNERDetector that loads piiranha-v1 in the current thread.
 * First call takes ~5-10s (model load), subsequent detect() calls are fast.
 */
export async function createDirectNERDetector(): Promise<{
  isAvailable: () => boolean
  detect: (text: string) => Promise<PIIEntity[]>
  shutdown: () => Promise<void>
  getModelManager: () => { getStatus: () => string }
}> {
  const { pipeline, env } = await import('@xenova/transformers')
  env.cacheDir = CACHE_DIR
  env.allowRemoteModels = false

  console.log('[DirectNER] Loading piiranha-v1 fp32 model...')
  const startLoad = performance.now()
  const pipe = await pipeline('token-classification', MODEL_ID, { quantized: false })
  console.log(`[DirectNER] Model loaded in ${Math.round(performance.now() - startLoad)}ms`)

  let available = true

  return {
    isAvailable: () => available,

    detect: async (text: string): Promise<PIIEntity[]> => {
      if (!available) return []
      const results = await pipe(text, { ignore_labels: [] })
      return mergeTokens(results as TokenResult[], text)
    },

    shutdown: async () => {
      available = false
      if (pipe.dispose) await pipe.dispose()
    },

    getModelManager: () => ({
      getStatus: () => available ? 'ready' : 'not_downloaded',
    }),
  }
}
