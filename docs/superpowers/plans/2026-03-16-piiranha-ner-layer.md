# piiranha-v1 NER Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Layer 3 NER-based PII detection (piiranha-v1) to Mingly's privacy pipeline via Worker Thread with lazy model download.

**Architecture:** `@xenova/transformers` runs in a Node.js Worker Thread (`ner-worker.ts`), managed by `model-manager.ts` for download/cache and `ner-detector.ts` as the API layer. The existing `detector-pipeline.ts` becomes async and merges NER entities with Regex+Swiss results. New IPC channels expose NER status/download/delete to the renderer.

**Tech Stack:** TypeScript, @xenova/transformers (v2.17.2, already installed), Node.js worker_threads, Electron IPC

**Spec:** `docs/superpowers/specs/2026-03-16-piiranha-ner-layer-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/main/privacy/model-manager.ts` | Model download, cache check, version, delete |
| `src/main/privacy/ner-worker.ts` | Worker Thread: load model, run inference, return entities |
| `src/main/privacy/ner-detector.ts` | API layer: spawn worker, send text, handle timeout/fallback |
| `tests/unit/privacy-model-manager.test.ts` | Model manager tests |
| `tests/unit/privacy-ner-detector.test.ts` | NER detector + worker communication tests |
| `tests/unit/privacy-detector-pipeline-ner.test.ts` | 3-layer merge + dedup tests |

### Modified Files
| File | Change |
|------|--------|
| `src/main/privacy/detector-pipeline.ts` | Make `detectPII` async, add NER layer, update dedup rules |
| `src/main/privacy/pii-types.ts` | Add `NERStatus` type, `ORGANIZATION` category |
| `src/shared/types.ts:707-713` | Add 3 new IPC channels |
| `src/preload/index.ts:648-670` | Add NER IPC methods to privacy section |
| `src/main/ipc/privacy-handlers.ts` | Add 3 NER handlers |
| `src/main/privacy/anonymizer.ts` | Update `anonymize()` to await async `detectPII` |
| `src/renderer/components/PrivacySettingsTab.tsx` | Add NER download/status section |
| `src/renderer/stores/privacy-store.ts` | Add NER status state |

---

## Task 1: Model Manager

**Files:**
- Create: `src/main/privacy/model-manager.ts`
- Test: `tests/unit/privacy-model-manager.test.ts`

- [ ] **Step 1: Write failing tests for model-manager**

```typescript
// tests/unit/privacy-model-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NERModelManager } from '../../src/main/privacy/model-manager'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock fs for cache directory checks
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  return { ...actual, existsSync: vi.fn(), mkdirSync: vi.fn(), rmSync: vi.fn(), readdirSync: vi.fn() }
})

describe('NERModelManager', () => {
  let manager: NERModelManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new NERModelManager()
  })

  it('returns not_downloaded when model directory does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    expect(manager.getStatus()).toBe('not_downloaded')
  })

  it('returns ready when model files exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(['onnx'] as any)
    expect(manager.getStatus()).toBe('ready')
  })

  it('returns correct model directory path', () => {
    const expected = path.join(os.homedir(), '.mingly', 'models', 'piiranha-v1')
    expect(manager.getModelDir()).toBe(expected)
  })

  it('getModelId returns piiranha model identifier', () => {
    expect(manager.getModelId()).toBe('piiranha/piiranha-v1-detect-personal-information')
  })

  it('delete removes model directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    manager.deleteModel()
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('piiranha-v1'),
      { recursive: true, force: true }
    )
  })

  it('delete is no-op when model not downloaded', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    manager.deleteModel()
    expect(fs.rmSync).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-model-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement model-manager.ts**

```typescript
// src/main/privacy/model-manager.ts
import fs from 'fs'
import path from 'path'
import os from 'os'

export type NERStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error'

const MODEL_ID = 'piiranha/piiranha-v1-detect-personal-information'
const MODEL_DIR_NAME = 'piiranha-v1'

