/**
 * DirectNERDetector — Test helper that runs the configured NER model
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

const MODEL_ID = new NERModelManager().getModelId()
const CACHE_DIR = `${process.env.HOME}/.mingly/models`

/**
 * Label mapping and token merging are NOT duplicated here.
 *
 * They used to be — a verbatim copy of ner-worker.ts's LABEL_MAP,
 * mergeTokens, areMergeableLabels and finalizeEntity. On 2026-08-05 the
 * worker switched models and replaced token-string reconstruction with
 * offset alignment; this copy would have silently kept testing the old
 * logic against a model that no longer produces those labels, so the
 * red-team suite would have measured a pipeline that no longer exists.
 * That is the sister-code drift class from the 2026-05-13 lessons.
 *
 * Importing the real implementation costs nothing and makes this helper
 * test what production runs. The explicit `.ts` extension is required:
 * the esbuild artifact `ner-worker.js` sits next to the source and Vite
 * resolves `.js` first.
 */
import { mergeTokens } from '../../../src/main/privacy/ner-worker.ts'
import { NERModelManager } from '../../../src/main/privacy/model-manager'

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
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = CACHE_DIR
  env.allowRemoteModels = false

  console.log(`[DirectNER] Loading ${MODEL_ID} (fp32)...`)
  const startLoad = performance.now()
  const pipe = await pipeline('token-classification', MODEL_ID, { dtype: 'fp32' })
  console.log(`[DirectNER] Model loaded in ${Math.round(performance.now() - startLoad)}ms`)

  let available = true

  return {
    isAvailable: () => available,

    detect: async (text: string): Promise<PIIEntity[]> => {
      if (!available) return []
      const results = await pipe(text, { ignore_labels: [] })
      // mergeTokens accepts the raw pipeline output; no local token type
      // is needed (the previous one was removed with the duplicated logic).
      return mergeTokens(results as unknown[], text) as PIIEntity[]
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
