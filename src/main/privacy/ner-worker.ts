// src/main/privacy/ner-worker.ts
import { parentPort } from 'worker_threads'

type WorkerMessage =
  | { type: 'init'; modelId: string; cacheDir: string }
  | { type: 'detect'; text: string; requestId: string }
  | { type: 'shutdown' }

let pipe: any = null

async function initPipeline(modelId: string, cacheDir: string): Promise<void> {
  const { pipeline, env } = await import('@xenova/transformers')
  env.cacheDir = cacheDir
  env.allowRemoteModels = false // model must be pre-downloaded
  pipe = await pipeline('token-classification', modelId)
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
 * piiranha uses BIO tagging: B-PER, I-PER, B-ORG, I-ORG, etc.
 */
function mergeTokens(tokens: any[], text: string): any[] {
  const entities: any[] = []
  let current: { category: string; start: number; end: number; score: number } | null = null

  for (const token of tokens) {
    const label = token.entity || token.entity_group || ''
    const prefix = label.substring(0, 2) // B- or I-
    const category = mapLabel(label.substring(2))

    if (!category) {
      if (current) {
        entities.push(finalizeEntity(current, text))
        current = null
      }
      continue
    }

    if (prefix === 'B-' || !current || current.category !== category) {
      if (current) entities.push(finalizeEntity(current, text))
      current = { category, start: token.start, end: token.end, score: token.score }
    } else {
      // I- continuation
      current.end = token.end
      current.score = Math.min(current.score, token.score)
    }
  }

  if (current) entities.push(finalizeEntity(current, text))
  return entities
}

function finalizeEntity(
  e: { category: string; start: number; end: number; score: number },
  text: string
) {
  return {
    category: e.category,
    original: text.slice(e.start, e.end).trim(),
    start: e.start,
    end: e.end,
    confidence: Math.round(e.score * 100) / 100,
    source: 'ner'
  }
}

/** Map piiranha NER labels to PIICategory */
function mapLabel(label: string): string | null {
  const map: Record<string, string> = {
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
