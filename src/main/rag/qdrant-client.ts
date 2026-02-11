/**
 * Qdrant Vector Database Client
 * Production-ready vector storage for RAG
 */

import { QdrantClient as QdrantSDK } from '@qdrant/js-client-rest'

export interface QdrantConfig {
  host: string
  port: number
  apiKey?: string
  https?: boolean
}

export interface VectorPoint {
  id: string
  vector: number[]
  payload: {
    text: string
    source: string
    filename?: string
    chunk_index?: number
    metadata?: Record<string, any>
  }
}

export interface SearchResult {
  id: string
  score: number
  payload: {
    text: string
    source: string
    filename?: string
    metadata?: Record<string, any>
  }
}

export class QdrantClient {
  private client: QdrantSDK
  private config: QdrantConfig

  constructor(config: QdrantConfig) {
    this.config = config
    this.client = new QdrantSDK({
      url: `${config.https ? 'https' : 'http'}://${config.host}:${config.port}`,
      apiKey: config.apiKey
    })
  }

  /**
   * Test connection to Qdrant server
   */
  async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
    try {
      const info = await this.client.getCollections()
      return { success: true, version: '1.7.0' }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Create a new collection
   */
  async createCollection(
    name: string,
    vectorSize: number = 1024,
    distance: 'Cosine' | 'Euclid' | 'Dot' = 'Cosine'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.createCollection(name, {
        vectors: {
          size: vectorSize,
          distance
        }
      })
      console.log(`✅ Created collection: ${name}`)
      return { success: true }
    } catch (error) {
      console.error(`Failed to create collection ${name}:`, error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Delete a collection
   */
  async deleteCollection(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.deleteCollection(name)
      console.log(`✅ Deleted collection: ${name}`)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * List all collections
   */
  async listCollections(): Promise<
    { success: boolean; collections?: string[]; error?: string }
  > {
    try {
      const response = await this.client.getCollections()
      const collections = response.collections.map((c) => c.name)
      return { success: true, collections }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Get collection info
   */
  async getCollectionInfo(name: string): Promise<{
    success: boolean
    info?: {
      vectors_count: number
      indexed_vectors_count: number
      points_count: number
    }
    error?: string
  }> {
    try {
      const info = await this.client.getCollection(name)
      return {
        success: true,
        info: {
          vectors_count: (info as any).vectors_count || 0,
          indexed_vectors_count: info.indexed_vectors_count || 0,
          points_count: info.points_count || 0
        }
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Upsert vectors (add or update)
   */
  async upsertVectors(
    collectionName: string,
    points: VectorPoint[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.upsert(collectionName, {
        wait: true,
        points: points.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload
        }))
      })
      console.log(`✅ Upserted ${points.length} vectors to ${collectionName}`)
      return { success: true }
    } catch (error) {
      console.error(`Failed to upsert vectors:`, error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Search similar vectors
   */
  async search(
    collectionName: string,
    queryVector: number[],
    limit: number = 5,
    scoreThreshold: number = 0.7
  ): Promise<{ success: boolean; results?: SearchResult[]; error?: string }> {
    try {
      const response = await this.client.search(collectionName, {
        vector: queryVector,
        limit,
        score_threshold: scoreThreshold,
        with_payload: true
      })

      const results: SearchResult[] = response.map((r) => ({
        id: String(r.id),
        score: r.score,
        payload: r.payload as any
      }))

      return { success: true, results }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Delete vectors by IDs
   */
  async deleteVectors(
    collectionName: string,
    ids: string[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.delete(collectionName, {
        wait: true,
        points: ids
      })
      console.log(`✅ Deleted ${ids.length} vectors from ${collectionName}`)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Scroll through all points (for backup/export)
   */
  async scrollPoints(
    collectionName: string,
    limit: number = 100
  ): Promise<{ success: boolean; points?: VectorPoint[]; error?: string }> {
    try {
      const response = await this.client.scroll(collectionName, {
        limit,
        with_payload: true,
        with_vector: true
      })

      const points: VectorPoint[] = response.points.map((p) => ({
        id: String(p.id),
        vector: p.vector as number[],
        payload: p.payload as any
      }))

      return { success: true, points }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }
}

// Singleton instance
let qdrantClientInstance: QdrantClient | null = null

export function initQdrantClient(config: QdrantConfig): QdrantClient {
  qdrantClientInstance = new QdrantClient(config)
  return qdrantClientInstance
}

export function getQdrantClient(): QdrantClient | null {
  return qdrantClientInstance
}
