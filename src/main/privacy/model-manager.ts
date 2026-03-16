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
    // @xenova/transformers caches in {cacheDir}/{org}/{model-name}/
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

      const { pipeline, env } = await import('@xenova/transformers')
      env.cacheDir = this.baseDir
      env.allowRemoteModels = true

      // Use non-quantized (fp32) model for full GIVENNAME/SURNAME detection quality.
      // Quantized model loses name recognition. fp32 is ~1.15GB but inference is still <50ms.
      const pipe = await pipeline('token-classification', MODEL_ID, {
        quantized: false,
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
