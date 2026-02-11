/**
 * RAG Manager
 * Orchestrates document processing, embedding, and retrieval
 */

import { getQdrantClient, initQdrantClient, type QdrantConfig, type VectorPoint } from './qdrant-client'
import { getEmbeddingGenerator } from './embeddings'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs/promises'
import path from 'path'

export interface DocumentChunk {
  id: string
  text: string
  source: string
  filename: string
  chunk_index: number
  metadata?: Record<string, any>
}

export interface RAGSearchResult {
  text: string
  source: string
  filename?: string
  score: number
  metadata?: Record<string, any>
}

export class RAGManager {
  private initialized: boolean = false
  private embeddingGenerator = getEmbeddingGenerator()

  /**
   * Initialize RAG system
   */
  async initialize(config: QdrantConfig): Promise<{ success: boolean; error?: string }> {
    try {
      // Initialize Qdrant client
      initQdrantClient(config)
      const client = getQdrantClient()

      if (!client) {
        throw new Error('Failed to initialize Qdrant client')
      }

      // Test connection
      const testResult = await client.testConnection()
      if (!testResult.success) {
        throw new Error(`Qdrant connection failed: ${testResult.error}`)
      }

      // Initialize embedding model
      await this.embeddingGenerator.initialize()

      this.initialized = true
      console.log('✅ RAG Manager initialized')
      return { success: true }
    } catch (error) {
      console.error('Failed to initialize RAG Manager:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Create a new collection for documents
   */
  async createCollection(name: string): Promise<{ success: boolean; error?: string }> {
    const client = getQdrantClient()
    if (!client) {
      return { success: false, error: 'Qdrant client not initialized' }
    }

    const vectorSize = this.embeddingGenerator.getDimension()
    return await client.createCollection(name, vectorSize, 'Cosine')
  }

  /**
   * Delete a collection
   */
  async deleteCollection(name: string): Promise<{ success: boolean; error?: string }> {
    const client = getQdrantClient()
    if (!client) {
      return { success: false, error: 'Qdrant client not initialized' }
    }

    return await client.deleteCollection(name)
  }

  /**
   * List all collections
   */
  async listCollections(): Promise<{ success: boolean; collections?: string[]; error?: string }> {
    const client = getQdrantClient()
    if (!client) {
      return { success: false, error: 'Qdrant client not initialized' }
    }

    return await client.listCollections()
  }

  /**
   * Get collection info
   */
  async getCollectionInfo(name: string): Promise<{
    success: boolean
    info?: { vectors_count: number; points_count: number }
    error?: string
  }> {
    const client = getQdrantClient()
    if (!client) {
      return { success: false, error: 'Qdrant client not initialized' }
    }

    return await client.getCollectionInfo(name)
  }

  /**
   * Chunk text into smaller pieces
   */
  private chunkText(text: string, chunkSize: number = 512, overlap: number = 50): string[] {
    const words = text.split(/\s+/)
    const chunks: string[] = []

    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunk = words.slice(i, i + chunkSize).join(' ')
      chunks.push(chunk)
    }

    return chunks
  }

  /**
   * Index a document (add to collection)
   */
  async indexDocument(
    collectionName: string,
    text: string,
    source: string,
    filename: string,
    metadata?: Record<string, any>
  ): Promise<{ success: boolean; chunks_indexed?: number; error?: string }> {
    const client = getQdrantClient()
    if (!client) {
      return { success: false, error: 'Qdrant client not initialized' }
    }

    try {
      // Chunk the text
      const chunks = this.chunkText(text)
      console.log(`📄 Chunking document "${filename}" into ${chunks.length} chunks`)

      // Generate embeddings for all chunks
      console.log(`🔧 Generating embeddings...`)
      const embeddings = await this.embeddingGenerator.embedBatch(chunks)

      // Create vector points
      const points: VectorPoint[] = chunks.map((chunk, index) => ({
        id: uuidv4(),
        vector: embeddings[index],
        payload: {
          text: chunk,
          source,
          filename,
          chunk_index: index,
          metadata
        }
      }))

      // Upsert to Qdrant
      const result = await client.upsertVectors(collectionName, points)

      if (result.success) {
        console.log(`✅ Indexed "${filename}" (${chunks.length} chunks)`)
        return { success: true, chunks_indexed: chunks.length }
      } else {
        return { success: false, error: result.error }
      }
    } catch (error) {
      console.error('Failed to index document:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Index a file
   */
  async indexFile(
    collectionName: string,
    filePath: string,
    metadata?: Record<string, any>
  ): Promise<{ success: boolean; chunks_indexed?: number; error?: string }> {
    try {
      // Read file
      const content = await fs.readFile(filePath, 'utf-8')
      const filename = path.basename(filePath)

      // Index the content
      return await this.indexDocument(collectionName, content, filePath, filename, metadata)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Search for similar documents
   */
  async search(
    collectionName: string,
    query: string,
    limit: number = 5,
    scoreThreshold: number = 0.7
  ): Promise<{ success: boolean; results?: RAGSearchResult[]; error?: string }> {
    const client = getQdrantClient()
    if (!client) {
      return { success: false, error: 'Qdrant client not initialized' }
    }

    try {
      // Generate embedding for query
      const queryEmbedding = await this.embeddingGenerator.embed(query)

      // Search in Qdrant
      const searchResult = await client.search(
        collectionName,
        queryEmbedding,
        limit,
        scoreThreshold
      )

      if (!searchResult.success || !searchResult.results) {
        return { success: false, error: searchResult.error }
      }

      // Format results
      const results: RAGSearchResult[] = searchResult.results.map((r) => ({
        text: r.payload.text,
        source: r.payload.source,
        filename: r.payload.filename,
        score: r.score,
        metadata: r.payload.metadata
      }))

      return { success: true, results }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Get context for LLM (search + format)
   */
  async getContext(
    collectionName: string,
    query: string,
    limit: number = 3
  ): Promise<string> {
    const searchResult = await this.search(collectionName, query, limit)

    if (!searchResult.success || !searchResult.results || searchResult.results.length === 0) {
      return ''
    }

    // Format context
    const context = searchResult.results
      .map((r, index) => {
        return `[Context ${index + 1}] (Score: ${r.score.toFixed(2)}, Source: ${r.filename || r.source})\n${r.text}`
      })
      .join('\n\n')

    return context
  }
}

// Singleton instance
let ragManagerInstance: RAGManager | null = null

export function getRAGManager(): RAGManager {
  if (!ragManagerInstance) {
    ragManagerInstance = new RAGManager()
  }
  return ragManagerInstance
}
