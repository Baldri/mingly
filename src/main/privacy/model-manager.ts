import fs from 'fs'
import path from 'path'
import os from 'os'

export type NERStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error'

const MODEL_ID = 'onnx-community/piiranha-v1-detect-personal-information-ONNX'
const DEFAULT_BASE_DIR = path.join(os.homedir(), '.mingly', 'models')

export class NERModelManager {
  private baseDir: string
  private modelDir: string
  private status: NERStatus = 'not_downloaded'
  private downloadProgress = 0

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_BASE_DIR
    // @huggingface/transformers caches in {cacheDir}/{org}/{model-name}/ (same layout as @xenova v2)
    this.modelDir = path.join(this.baseDir, ...MODEL_ID.split('/'))
    this.status = this.checkLocalStatus()
  }

  getModelDir(): string {
    return this.modelDir
  }

  /** Returns the base cache directory (used as env.cacheDir) */
  getCacheDir(): string {
    return this.baseDir
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

  async download(onProgress?: (percent: number) => void): Promise<void> {
    this.status = 'downloading'
    this.downloadProgress = 0

    try {
      fs.mkdirSync(this.baseDir, { recursive: true })

      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = this.baseDir
      env.allowRemoteModels = true

      // fp32 (non-quantized), ~1.15GB; inference is still <50ms.
      //
      // This comment used to justify fp32 with "full GIVENNAME/SURNAME
      // detection quality — quantized model loses name recognition". Measured
      // 2026-08-05: that claim does not hold for this export. Neither variant
      // emits GIVENNAME/SURNAME at all — fp32 and model_quantized.onnx were
      // A/B'd on the same sentences and behave identically on names, while
      // both detect CITY/STREET/BUILDINGNUM/DATEOFBIRTH. So fp32 is not what
      // buys name recognition; nothing currently does. Keeping fp32 for the
      // categories that DO work, not for names.
      //
      // Do not restore the old rationale without re-measuring: it was the
      // starting premise of an investigation and pointed it the wrong way.
      const pipe = await pipeline('token-classification', MODEL_ID, {
        dtype: 'fp32',
        progress_callback: (progress: { status: string; loaded?: number; total?: number }) => {
          if (progress.status === 'progress' && progress.total) {
            this.downloadProgress = Math.round(((progress.loaded ?? 0) / progress.total) * 100)
            onProgress?.(this.downloadProgress)
          }
        }
      })

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
