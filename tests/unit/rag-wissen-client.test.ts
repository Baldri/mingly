/**
 * RAGWissenClient Tests
 * Tests RAG-Wissen client: health checks, search (REST + JSON-RPC), context retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import nodePath from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => nodePath.join(tmpdir(), 'mingly-rag-wissen-test-' + process.pid)
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn()
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn()
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { RAGWissenClient, getRAGWissenClient } from '../../src/main/rag/rag-wissen-client'

describe('RAGWissenClient', () => {
  let client: RAGWissenClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    client = new RAGWissenClient()
  })

  describe('config', () => {
    it('should initialize with default config', () => {
      const config = client.getConfig()
      expect(config.host).toBe('localhost')
      expect(config.port).toBe(8001)
      expect(config.apiMode).toBe('jsonrpc')
      expect(config.enabled).toBe(true)
    })

    it('should update config and rebuild base URL', () => {
      client.updateConfig({ port: 9000, apiMode: 'rest' })
      const config = client.getConfig()
      expect(config.port).toBe(9000)
      expect(config.apiMode).toBe('rest')
    })
  })

  describe('isAvailable', () => {
    it('should return true when health endpoint responds', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      const result = await client.isAvailable()
      expect(result).toBe(true)
    })

    it('should return false when disabled', async () => {
      client.updateConfig({ enabled: false })
      const result = await client.isAvailable()
      expect(result).toBe(false)
    })

    it('should return false on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const result = await client.isAvailable()
      expect(result).toBe(false)
    })
  })

  describe('healthCheck', () => {
    it('should return health data on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'healthy', qdrant: 'ok', embedding_model: 'all-MiniLM-L6-v2' })
      })
      const result = await client.healthCheck()
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('healthy')
    })

    it('should return error on HTTP failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 })
      const result = await client.healthCheck()
      expect(result.success).toBe(false)
      expect(result.error).toContain('503')
    })
  })

  describe('search — JSON-RPC mode', () => {
    let jsonRpcClient: RAGWissenClient

    beforeEach(() => {
      // Explicitly create a JSON-RPC client to avoid store pollution from config tests
      jsonRpcClient = new RAGWissenClient({ apiMode: 'jsonrpc', port: 8001 })
    })

    it('should send JSON-RPC request to /mcp', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            results: [
              { filename: 'doc1.pdf', filepath: '/docs/doc1.pdf', content: 'AI is great', score: 0.95, chunk_index: 0, file_type: 'pdf' }
            ]
          }
        })
      })

      const result = await jsonRpcClient.search('AI', undefined, 5)
      expect(result.success).toBe(true)
      expect(result.results).toHaveLength(1)

      // Verify JSON-RPC format
      const fetchCall = mockFetch.mock.calls[0]
      const body = JSON.parse(fetchCall[1].body)
      expect(body.jsonrpc).toBe('2.0')
      expect(body.method).toBe('tools/call')
      expect(body.params.name).toBe('search')
    })

    it('should return error on JSON-RPC error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: { message: 'Collection not found' } })
      })

      const result = await jsonRpcClient.search('test')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Collection not found')
    })
  })

  describe('search — REST mode', () => {
    let restClient: RAGWissenClient

    beforeEach(() => {
      restClient = new RAGWissenClient({ apiMode: 'rest', port: 8000 })
    })

    it('should send POST to /search', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { file_name: 'doc1.pdf', file_path: '/docs/doc1.pdf', content: 'AI text', score: 0.9, chunk_index: 0, file_type: 'pdf' }
          ]
        })
      })

      const result = await restClient.search('AI', undefined, 5)
      expect(result.success).toBe(true)
      expect(result.results).toHaveLength(1)
      expect(result.results![0].filename).toBe('doc1.pdf')

      // Verify REST format
      const fetchCall = mockFetch.mock.calls[0]
      expect(fetchCall[0]).toContain('/search')
      const body = JSON.parse(fetchCall[1].body)
      expect(body.query).toBe('AI')
      expect(body.limit).toBe(5)
    })

    it('should map REST field names to internal format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { file_name: 'notes.md', file_path: '/vault/notes.md', content: 'Some text', score: 0.85, chunk_index: 2, file_type: 'md' }
          ]
        })
      })

      const result = await restClient.search('notes')
      expect(result.results![0].filename).toBe('notes.md')
      expect(result.results![0].filepath).toBe('/vault/notes.md')
      expect(result.results![0].file_type).toBe('md')
    })
  })

  describe('getContext — JSON-RPC mode', () => {
    let jsonRpcClient: RAGWissenClient

    beforeEach(() => {
      jsonRpcClient = new RAGWissenClient({ apiMode: 'jsonrpc', port: 8001 })
    })

    it('should format search results into context string', async () => {
      // getContext calls search() internally, which calls searchJsonRpc()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            results: [
              { filename: 'doc1.pdf', filepath: '/d/doc1.pdf', content: 'Content A', score: 0.95, chunk_index: 0, file_type: 'pdf' },
              { filename: 'doc2.pdf', filepath: '/d/doc2.pdf', content: 'Content B', score: 0.80, chunk_index: 0, file_type: 'pdf' }
            ]
          }
        })
      })

      const result = await jsonRpcClient.getContext('test query', undefined, 3)
      expect(result.success).toBe(true)
      expect(result.context).toContain('Content A')
      expect(result.context).toContain('Content B')
      expect(result.sources).toHaveLength(2)
      expect(result.sources![0].score).toBe(0.95)
    })

    it('should return empty context when no results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { results: [] } })
      })

      const result = await jsonRpcClient.getContext('obscure query')
      expect(result.success).toBe(true)
      expect(result.context).toBe('')
      expect(result.sources).toHaveLength(0)
    })
  })

  describe('getContext — REST mode', () => {
    let restClient: RAGWissenClient

    beforeEach(() => {
      restClient = new RAGWissenClient({ apiMode: 'rest', port: 8000 })
    })

    it('should call /retrieve endpoint directly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          context: 'Pre-formatted context from DocMind',
          sources: [{ file: 'doc1.pdf', score: 0.9 }],
          total_chunks: 3
        })
      })

      const result = await restClient.getContext('test query')
      expect(result.success).toBe(true)
      expect(result.context).toBe('Pre-formatted context from DocMind')
      expect(result.sources).toHaveLength(1)
      expect(result.sources![0].filename).toBe('doc1.pdf')

      // Verify /retrieve endpoint
      const fetchCall = mockFetch.mock.calls[0]
      expect(fetchCall[0]).toContain('/retrieve')
    })

    it('should handle empty context from REST', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          context: 'Keine relevanten Informationen gefunden.',
          sources: [],
          total_chunks: 0
        })
      })

      const result = await restClient.getContext('obscure')
      expect(result.success).toBe(true)
    })
  })

  describe('listCollections', () => {
    it('should return collections from JSON-RPC response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: { collections: ['documents', 'notes', 'emails'] }
        })
      })

      const result = await client.listCollections()
      expect(result.success).toBe(true)
      expect(result.collections).toEqual(['documents', 'notes', 'emails'])
    })

    it('should return empty array when no collections', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: {} })
      })

      const result = await client.listCollections()
      expect(result.success).toBe(true)
      expect(result.collections).toEqual([])
    })
  })

  describe('indexDocument', () => {
    it('should index document via JSON-RPC', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: { chunks_indexed: 5 }
        })
      })

      const result = await client.indexDocument('/path/to/doc.pdf', 'documents')
      expect(result.success).toBe(true)
      expect(result.chunks_indexed).toBe(5)
    })

    it('should handle indexing errors from JSON-RPC', async () => {
      // The code checks `data.error` at the top level (line 363 of source)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: { code: -32600, message: 'File not found' }
        })
      })

      const result = await client.indexDocument('/nonexistent.pdf')
      expect(result.success).toBe(false)
      expect(result.error).toContain('File not found')
    })

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const result = await client.indexDocument('/some/file.pdf')
      expect(result.success).toBe(false)
      expect(result.error).toContain('ECONNREFUSED')
    })
  })

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = getRAGWissenClient()
      const b = getRAGWissenClient()
      expect(a).toBe(b)
    })
  })
})