export class NERModelManager {
  private modelDir: string
  private status: NERStatus = 'not_downloaded'
  private downloadProgress = 0

  constructor(baseDir?: string) {
    this.modelDir = baseDir
      ? path.join(baseDir, MODEL_DIR_NAME)
      : path.join(os.homedir(), '.mingly', 'models', MODEL_DIR_NAME)
    this.status = this.checkLocalStatus()
  }

  getModelDir(): string {
    return this.modelDir
  }

  getModelId(): string {
    return MODEL_ID
  }

  getStatus(): NERStatus {
    this.status = this.checkLocalStatus()
    return this.status
  }

  getDownloadProgress(): number {
    return this.downloadProgress
  }

  /**
   * Download model from HuggingFace via @xenova/transformers cache.
   * Progress callback receives 0-100.
   */
  async download(onProgress?: (percent: number) => void): Promise<void> {
    this.status = 'downloading'
    this.downloadProgress = 0

    try {
      // Ensure directory exists
      fs.mkdirSync(path.dirname(this.modelDir), { recursive: true })

      // @xenova/transformers handles download + caching
      const { pipeline, env } = await import('@xenova/transformers')

      // Point cache to our model directory
      env.cacheDir = path.dirname(this.modelDir)
      env.allowRemoteModels = true

      // Loading the pipeline triggers download
      const pipe = await pipeline('token-classification', MODEL_ID, {
        progress_callback: (progress: any) => {
          if (progress.status === 'progress' && progress.total) {
            this.downloadProgress = Math.round((progress.loaded / progress.total) * 100)
            onProgress?.(this.downloadProgress)
          }
        }
      })

      // Dispose pipeline — worker will load its own instance
      if (pipe.dispose) await pipe.dispose()

      this.status = 'ready'
      this.downloadProgress = 100
    } catch (error) {
      this.status = 'error'
      throw error
    }
  }

  deleteModel(): void {
    if (fs.existsSync(this.modelDir)) {
      fs.rmSync(this.modelDir, { recursive: true, force: true })
    }
    this.status = 'not_downloaded'
    this.downloadProgress = 0
  }

