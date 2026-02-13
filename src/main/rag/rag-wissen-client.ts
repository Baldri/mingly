/**
 * RAG-Wissen Client
 *
 * Connects to the RAG-Wissen external knowledge base server.
 * This is a separate Python FastAPI server (typically on port 8001)
 * that provides semantic search over indexed documents via its own
 * Qdrant instance and embedding model.
 *
 * Compared to the generic RAGHttpClient, this client targets the
 * RAG-Wissen-specific API endpoints and response formats.
 */

import { SimpleStore } from '../utils/simple-store'

export interface RAGWissenConfig {
  host: string
  port: number
  protocol: 'http' | 'https'
  enabled: boolean
  /** Default collection to search */
  defaultCollection: string
  /** API mode: 'rest' for DocMind FastAPI, 'jsonrpc' for MCP-over-HTTP */
  apiMode: 'rest' | 'jsonrpc'
}

export interface RAGWissenSearchResult {
  filename: string
  filepath: string
  content: string
  score: number
  chunk_index: number
  file_type: string
}

export interface RAGWissenHealthResponse {
  status: string
  qdrant: string
  embedding_model: string
}

const DEFAULT_CONFIG: RAGWissenConfig = {
  host: 'localhost',
  port: 8001,
  protocol: 'http',
  enabled: true,
  defaultCollection: 'documents',
  apiMode: 'jsonrpc'
}

const store = new SimpleStore()

export class RAGWissenClient {
  private config: RAGWissenConfig
  private baseUrl: string

  constructor(config?: Partial<RAGWissenConfig>) {
    const saved = store.get('rag_wissen_config') as Partial<RAGWissenConfig> | undefined
    this.config = { ...DEFAULT_CONFIG, ...saved, ...config }
    this.baseUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}`
  }

  getConfig(): RAGWissenConfig {
    return { ...this.config }
  }

  updateConfig(updates: Partial<RAGWissenConfig>): void {
    this.config = { ...this.config, ...updates }
    this.baseUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}`
    store.set('rag_wissen_config', this.config)
  }

  // ── Health ──────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) return false

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000)
      })
      return response.ok
    } catch {
      return false
    }
  }

  async healthCheck(): Promise<{ success: boolean; data?: RAGWissenHealthResponse; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as RAGWissenHealthResponse
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ── Search ──────────────────────────────────────────────────────

  async search(
    query: string,
    collection?: string,
    limit: number = 5
  ): Promise<{ success: boolean; results?: RAGWissenSearchResult[]; error?: string }> {
    return this.config.apiMode === 'rest'
      ? this.searchREST(query, limit)
      : this.searchJsonRpc(query, collection, limit)
  }

  private async searchREST(
    query: string,
    limit: number
  ): Promise<{ success: boolean; results?: RAGWissenSearchResult[]; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(30_000)
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as any
      const results: RAGWissenSearchResult[] = (data.results || []).map((r: any) => ({
        filename: r.file_name,
        filepath: r.file_path,
        content: r.content,
        score: r.score,
        chunk_index: r.chunk_index,
        file_type: r.file_type
      }))

      return { success: true, results }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  private async searchJsonRpc(
    query: string,
    collection?: string,
    limit: number = 5
  ): Promise<{ success: boolean; results?: RAGWissenSearchResult[]; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'search',
            arguments: {
              query,
              collection: collection || this.config.defaultCollection,
              top_k: limit
            }
          },
          id: Date.now()
        }),
        signal: AbortSignal.timeout(30_000)
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as any
      if (data.error) {
        return { success: false, error: data.error.message }
      }

      return {
        success: true,
        results: data.result?.results || []
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Get context for LLM injection — searches and formats results.
   * In REST mode, uses the /retrieve endpoint directly for pre-formatted context.
   */
  async getContext(
    query: string,
    collection?: string,
    limit: number = 3
  ): Promise<{
    success: boolean
    context?: string
    sources?: Array<{ filename: string; score: number }>
    error?: string
  }> {
    if (this.config.apiMode === 'rest') {
      return this.getContextREST(query)
    }

    const searchResult = await this.search(query, collection, limit)

    if (!searchResult.success || !searchResult.results?.length) {
      return {
        success: searchResult.success,
        context: '',
        sources: [],
        error: searchResult.error
      }
    }

    // Format context string
    const contextParts = searchResult.results.map((r, i) => {
      return `[Context ${i + 1} - ${r.filename} (relevance: ${r.score.toFixed(2)})]
${r.content}`
    })

    const sources = searchResult.results.map(r => ({
      filename: r.filename,
      score: r.score
    }))

    return {
      success: true,
      context: contextParts.join('\n\n'),
      sources
    }
  }

  private async getContextREST(query: string): Promise<{
    success: boolean
    context?: string
    sources?: Array<{ filename: string; score: number }>
    error?: string
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/retrieve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_tokens: 2000 }),
        signal: AbortSignal.timeout(30_000)
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as any
      const sources = (data.sources || []).map((s: any) => ({
        filename: s.file || s.file_name,
        score: s.score
      }))

      return {
        success: true,
        context: data.context || '',
        sources
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ── Collections ─────────────────────────────────────────────────

  async listCollections(): Promise<{ success: boolean; collections?: string[]; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'list_collections', arguments: {} },
          id: Date.now()
        }),
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as any
      return {
        success: true,
        collections: data.result?.collections || []
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async getStats(collection?: string): Promise<{ success: boolean; stats?: any; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'get_stats',
            arguments: { collection: collection || this.config.defaultCollection }
          },
          id: Date.now()
        }),
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as any
      return {
        success: true,
        stats: data.result?.stats
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ── Indexing ─────────────────────────────────────────────────────

  async indexDocument(
    filepath: string,
    collection?: string
  ): Promise<{ success: boolean; chunks_indexed?: number; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'index_document',
            arguments: {
              filepath,
              collection: collection || this.config.defaultCollection
            }
          },
          id: Date.now()
        }),
        signal: AbortSignal.timeout(120_000) // 2 min for large documents
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json() as any
      if (data.error) {
        return { success: false, error: data.error.message }
      }

      return {
        success: true,
        chunks_indexed: data.result?.chunks_indexed
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────

let wissenClientInstance: RAGWissenClient | null = null

export function getRAGWissenClient(): RAGWissenClient {
  if (!wissenClientInstance) {
    wissenClientInstance = new RAGWissenClient()
  }
  return wissenClientInstance
}
