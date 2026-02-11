/**
 * RAGManager Tests
 * Tests document processing, chunking, and search orchestration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQdrantClient = vi.hoisted(() => ({
  testConnection: vi.fn().mockResolvedValue({ success: true, version: '1.7.0' }),
  createCollection: vi.fn().mockResolvedValue({ success: true }),
  deleteCollection: vi.fn().mockResolvedValue({ success: true }),
  listCollections: vi.fn().mockResolvedValue({ success: true, collections: ['docs'] }),
  getCollectionInfo: vi.fn().mockResolvedValue({ success: true, info: { vectors_count: 10, points_count: 10 } }),
  upsertVectors: vi.fn().mockResolvedValue({ success: true }),
  search: vi.fn().mockResolvedValue({
    success: true,
    results: [
      { id: 'p1', score: 0.95, payload: { text: 'result text', source: '/path/test.md', filename: 'test.md' } }
    ]
  })
}))

vi.mock('../../src/main/rag/qdrant-client', () => ({
  initQdrantClient: vi.fn().mockReturnValue(mockQdrantClient),
  getQdrantClient: vi.fn().mockReturnValue(mockQdrantClient)
}))

vi.mock('../../src/main/rag/embeddings', () => ({
  getEmbeddingGenerator: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    getDimension: vi.fn().mockReturnValue(1024),
    embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([new Array(1024).fill(0.1)])
  })
}))

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234')
}))

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn().mockResolvedValue('File content for testing.')
  },
  readFile: vi.fn().mockResolvedValue('File content for testing.')
}))

import { RAGManager } from '../../src/main/rag/rag-manager'

describe('RAGManager', () => {
  let manager: RAGManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new RAGManager()
  })

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      const result = await manager.initialize({ host: 'localhost', port: 6333 })
      expect(result.success).toBe(true)
    })

    it('should handle connection failure', async () => {
      mockQdrantClient.testConnection.mockResolvedValueOnce({
        success: false,
        error: 'Connection refused'
      })

      const result = await manager.initialize({ host: 'localhost', port: 6333 })
      expect(result.success).toBe(false)
      expect(result.error).toContain('connection failed')
    })
  })

  describe('createCollection', () => {
    it('should create a collection', async () => {
      const result = await manager.createCollection('test-col')
      expect(result.success).toBe(true)
      expect(mockQdrantClient.createCollection).toHaveBeenCalledWith('test-col', 1024, 'Cosine')
    })
  })

  describe('deleteCollection', () => {
    it('should delete a collection', async () => {
      const result = await manager.deleteCollection('old-col')
      expect(result.success).toBe(true)
    })
  })

  describe('listCollections', () => {
    it('should list collections', async () => {
      const result = await manager.listCollections()
      expect(result.success).toBe(true)
      expect(result.collections).toEqual(['docs'])
    })
  })

  describe('getCollectionInfo', () => {
    it('should return collection info', async () => {
      const result = await manager.getCollectionInfo('docs')
      expect(result.success).toBe(true)
      expect(result.info?.points_count).toBe(10)
    })
  })

  describe('indexDocument', () => {
    it('should index a document', async () => {
      const result = await manager.indexDocument(
        'docs',
        'This is a test document with some content.',
        '/path/test.txt',
        'test.txt'
      )
      expect(result.success).toBe(true)
      expect(result.chunks_indexed).toBeGreaterThan(0)
    })

    it('should handle index failure', async () => {
      mockQdrantClient.upsertVectors.mockResolvedValueOnce({
        success: false,
        error: 'Upsert failed'
      })

      const result = await manager.indexDocument('docs', 'text', 'src', 'file.txt')
      expect(result.success).toBe(false)
    })
  })

  describe('indexFile', () => {
    it('should read and index a file', async () => {
      const result = await manager.indexFile('docs', '/path/to/file.md')
      expect(result.success).toBe(true)
    })

    it('should handle file read error', async () => {
      const fsPromises = await import('fs/promises')
      ;(fsPromises.default.readFile as any).mockRejectedValueOnce(new Error('ENOENT'))

      const result = await manager.indexFile('docs', '/nonexistent')
      expect(result.success).toBe(false)
    })
  })

  describe('search', () => {
    it('should search and return results', async () => {
      const result = await manager.search('docs', 'test query', 5, 0.7)
      expect(result.success).toBe(true)
      expect(result.results?.length).toBe(1)
      expect(result.results?.[0].text).toBe('result text')
      expect(result.results?.[0].score).toBe(0.95)
    })

    it('should handle search failure', async () => {
      mockQdrantClient.search.mockResolvedValueOnce({
        success: false,
        error: 'Collection not found'
      })

      const result = await manager.search('missing', 'query')
      expect(result.success).toBe(false)
    })
  })

  describe('getContext', () => {
    it('should return formatted context string', async () => {
      const context = await manager.getContext('docs', 'test query', 3)
      expect(context).toContain('Context 1')
      expect(context).toContain('0.95')
      expect(context).toContain('result text')
    })

    it('should return empty string when no results', async () => {
      mockQdrantClient.search.mockResolvedValueOnce({
        success: true,
        results: []
      })

      const context = await manager.getContext('docs', 'query')
      expect(context).toBe('')
    })

    it('should return empty string on search failure', async () => {
      mockQdrantClient.search.mockResolvedValueOnce({
        success: false,
        error: 'Failed'
      })

      const context = await manager.getContext('docs', 'query')
      expect(context).toBe('')
    })
  })
})
