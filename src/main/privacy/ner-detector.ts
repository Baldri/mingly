// NER Detector — API layer for PII Named Entity Recognition via Worker Thread.
// Manages worker lifecycle, request/response matching, and timeout-based fallback.

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
    for (const [, { resolve, timer }] of this.pendingRequests) {
      clearTimeout(timer)
      resolve([])
    }
    this.pendingRequests.clear()

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
      }, 30_000)

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
        resolve([])
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

    const entities: PIIEntity[] = (msg.entities || [])
      .filter((e: any) => e.original && e.original.trim().length > 0)
      .map((e: any) => ({
        ...e,
        sensitivity: PII_SENSITIVITY[e.category as keyof typeof PII_SENSITIVITY] ?? 'medium'
      }))

    pending.resolve(entities)
  }
}
