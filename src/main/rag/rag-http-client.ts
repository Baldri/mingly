/**
 * RAG HTTP Client
 * Connects to the external Python FastAPI RAG server for
 * heavy indexing, advanced document processing, and context retrieval.
 */

export interface RAGServerConfig {
  host: string
  port: number
  protocol: 'http' | 'https'
}

export interface RAGServerHealth {
  status: string
  qdrant_connected: boolean
  embedding_model_loaded: boolean
  collections_count: number
}

export interface RAGContextResponse {
  context: string
  sources: Array<{
    file_name: string
    score: number
    chunk_index: number
  }>
  total_chunks: number
  message?: string
}

export interface RAGSearchResponse {
  query: string
  results: Array<{
    id: string
    score: number
    text: string
    metadata: Record<string, any>
  }>
  total: number
}

export interface RAGIndexFileResponse {
  success: boolean
  file_name: string
  chunks_indexed: number
  collection: string
}

export interface RAGIndexDirectoryResponse {
  success: boolean
  files_indexed: number
  total_chunks: number
}

const DEFAULT_CONFIG: RAGServerConfig = {
  host: 'localhost',
  port: 8001,
  protocol: 'http'
}

export class RAGHttpClient {
  private config: RAGServerConfig
  private baseUrl: string

  constructor(config?: Partial<RAGServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.baseUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}`
  }

  updateConfig(config: Partial<RAGServerConfig>): void {
    this.config = { ...this.config, ...config }
    this.baseUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}`
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      throw new Error(`RAG Server error (${response.status}): ${errorBody}`)
    }

    return response.json() as Promise<T>
  }

  // ── Health & Info ──────────────────────────────────────────────

  async healthCheck(): Promise<{ success: boolean; data?: RAGServerHealth; error?: string }> {
    try {
      const data = await this.request<RAGServerHealth>('/api/health')
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)

      const response = await fetch(`${this.baseUrl}/api/health`, {
        signal: controller.signal
      })
      clearTimeout(timeout)

      return response.ok
    } catch {
      return false
    }
  }

  // ── Context Retrieval (for auto-injection) ─────────────────────

  async getContext(
    collectionName: string,
    query: string,
    limit: number = 3,
    scoreThreshold: number = 0.7
  ): Promise<{ success: boolean; data?: RAGContextResponse; error?: string }> {
    try {
      const data = await this.request<RAGContextResponse>(
        `/api/context/${encodeURIComponent(collectionName)}`,
        {
          method: 'POST',
          body: JSON.stringify({ query, limit, score_threshold: scoreThreshold })
        }
      )
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ── Search ─────────────────────────────────────────────────────

  async search(
    collectionName: string,
    query: string,
    limit: number = 5,
    scoreThreshold: number = 0.7
  ): Promise<{ success: boolean; data?: RAGSearchResponse; error?: string }> {
    try {
      const data = await this.request<RAGSearchResponse>(
        `/api/search/${encodeURIComponent(collectionName)}`,
        {
          method: 'POST',
          body: JSON.stringify({ query, limit, score_threshold: scoreThreshold })
        }
      )
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ── Collections ────────────────────────────────────────────────

  async listCollections(): Promise<{ success: boolean; collections?: string[]; error?: string }> {
    try {
      const data = await this.request<{ collections: string[] }>('/api/collections')
      return { success: true, collections: data.collections }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async createCollection(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request('/api/collections', {
        method: 'POST',
        body: JSON.stringify({ name })
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async deleteCollection(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(`/api/collections/${encodeURIComponent(name)}`, {
        method: 'DELETE'
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ── Indexing ───────────────────────────────────────────────────

  async indexFile(
    collectionName: string,
    filePath: string
  ): Promise<{ success: boolean; data?: RAGIndexFileResponse; error?: string }> {
    try {
      const data = await this.request<RAGIndexFileResponse>('/api/index/file', {
        method: 'POST',
        body: JSON.stringify({
          file_path: filePath,
          collection_name: collectionName
        })
      })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async indexDirectory(
    collectionName: string,
    directoryPath: string,
    recursive: boolean = true
  ): Promise<{ success: boolean; data?: RAGIndexDirectoryResponse; error?: string }> {
    try {
      const data = await this.request<RAGIndexDirectoryResponse>('/api/index/directory', {
        method: 'POST',
        body: JSON.stringify({
          directory_path: directoryPath,
          collection_name: collectionName,
          recursive
        })
      })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────

let httpClientInstance: RAGHttpClient | null = null

export function getRAGHttpClient(): RAGHttpClient {
  if (!httpClientInstance) {
    httpClientInstance = new RAGHttpClient()
  }
  return httpClientInstance
}
