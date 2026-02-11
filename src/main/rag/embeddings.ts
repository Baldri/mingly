/**
 * Text Embeddings
 * Lokale Embeddings mit Transformers.js (kein API Key nötig)
 */

// @xenova/transformers is ESM-only, so we must use dynamic import()
// in the CommonJS main process.

export class EmbeddingGenerator {
  private pipe: any | null = null
  private modelName: string
  private initialized: boolean = false

  constructor(modelName: string = 'Xenova/multilingual-e5-large') {
    this.modelName = modelName
  }

  /**
   * Initialize the embedding model
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      console.log(`🔧 Loading embedding model: ${this.modelName}...`)
      const { pipeline } = await import('@xenova/transformers')
      this.pipe = await pipeline('feature-extraction', this.modelName)
      this.initialized = true
      console.log(`✅ Embedding model loaded`)
    } catch (error) {
      console.error('Failed to load embedding model:', error)
      throw error
    }
  }

  /**
   * Generate embeddings for text
   */
  async embed(text: string): Promise<number[]> {
    if (!this.initialized || !this.pipe) {
      await this.initialize()
    }

    if (!this.pipe) {
      throw new Error('Embedding model not initialized')
    }

    try {
      // Generate embeddings
      const output = await this.pipe(text, {
        pooling: 'mean',
        normalize: true
      })

      // Convert to number array
      const embedding = Array.from(output.data as Float32Array)
      return embedding
    } catch (error) {
      console.error('Failed to generate embedding:', error)
      throw error
    }
  }

  /**
   * Generate embeddings for multiple texts (batch)
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.initialized || !this.pipe) {
      await this.initialize()
    }

    const embeddings: number[][] = []

    for (const text of texts) {
      const embedding = await this.embed(text)
      embeddings.push(embedding)
    }

    return embeddings
  }

  /**
   * Get embedding dimension
   */
  getDimension(): number {
    // multilingual-e5-large has 1024 dimensions
    return 1024
  }
}

// Singleton instance
let embeddingGeneratorInstance: EmbeddingGenerator | null = null

export function getEmbeddingGenerator(): EmbeddingGenerator {
  if (!embeddingGeneratorInstance) {
    embeddingGeneratorInstance = new EmbeddingGenerator()
  }
  return embeddingGeneratorInstance
}
