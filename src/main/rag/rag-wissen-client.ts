/**
 * RAG-Wissen Client
 *
 * Connects to an external knowledge base server. This is a separate Python
 * FastAPI server that provides semantic search over indexed documents via its
 * own Qdrant instance and embedding model.
 *
 * Two dialects are supported (`apiMode`):
 * - 'jsonrpc': MCP-over-HTTP (`POST /mcp`), as served by Mingly's own
 *   python-rag-server on port 8001. This is the default.
 * - 'rest': the RAG-Wissen / DocMind core API (`src.api_server`, port 8000),
 *   which serves /health, /search and /retrieve at the root. Everything but
 *   /health requires `Authorization: Bearer <api key>` unless the server runs
 *   with AUTH_REQUIRED=false. Port 8080 is a different app (the Admin API).
 *
 * Compared to the generic RAGHttpClient, this client targets the
 * RAG-Wissen-specific API endpoints and response formats.
 */

import { SimpleStore } from '../utils/simple-store'
import { EncryptedStore } from '../utils/encrypted-store'
import type { RAGWissenAuthState } from '../../shared/rag-wissen-status'

export interface RAGWissenConfig {
  host: string
  port: number
  protocol: 'http' | 'https'
  enabled: boolean
  /** Default collection to search */
  defaultCollection: string
  /** API mode: 'rest' for DocMind FastAPI, 'jsonrpc' for MCP-over-HTTP */
  apiMode: 'rest' | 'jsonrpc'
  /**
   * An API key is stored in the secret store. The key itself is never part of
   * this object, so it can neither be persisted in the plain config file nor
   * handed to the renderer.
   */
  hasApiKey: boolean
}

/** What `updateConfig` accepts: the config plus the key, which is routed to the secret store. */
export type RAGWissenConfigUpdate = Partial<Omit<RAGWissenConfig, 'hasApiKey'>> & {
  /** A non-empty string stores the key; an empty string removes it; undefined leaves it alone. */
  apiKey?: string
}

/** The slice of EncryptedStore this client needs; tests inject an in-memory one. */
export interface SecretStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

export type { RAGWissenAuthState }

export interface RAGWissenClientDeps {
  secrets?: SecretStore
}

export interface RAGWissenSearchResult {
  filename: string
  filepath: string
  content: string
  score: number
  chunk_index: number
  file_type: string
}

/**
 * Shape differs per server: the bundled python-rag-server reports `qdrant` and
 * `embedding_model`, RAG-Wissen's core API reports `checks.{qdrant,disk,...}`.
 */
export interface RAGWissenHealthResponse {
  status: string
  qdrant?: string
  embedding_model?: string
  checks?: Record<string, unknown>
}

const DEFAULT_CONFIG: RAGWissenConfig = {
  host: 'localhost',
  port: 8001,
  protocol: 'http',
  enabled: true,
  defaultCollection: 'documents',
  apiMode: 'jsonrpc',
  hasApiKey: false
}

const API_KEY_SECRET = 'rag-wissen-api-key'

const store = SimpleStore.create()

/**
 * Created on first use, not at import: EncryptedStore picks its backend lazily
 * (safeStorage is unavailable before app ready on macOS since Electron 44), and
 * most users never store a key at all.
 */
let defaultSecrets: SecretStore | null = null
function getDefaultSecrets(): SecretStore {
  if (!defaultSecrets) defaultSecrets = new EncryptedStore('rag-wissen-secrets.enc.json')
  return defaultSecrets
}

export class RAGWissenClient {
  private config: RAGWissenConfig
  private baseUrl: string
  private readonly injectedSecrets: SecretStore | undefined

