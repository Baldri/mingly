import fs from 'fs'
import path from 'path'
import os from 'os'

export type NERStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error'

/**
 * Layer-3 NER model.
 *
 * Chosen 2026-08-05 BY MEASUREMENT against a 20-span ground-truth battery
 * (`scripts/ner-eval/`), after the previous model was found unable to do the
 * one job the privacy UI advertised. Numbers from that run:
 *
 *   model                                    persons  false  locations  ms   MB
 *   bert-base-multilingual-cased-ner-hrl     19/20    0      9/9        12   712
 *   distilbert-base-multilingual-…-ner-hrl   19/20    0      8/9         7   542
 *   piiranha-v1 (previous)                    2/20    0      4/9        22  1483
 *
 * distilbert is smaller and faster but missed "Olten" — a Swiss town, which
 * is exactly the population this product serves. The two are otherwise tied,
 * including their single shared miss ("Dr. Jane Q. Public").
 *
 * The swap is a net gain on every axis that was measured EXCEPT two, named
 * here so the cost is not hidden: this model has no BUILDINGNUM label, so a
 * house number is no longer redacted (the street itself is — it comes back
 * as LOC), and it has no DATEOFBIRTH label, so a bare year without a cue
 * ("geboren 1980") is missed. Cued birth dates keep their regex coverage.
 *
 * Do not swap this back on a model card alone. piiranha's card documents
 * 93%/78% recall for GIVENNAME/SURNAME; measured here it delivered 2 of 20,
 * and its PyTorch original behaves identically — so the card describes its
 * own test distribution, not this one.
 */
const MODEL_ID = 'Xenova/bert-base-multilingual-cased-ner-hrl'
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

      // fp32 (non-quantized), ~712MB measured on disk; ~12ms per inference,
      // well inside the latency class the settings panel states.
      //
      // Historical note, kept because it cost a full investigation: this
      // comment used to justify fp32 with "full GIVENNAME/SURNAME detection
      // quality — quantized model loses name recognition", for the previous
      // model. That was measurably wrong (fp32 and quantized behaved
      // identically on names — neither detected any) and it sent the search
      // for the cause in the wrong direction. A dtype choice is not a
      // capability claim; if one is made here again, it needs a measurement
      // next to it.
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