  private checkLocalStatus(): NERStatus {
    if (!fs.existsSync(this.modelDir)) return 'not_downloaded'
    try {
      const contents = fs.readdirSync(this.modelDir)
      return contents.length > 0 ? 'ready' : 'not_downloaded'
    } catch {
      return 'not_downloaded'
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-model-manager.test.ts`
Expected: 6 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/privacy/model-manager.ts tests/unit/privacy-model-manager.test.ts
git commit -m "feat(privacy): add NER model manager for piiranha-v1 download/cache"
```

---

## Task 2: NER Worker Thread

**Files:**
- Create: `src/main/privacy/ner-worker.ts`

- [ ] **Step 1: Implement ner-worker.ts**

```typescript
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

    // Map piiranha output to PIIEntity-compatible format
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

function finalizeEntity(e: { category: string; start: number; end: number; score: number }, text: string) {
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
    'PER': 'PERSON',
    'PERSON': 'PERSON',
    'ORG': 'ORGANIZATION',
    'ORGANIZATION': 'ORGANIZATION',
    'LOC': 'LOCATION',
    'LOCATION': 'LOCATION',
    'GPE': 'LOCATION',
    'STREET_ADDRESS': 'ADDRESS',
    'ADDRESS': 'ADDRESS'
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
```

Note: This file is NOT unit-tested directly (runs in a Worker Thread). It is integration-tested via `ner-detector.ts`.

- [ ] **Step 2: Commit**

```bash
git add src/main/privacy/ner-worker.ts
git commit -m "feat(privacy): add NER worker thread for piiranha inference"
```

---

## Task 3: NER Detector (API Layer)

**Files:**
- Create: `src/main/privacy/ner-detector.ts`
- Test: `tests/unit/privacy-ner-detector.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/privacy-ner-detector.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NERDetector } from '../../src/main/privacy/ner-detector'
import type { NERModelManager } from '../../src/main/privacy/model-manager'

// Mock worker_threads
vi.mock('worker_threads', () => {
  const mockWorker = {
    on: vi.fn(),
    postMessage: vi.fn(),
    terminate: vi.fn()
  }
  return { Worker: vi.fn(() => mockWorker), isMainThread: true }
})

// Mock model-manager
vi.mock('../../src/main/privacy/model-manager', () => ({
  NERModelManager: vi.fn().mockImplementation(() => ({
    getStatus: vi.fn().mockReturnValue('not_downloaded'),
    getModelDir: vi.fn().mockReturnValue('/tmp/test-models/piiranha-v1'),
    getModelId: vi.fn().mockReturnValue('piiranha/piiranha-v1-detect-personal-information')
  }))
}))

describe('NERDetector', () => {
  let detector: NERDetector

  beforeEach(() => {
    detector = new NERDetector()
  })

  afterEach(() => {
    detector.shutdown()
  })

  it('isAvailable returns false when model not downloaded', () => {
    expect(detector.isAvailable()).toBe(false)
  })

  it('detect returns empty array when model not available', async () => {
    const result = await detector.detect('Hans Mueller aus Zuerich')
    expect(result).toEqual([])
  })

  it('detect returns empty array on timeout', async () => {
    // Simulate model ready but worker hangs
    const managerMock = detector['modelManager'] as any
    managerMock.getStatus = vi.fn().mockReturnValue('ready')

    // detect with very short timeout
    const result = await detector.detect('test', 1)
    expect(result).toEqual([])
  })

  it('shutdown terminates worker if running', () => {
    detector.shutdown()
    // Should not throw
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-ner-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ner-detector.ts**

```typescript
// src/main/privacy/ner-detector.ts
import { Worker } from 'worker_threads'
import path from 'path'
import type { PIIEntity } from './pii-types'
import { NERModelManager } from './model-manager'
import { PII_SENSITIVITY } from './pii-types'

const INFERENCE_TIMEOUT_MS = 5000
let requestCounter = 0

export class NERDetector {
  private worker: Worker | null = null
  private modelManager: NERModelManager
  private isReady = false
  private pendingRequests = new Map<string, {
    resolve: (entities: PIIEntity[]) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(modelManager?: NERModelManager) {
    this.modelManager = modelManager ?? new NERModelManager()
  }

  isAvailable(): boolean {
    return this.modelManager.getStatus() === 'ready'
  }

  getModelManager(): NERModelManager {
    return this.modelManager
  }

  async detect(text: string, timeoutMs = INFERENCE_TIMEOUT_MS): Promise<PIIEntity[]> {
    if (!this.isAvailable()) return []

    try {
      await this.ensureWorker()
      if (!this.isReady) return []

      return await this.sendDetectRequest(text, timeoutMs)
    } catch {
      return []
    }
  }

  shutdown(): void {
    // Clear pending requests
    for (const [, { resolve, timer }] of this.pendingRequests) {
      clearTimeout(timer)
      resolve([])
    }
    this.pendingRequests.clear()

    // Terminate worker
    if (this.worker) {
      this.worker.postMessage({ type: 'shutdown' })
      this.worker = null
      this.isReady = false
    }
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.isReady) return

    const workerPath = path.join(__dirname, 'ner-worker.js')
    this.worker = new Worker(workerPath)

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker init timeout'))
      }, 30_000) // 30s for model loading

      this.worker!.on('message', (msg: any) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          this.isReady = true
          resolve()
        } else if (msg.type === 'result' || msg.type === 'error') {
          this.handleWorkerResponse(msg)
        }
      })

      this.worker!.on('error', (err) => {
        clearTimeout(timeout)
        this.isReady = false
        reject(err)
      })

      this.worker!.on('exit', () => {
        this.isReady = false
        this.worker = null
      })