  constructor(config?: Partial<RAGWissenConfig>, deps?: RAGWissenClientDeps) {
    const saved = store.get('rag_wissen_config') as Partial<RAGWissenConfig> | undefined
    this.config = { ...DEFAULT_CONFIG, ...saved, ...config }
    this.baseUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}`
    this.injectedSecrets = deps?.secrets
  }

  getConfig(): RAGWissenConfig {
    return { ...this.config }
  }

  updateConfig(updates: RAGWissenConfigUpdate): void {
    const { apiKey, ...rest } = updates
    if (apiKey !== undefined) this.storeApiKey(apiKey)

    // hasApiKey is derived from the secret store, never taken from the caller.
    this.config = { ...this.config, ...rest, hasApiKey: this.config.hasApiKey }
    this.baseUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}`
    store.set('rag_wissen_config', this.config)
  }

  // ── Credentials ─────────────────────────────────────────────────

  private secrets(): SecretStore {
    return this.injectedSecrets ?? getDefaultSecrets()
  }

  private storeApiKey(apiKey: string): void {
    const trimmed = apiKey.trim()
    if (trimmed) {
      this.secrets().set(API_KEY_SECRET, trimmed)
      this.config = { ...this.config, hasApiKey: true }
    } else {
      this.secrets().delete(API_KEY_SECRET)
      this.config = { ...this.config, hasApiKey: false }
    }
  }

  /** The secret store is only touched when a key was stored, so no keychain access for users without one. */
  private apiKey(): string | undefined {
    if (!this.config.hasApiKey) return undefined
    return this.secrets().get(API_KEY_SECRET) || undefined
  }

  private headers(base: Record<string, string> = {}): Record<string, string> {
    const key = this.apiKey()
    return key ? { ...base, Authorization: `Bearer ${key}` } : base
  }

  private httpError(status: number): string {
    if (status === 401 || status === 403) {
      return `HTTP ${status} — the server requires a valid API key (Settings → Knowledge Base → API key)`
    }
    return `HTTP ${status}`
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

  /**
   * /health is public, /search is not, so a green /health says nothing about
   * whether searches will return hits. In REST mode a second, authenticated
   * request (GET /stats) settles that and is reported as `auth`.
   */
  async healthCheck(): Promise<{
    success: boolean
    data?: RAGWissenHealthResponse
    auth?: RAGWissenAuthState
    error?: string
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        return { success: false, error: this.httpError(response.status) }
      }

      const data = await response.json() as RAGWissenHealthResponse
      return { success: true, data, auth: await this.probeAuth() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  private async probeAuth(): Promise<RAGWissenAuthState> {
    if (this.config.apiMode !== 'rest') return 'unknown'

    try {
      const response = await fetch(`${this.baseUrl}/stats`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000)
      })
      if (response.ok) return 'ok'
      if (response.status === 401 || response.status === 403) {
        return this.config.hasApiKey ? 'rejected' : 'required'
      }
      return 'unknown'
    } catch {
      return 'unknown'
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
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(30_000)
      })

      if (!response.ok) {
        return { success: false, error: this.httpError(response.status) }
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
        headers: this.headers({ 'Content-Type': 'application/json' }),
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
        return { success: false, error: this.httpError(response.status) }
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
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query, max_tokens: 2000 }),
        signal: AbortSignal.timeout(30_000)
      })

      if (!response.ok) {
        return { success: false, error: this.httpError(response.status) }
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
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'list_collections', arguments: {} },
          id: Date.now()
        }),
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        return { success: false, error: this.httpError(response.status) }
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
        headers: this.headers({ 'Content-Type': 'application/json' }),
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
        return { success: false, error: this.httpError(response.status) }
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

  // ── Projects ─────────────────────────────────────────────────────

  async listProjects(): Promise<{
    success: boolean
    projects?: Array<{ id: string; name: string; collection_name: string; description: string; is_default: number }>
    error?: string
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/projects`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        return { success: false, error: this.httpError(response.status) }
      }

      const data = await response.json() as any
      return { success: true, projects: data.projects || data }
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
        headers: this.headers({ 'Content-Type': 'application/json' }),
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
        return { success: false, error: this.httpError(response.status) }
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
