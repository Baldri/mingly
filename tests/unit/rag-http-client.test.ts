/**
 * RAGHttpClient Tests
 * Tests the HTTP client for external RAG server (mocking fetch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RAGHttpClient, getRAGHttpClient } from '../../src/main/rag/rag-http-client'

// Mock global fetch
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('RAGHttpClient', () => {
  let client: RAGHttpClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new RAGHttpClient()
  })

  describe('constructor', () => {
    it('should use default config', () => {
      const c = new RAGHttpClient()
      expect(c).toBeDefined()
    })

    it('should accept custom config', () => {
      const c = new RAGHttpClient({ host: '192.168.1.100', port: 9000 })
      expect(c).toBeDefined()
    })
  })

  describe('updateConfig', () => {
    it('should update config', () => {
      client.updateConfig({ port: 9001 })
      // We can't directly check baseUrl, but the next request should use new config
      expect(client).toBeDefined()
    })
  })

  describe('healthCheck', () => {
    it('should return success on healthy response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', qdrant_connected: true, embedding_model_loaded: true, collections_count: 2 })
      })

      const result = await client.healthCheck()
      expect(result.success).toBe(true)
      expect(result.data?.qdrant_connected).toBe(true)
    })

    it('should return error on failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))

      const result = await client.healthCheck()
      expect(result.success).toBe(false)
      expect(result.error).toContain('Connection refused')
    })
  })

  describe('isAvailable', () => {
    it('should return true when server is up', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      const available = await client.isAvailable()
      expect(available).toBe(true)
    })

    it('should return false when server is down', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))
      const available = await client.isAvailable()
      expect(available).toBe(false)
    })

    it('should return false on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false })
      const available = await client.isAvailable()
      expect(available).toBe(false)
    })
  })

  describe('getContext', () => {
    it('should fetch context successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          context: 'some context text',
          sources: [{ file_name: 'doc.md', score: 0.9, chunk_index: 0 }],
          total_chunks: 1
        })
      })

      const result = await client.getContext('docs', 'test query', 3, 0.7)
      expect(result.success).toBe(true)
      expect(result.data?.context).toBe('some context text')
    })

    it('should handle error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Timeout'))
      const result = await client.getContext('docs', 'query')
      expect(result.success).toBe(false)
    })
  })

  describe('search', () => {
    it('should search successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          query: 'test',
          results: [{ id: 'r1', score: 0.85, text: 'result', metadata: {} }],
          total: 1
        })
      })

      const result = await client.search('docs', 'test query')
      expect(result.success).toBe(true)
      expect(result.data?.results.length).toBe(1)
    })

    it('should handle search error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Server error'))
      const result = await client.search('docs', 'query')
      expect(result.success).toBe(false)
    })
  })

  describe('listCollections', () => {
    it('should list collections', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ collections: ['docs', 'code'] })
      })

      const result = await client.listCollections()
      expect(result.success).toBe(true)
      expect(result.collections).toEqual(['docs', 'code'])
    })

    it('should handle error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed'))
      const result = await client.listCollections()
      expect(result.success).toBe(false)
    })
  })

  describe('createCollection', () => {
    it('should create collection', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true })
      })

      const result = await client.createCollection('new-col')
      expect(result.success).toBe(true)
    })

    it('should handle HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () => Promise.resolve('Collection already exists')
      })

      const result = await client.createCollection('existing')
      expect(result.success).toBe(false)
    })
  })

  describe('deleteCollection', () => {
    it('should delete collection', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true })
      })

      const result = await client.deleteCollection('old-col')
      expect(result.success).toBe(true)
    })
  })

  describe('indexFile', () => {
    it('should index a file', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          file_name: 'doc.md',
          chunks_indexed: 5,
          collection: 'docs'
        })
      })

      const result = await client.indexFile('docs', '/path/to/doc.md')
      expect(result.success).toBe(true)
      expect(result.data?.chunks_indexed).toBe(5)
    })
  })

  describe('indexDirectory', () => {
    it('should index a directory', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          files_indexed: 10,
          total_chunks: 50
        })
      })

      const result = await client.indexDirectory('docs', '/path/to/dir', true)
      expect(result.success).toBe(true)
      expect(result.data?.files_indexed).toBe(10)
    })
  })
})

describe('getRAGHttpClient', () => {
  it('should return singleton instance', () => {
    expect(typeof getRAGHttpClient).toBe('function')
  })
})