      // Init with model path
      this.worker!.postMessage({
        type: 'init',
        modelId: this.modelManager.getModelId(),
        cacheDir: path.dirname(this.modelManager.getModelDir())
      })
    })
  }

  private sendDetectRequest(text: string, timeoutMs: number): Promise<PIIEntity[]> {
    const requestId = `ner-${++requestCounter}`

    return new Promise<PIIEntity[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        resolve([]) // Timeout = graceful degradation
      }, timeoutMs)

      this.pendingRequests.set(requestId, { resolve, timer })
      this.worker!.postMessage({ type: 'detect', text, requestId })
    })
  }

  private handleWorkerResponse(msg: any): void {
    const pending = this.pendingRequests.get(msg.requestId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingRequests.delete(msg.requestId)

    if (msg.type === 'error') {
      pending.resolve([])
      return
    }

    // Enrich with sensitivity
    const entities: PIIEntity[] = (msg.entities || [])
      .filter((e: any) => e.original && e.original.trim().length > 0)
      .map((e: any) => ({
        ...e,
        sensitivity: PII_SENSITIVITY[e.category as keyof typeof PII_SENSITIVITY] ?? 'medium'
      }))

    pending.resolve(entities)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-ner-detector.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/privacy/ner-detector.ts tests/unit/privacy-ner-detector.test.ts
git commit -m "feat(privacy): add NER detector API layer with timeout + fallback"
```

---

## Task 4: Update pii-types.ts

**Files:**
- Modify: `src/main/privacy/pii-types.ts:6-21`

- [ ] **Step 1: Add ORGANIZATION category and NERStatus type**

Add `'ORGANIZATION'` to `PIICategory` union (after `PERSON`).
Add `NERStatus` type export.
Add `ORGANIZATION: 'medium'` to `PII_SENSITIVITY`.

In `pii-types.ts`:
```typescript
// After line 7 ('PERSON'):
  | 'ORGANIZATION'     // Company/org names

// After line 103 (CUSTOM sensitivity):
  ORGANIZATION: 'medium',

// After AnonymizationResult (end of file):
export type NERStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error'
```

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-`
Expected: All existing privacy tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/privacy/pii-types.ts
git commit -m "feat(privacy): add ORGANIZATION category and NERStatus type"
```

---

## Task 5: Make detector-pipeline async + add NER layer

**Files:**
- Modify: `src/main/privacy/detector-pipeline.ts`
- Test: `tests/unit/privacy-detector-pipeline-ner.test.ts`

- [ ] **Step 1: Write failing tests for async pipeline + NER merge**

```typescript
// tests/unit/privacy-detector-pipeline-ner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PIIEntity } from '../../src/main/privacy/pii-types'

// Mock NER detector
const mockDetect = vi.fn().mockResolvedValue([])
const mockIsAvailable = vi.fn().mockReturnValue(false)
vi.mock('../../src/main/privacy/ner-detector', () => ({
  NERDetector: vi.fn().mockImplementation(() => ({
    detect: mockDetect,
    isAvailable: mockIsAvailable,
    shutdown: vi.fn()
  }))
}))

describe('detectPII with NER layer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detectPII returns promise (is async)', async () => {
    const { detectPII } = await import('../../src/main/privacy/detector-pipeline')
    const result = detectPII('hello')
    expect(result).toBeInstanceOf(Promise)
  })

  it('still works without NER (graceful degradation)', async () => {
    mockIsAvailable.mockReturnValue(false)
    const { detectPII } = await import('../../src/main/privacy/detector-pipeline')
    const result = await detectPII('hans@test.ch')
    expect(result.entities.length).toBeGreaterThan(0)
    expect(result.entities[0].category).toBe('EMAIL')
  })

  it('merges NER entities with regex+swiss', async () => {
    mockIsAvailable.mockReturnValue(true)
    mockDetect.mockResolvedValue([{
      category: 'PERSON',
      original: 'Hans Mueller',
      start: 0,
      end: 12,
      confidence: 0.95,
      source: 'ner',
      sensitivity: 'high'
    }] as PIIEntity[])

    const { detectPII } = await import('../../src/main/privacy/detector-pipeline')
    const result = await detectPII('Hans Mueller hans@test.ch')
    const categories = result.entities.map(e => e.category)
    expect(categories).toContain('PERSON')
    expect(categories).toContain('EMAIL')
  })

  it('NER wins over regex for same span', async () => {
    mockIsAvailable.mockReturnValue(true)
    mockDetect.mockResolvedValue([{
      category: 'LOCATION',
      original: 'Zuerich',
      start: 0,
      end: 7,
      confidence: 0.95,
      source: 'ner',
      sensitivity: 'medium'
    }] as PIIEntity[])

    const { detectPII } = await import('../../src/main/privacy/detector-pipeline')
    // Assuming Swiss detector also finds Zuerich with 0.8 confidence
    const result = await detectPII('Zuerich')
    const zurichEntities = result.entities.filter(e => e.original === 'Zuerich')
    // Should only have one (deduplicated)
    expect(zurichEntities.length).toBeLessThanOrEqual(1)
  })

  it('Swiss wins over NER for AHV numbers', async () => {
    const ahv = '756.1234.5678.97'
    mockIsAvailable.mockReturnValue(true)
    mockDetect.mockResolvedValue([]) // NER unlikely to detect AHV

    const { detectPII } = await import('../../src/main/privacy/detector-pipeline')
    const result = await detectPII(ahv)
    const ahvEntity = result.entities.find(e => e.category === 'AHV')
    if (ahvEntity) {
      expect(ahvEntity.source).toBe('swiss')
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-detector-pipeline-ner.test.ts`
Expected: FAIL — detectPII is not async yet

- [ ] **Step 3: Update detector-pipeline.ts to be async + integrate NER**

Replace the full content of `src/main/privacy/detector-pipeline.ts`:

```typescript
/**
 * PII Detector Pipeline
 * Orchestrates detection across multiple sources: Regex -> Swiss -> NER (piiranha-v1).
 * Merges and deduplicates results, returns sorted entities.
 */

import type { PIIEntity, PIICategory, DetectionResult } from './pii-types'
import { detectWithRegex } from './regex-detector'
import { detectSwissPII } from './swiss-detector'
import { NERDetector } from './ner-detector'

// Singleton NER detector — initialized lazily
let nerDetector: NERDetector | null = null

function getNERDetector(): NERDetector {
  if (!nerDetector) {
    nerDetector = new NERDetector()
  }
  return nerDetector
}

/** Allow injecting a mock detector for testing */
export function setNERDetector(detector: NERDetector | null): void {
  nerDetector = detector
}

/**
 * Run all detectors and merge results.
 * Entities are deduplicated (overlapping spans keep the higher-priority one)
 * and sorted by position.
 */
export async function detectPII(text: string): Promise<DetectionResult> {
  const start = performance.now()

  // Layer 1: Regex patterns (emails, phones, IPs, credit cards, etc.)
  const regexEntities = detectWithRegex(text)

  // Layer 2: Swiss-specific patterns (AHV, CH-IBAN, CH-phones, cities)
  const swissEntities = detectSwissPII(text)

  // Layer 3: NER/ONNX model (piiranha-v1)
  const ner = getNERDetector()
  const nerEntities = ner.isAvailable() ? await ner.detect(text) : []

  // Merge all entities
  const allEntities = [...regexEntities, ...swissEntities, ...nerEntities]

  // Deduplicate overlapping spans
  const deduped = deduplicateEntities(allEntities)

  // Sort by position
  deduped.sort((a, b) => a.start - b.start)

  // Build stats
  const stats = {} as Record<PIICategory, number>
  for (const entity of deduped) {
    stats[entity.category] = (stats[entity.category] ?? 0) + 1
  }

  return {
    entities: deduped,
    originalText: text,
    latencyMs: Math.round(performance.now() - start),
    stats
  }
}

/**
 * Remove overlapping entities, preferring:
 * 1. Swiss-specific over generic regex (more precise, e.g. AHV checksums)
 * 2. NER over regex (contextual understanding)
 * 3. Swiss over NER for Swiss-specific types (AHV, CH-IBAN — checksum validation)
 * 4. Higher confidence
 * 5. Longer match
 */
const SWISS_SPECIFIC_CATEGORIES = new Set(['AHV', 'IBAN'])

function deduplicateEntities(entities: PIIEntity[]): PIIEntity[] {
  if (entities.length <= 1) return entities

  // Sort by start position, then by length descending
  const sorted = [...entities].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start)
  )

  const result: PIIEntity[] = []

  for (const entity of sorted) {
    // Check if this entity overlaps with any already-accepted entity
    const overlapping = result.find(
      existing => entity.start < existing.end && entity.end > existing.start
    )

    if (!overlapping) {
      result.push(entity)
      continue
    }

    // Rule 1: Swiss > Regex
    if (entity.source === 'swiss' && overlapping.source === 'regex') {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Rule 2: NER > Regex
    if (entity.source === 'ner' && overlapping.source === 'regex') {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Rule 3: Swiss > NER for Swiss-specific categories
    if (entity.source === 'swiss' && overlapping.source === 'ner' &&
        SWISS_SPECIFIC_CATEGORIES.has(entity.category)) {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Rule 4: Higher confidence
    if (entity.confidence > overlapping.confidence) {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Otherwise skip (keep existing)
  }

  return result
}

export { deduplicateEntities }
```

- [ ] **Step 4: Run NER pipeline tests**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-detector-pipeline-ner.test.ts`
Expected: 5 PASS

- [ ] **Step 5: Update existing pipeline test for async**

In `tests/unit/privacy-detector-pipeline.test.ts`, update all `detectPII()` calls to use `await` and mark test functions as `async`. The function signature changed from sync to async.

- [ ] **Step 6: Run ALL existing privacy tests**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy-`
Expected: ALL PASS (old + new)

- [ ] **Step 7: Commit**

```bash
git add src/main/privacy/detector-pipeline.ts tests/unit/privacy-detector-pipeline-ner.test.ts tests/unit/privacy-detector-pipeline.test.ts
git commit -m "feat(privacy): make detector pipeline async + integrate NER layer 3"
```

---

## Task 6: Update anonymizer.ts for async detectPII

**Files:**
- Modify: `src/main/privacy/anonymizer.ts`

- [ ] **Step 1: Find and update the anonymize method**

The `anonymize()` method in `PIIAnonymizer` calls `detectPII(text)` synchronously. Change it to `async anonymize()` and `await detectPII(text)`.

Search for: `detectPII(text)` in anonymizer.ts and add `await`. Change method signature to `async`.

- [ ] **Step 2: Update privacy-handlers.ts for async anonymize**

In `src/main/ipc/privacy-handlers.ts`, the `PRIVACY_ANONYMIZE` handler calls `anon.anonymize(text)`. Make the handler callback `async` and `await` the result. Same for `PRIVACY_DETECT_PII` which calls `detectPII(text)`.

- [ ] **Step 3: Run all privacy tests**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy- tests/unit/chat-store-privacy`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/privacy/anonymizer.ts src/main/ipc/privacy-handlers.ts
git commit -m "refactor(privacy): update anonymizer + handlers for async detectPII"
```

---

## Task 7: IPC Channels + Preload for NER

**Files:**
- Modify: `src/shared/types.ts:707-713`
- Modify: `src/preload/index.ts:648-670`
- Modify: `src/main/ipc/privacy-handlers.ts`

- [ ] **Step 1: Add IPC channels to types.ts**

After line 713 (`PRIVACY_DETECT_PII`), add:
```typescript
  PRIVACY_NER_STATUS: 'privacy:ner-status',
  PRIVACY_NER_DOWNLOAD: 'privacy:ner-download',
  PRIVACY_NER_DELETE: 'privacy:ner-delete',
```

- [ ] **Step 2: Add preload methods**

In `src/preload/index.ts`, extend the `privacy` section (after `detectPII` at line 669):
```typescript
    nerStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PRIVACY_NER_STATUS),

    nerDownload: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PRIVACY_NER_DOWNLOAD),

    nerDelete: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PRIVACY_NER_DELETE),

    onNerProgress: (callback: (percent: number) => void) => {
      const listener = (_event: any, percent: number) => callback(percent)
      ipcRenderer.on('privacy:ner-progress', listener)
      return () => ipcRenderer.removeListener('privacy:ner-progress', listener)
    },
```

- [ ] **Step 3: Add IPC handlers**

In `src/main/ipc/privacy-handlers.ts`, import `NERDetector` and add handlers inside `registerPrivacyHandlers()`:

```typescript
import { NERDetector } from '../privacy/ner-detector'

// At module level:
let nerDetector: NERDetector | null = null
function getNERDetector(): NERDetector {
  if (!nerDetector) nerDetector = new NERDetector()
  return nerDetector
}

// Inside registerPrivacyHandlers():

  // NER Model Status
  wrapHandler(IPC_CHANNELS.PRIVACY_NER_STATUS, () => {
    const ner = getNERDetector()
    const manager = ner.getModelManager()
    return {
      status: manager.getStatus(),
      progress: manager.getDownloadProgress()
    }
  })

  // NER Model Download (triggers async download)
  wrapHandler(IPC_CHANNELS.PRIVACY_NER_DOWNLOAD, async () => {
    const ner = getNERDetector()
    const manager = ner.getModelManager()
    try {
      await manager.download((percent) => {
        // Send progress to renderer via BrowserWindow
        const { BrowserWindow } = require('electron')
        BrowserWindow.getAllWindows().forEach(win => {
          win.webContents.send('privacy:ner-progress', percent)
        })
      })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // NER Model Delete
  wrapHandler(IPC_CHANNELS.PRIVACY_NER_DELETE, () => {
    const ner = getNERDetector()
    ner.getModelManager().deleteModel()
    ner.shutdown()
    return { success: true }
  })
```

- [ ] **Step 4: Run TypeCheck**

Run: `cd ~/mingly && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts src/main/ipc/privacy-handlers.ts
git commit -m "feat(privacy): add NER status/download/delete IPC channels"
```

---

## Task 8: Privacy Store + Settings UI for NER

**Files:**
- Modify: `src/renderer/stores/privacy-store.ts`
- Modify: `src/renderer/components/PrivacySettingsTab.tsx`

- [ ] **Step 1: Add NER state to privacy store**

Add to the Zustand store:
```typescript
// State
nerStatus: 'not_downloaded' | 'downloading' | 'ready' | 'error'
nerProgress: number

// Actions
loadNerStatus: () => Promise<void>
downloadNerModel: () => Promise<void>
deleteNerModel: () => Promise<void>
```

Implementation:
```typescript
nerStatus: 'not_downloaded',
nerProgress: 0,

loadNerStatus: async () => {
  const result = await window.electronAPI.privacy.nerStatus()
  set({ nerStatus: result.status, nerProgress: result.progress })
},

downloadNerModel: async () => {
  set({ nerStatus: 'downloading', nerProgress: 0 })
  const cleanup = window.electronAPI.privacy.onNerProgress((percent: number) => {
    set({ nerProgress: percent })
  })
  try {
    const result = await window.electronAPI.privacy.nerDownload()
    if (result.success) {
      set({ nerStatus: 'ready', nerProgress: 100 })
    } else {
      set({ nerStatus: 'error' })
    }
  } catch {
    set({ nerStatus: 'error' })
  } finally {
    cleanup()
  }
},

deleteNerModel: async () => {
  await window.electronAPI.privacy.nerDelete()
  set({ nerStatus: 'not_downloaded', nerProgress: 0 })
},
```

- [ ] **Step 2: Add NER section to PrivacySettingsTab**

After the `PrivacyModeSwitcher` component in `PrivacySettingsTab.tsx` (after line 178), add a `NERModelSection` component:

```tsx
const NERModelSection = memo(function NERModelSection() {
  const nerStatus = usePrivacyStore((s) => s.nerStatus)
  const nerProgress = usePrivacyStore((s) => s.nerProgress)
  const loadNerStatus = usePrivacyStore((s) => s.loadNerStatus)
  const downloadNerModel = usePrivacyStore((s) => s.downloadNerModel)
  const deleteNerModel = usePrivacyStore((s) => s.deleteNerModel)

  useEffect(() => { loadNerStatus() }, [loadNerStatus])

  const statusConfig = {
    not_downloaded: { label: 'Nicht installiert', color: 'bg-gray-400', textColor: 'text-gray-600 dark:text-gray-400' },
    downloading: { label: 'Wird geladen...', color: 'bg-yellow-400', textColor: 'text-yellow-600 dark:text-yellow-400' },
    ready: { label: 'Bereit', color: 'bg-green-400', textColor: 'text-green-600 dark:text-green-400' },
    error: { label: 'Fehler', color: 'bg-red-400', textColor: 'text-red-600 dark:text-red-400' }
  }

  const config = statusConfig[nerStatus]

  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
          Personennamen-Erkennung (NER)
        </h4>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${config.color}`} />
          <span className={`text-xs ${config.textColor}`}>{config.label}</span>
        </div>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        piiranha-v1 erkennt Personennamen in DE, EN, FR und IT (~200 MB Download).
      </p>

      {nerStatus === 'downloading' && (
        <div className="mb-3">
          <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-2 rounded-full bg-blue-500 transition-all"
              style={{ width: `${nerProgress}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 mt-1">{nerProgress}%</span>
        </div>
      )}

      <div className="flex gap-2">
        {nerStatus === 'not_downloaded' && (
          <button
            onClick={downloadNerModel}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            Modell herunterladen
          </button>
        )}
        {nerStatus === 'ready' && (
          <button
            onClick={deleteNerModel}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            Modell entfernen
          </button>
        )}
        {nerStatus === 'error' && (
          <button
            onClick={downloadNerModel}
            className="rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-700"
          >
            Erneut versuchen
          </button>
        )}
      </div>
    </div>
  )
})
```

Then add `<NERModelSection />` in the JSX after `<PrivacyModeSwitcher />` (line 178).

- [ ] **Step 3: Run TypeCheck**

Run: `cd ~/mingly && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `cd ~/mingly && npx vitest run`
Expected: ALL PASS (1223+ tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/privacy-store.ts src/renderer/components/PrivacySettingsTab.tsx
git commit -m "feat(privacy): add NER model download UI + store integration"
```

---

## Task 9: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd ~/mingly && npx vitest run`
Expected: ALL tests pass (1223 + ~30 new = ~1253+)

- [ ] **Step 2: TypeCheck**

Run: `cd ~/mingly && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Verify existing privacy tests still pass**

Run: `cd ~/mingly && npx vitest run tests/unit/privacy- tests/unit/chat-store-privacy`
Expected: ALL PASS

- [ ] **Step 4: Verify no regressions in chat-store integration**

The `chat-store.ts` calls `anonymize()` which now calls async `detectPII()`. Since `anonymize()` was already awaited in the chat-store (it was made async in Phase 7b.3), this should work without changes. Verify by running:

Run: `cd ~/mingly && npx vitest run tests/unit/chat-store-privacy.test.ts`
Expected: 8 PASS
