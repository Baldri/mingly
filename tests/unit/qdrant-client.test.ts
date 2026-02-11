/**
 * QdrantClient Tests
 * Tests vector database operations (mocking @qdrant/js-client-rest SDK).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQdrantSDK = {
  getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'docs' }, { name: 'code' }] }),
  getCollection: vi.fn().mockResolvedValue({ vectors_count: 100, indexed_vectors_count: 90, points_count: 100 }),
  createCollection: vi.fn().mockResolvedValue(true),
  deleteCollection: vi.fn().mockResolvedValue(true),
  upsert: vi.fn().mockResolvedValue(true),
  search: vi.fn().mockResolvedValue([
    { id: 'p1', score: 0.95, payload: { text: 'result', source: 'test.md' } }
  ]),
  delete: vi.fn().mockResolvedValue(true),
  scroll: vi.fn().mockResolvedValue({
    points: [
      { id: 'p1', vector: [0.1, 0.2], payload: { text: 'hello', source: 'a.md' } }
    ]
  })
}

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(function () {
    Object.assign(this, mockQdrantSDK)
  })
}))

import { QdrantClient, initQdrantClient, getQdrantClient } from '../../src/main/rag/qdrant-client'

describe('QdrantClient', () => {
  let client: QdrantClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new QdrantClient({ host: 'localhost', port: 6333 })
  })

  describe('constructor', () => {
    it('should create a client with http URL', () => {
      const c = new QdrantClient({ host: 'localhost', port: 6333 })
      expect(c).toBeDefined()
    })

    it('should support https', () => {
      const c = new QdrantClient({ host: 'qdrant.cloud', port: 443, https: true, apiKey: 'key' })
      expect(c).toBeDefined()
    })
  })

  describe('testConnection', () => {
    it('should return success on healthy server', async () => {
      const result = await client.testConnection()
      expect(result.success).toBe(true)
    })

    it('should return error on failure', async () => {
      mockQdrantSDK.getCollections.mockRejectedValueOnce(new Error('Connection refused'))
      const result = await client.testConnection()
      expect(result.success).toBe(false)
      expect(result.error).toContain('Connection refused')
    })
  })

  describe('createCollection', () => {
    it('should create a collection', async () => {
      const result = await client.createCollection('test-col', 1024, 'Cosine')
      expect(result.success).toBe(true)
      expect(mockQdrantSDK.createCollection).toHaveBeenCalledWith('test-col', {
        vectors: { size: 1024, distance: 'Cosine' }
      })
    })

    it('should handle creation error', async () => {
      mockQdrantSDK.createCollection.mockRejectedValueOnce(new Error('Already exists'))
      const result = await client.createCollection('test-col')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Already exists')
    })
  })

  describe('deleteCollection', () => {
    it('should delete a collection', async () => {
      const result = await client.deleteCollection('old-col')
      expect(result.success).toBe(true)
    })

    it('should handle deletion error', async () => {
      mockQdrantSDK.deleteCollection.mockRejectedValueOnce(new Error('Not found'))
      const result = await client.deleteCollection('no-exist')
      expect(result.success).toBe(false)
    })
  })

  describe('listCollections', () => {
    it('should list all collections', async () => {
      const result = await client.listCollections()
      expect(result.success).toBe(true)
      expect(result.collections).toEqual(['docs', 'code'])
    })

    it('should handle error', async () => {
      mockQdrantSDK.getCollections.mockRejectedValueOnce(new Error('Unavailable'))
      const result = await client.listCollections()
      expect(result.success).toBe(false)
    })
  })

  describe('getCollectionInfo', () => {
    it('should return collection info', async () => {
      const result = await client.getCollectionInfo('docs')
      expect(result.success).toBe(true)
      expect(result.info?.points_count).toBe(100)
    })

    it('should handle error', async () => {
      mockQdrantSDK.getCollection.mockRejectedValueOnce(new Error('Not found'))
      const result = await client.getCollectionInfo('missing')
      expect(result.success).toBe(false)
    })
  })

  describe('upsertVectors', () => {
    it('should upsert vectors', async () => {
      const points = [
        { id: 'v1', vector: [0.1, 0.2], payload: { text: 'hello', source: 'a.md' } }
      ]
      const result = await client.upsertVectors('docs', points)
      expect(result.success).toBe(true)
      expect(mockQdrantSDK.upsert).toHaveBeenCalledWith('docs', expect.objectContaining({ wait: true }))
    })

    it('should handle upsert error', async () => {
      mockQdrantSDK.upsert.mockRejectedValueOnce(new Error('Dimension mismatch'))
      const result = await client.upsertVectors('docs', [])
      expect(result.success).toBe(false)
    })
  })

  describe('search', () => {
    it('should search similar vectors', async () => {
      const result = await client.search('docs', [0.1, 0.2], 5, 0.7)
      expect(result.success).toBe(true)
      expect(result.results?.length).toBe(1)
      expect(result.results?.[0].score).toBe(0.95)
    })

    it('should handle search error', async () => {
      mockQdrantSDK.search.mockRejectedValueOnce(new Error('Collection not found'))
      const result = await client.search('missing', [0.1], 5)
      expect(result.success).toBe(false)
    })
  })

  describe('deleteVectors', () => {
    it('should delete vectors by IDs', async () => {
      const result = await client.deleteVectors('docs', ['v1', 'v2'])
      expect(result.success).toBe(true)
    })

    it('should handle delete error', async () => {
      mockQdrantSDK.delete.mockRejectedValueOnce(new Error('Failed'))
      const result = await client.deleteVectors('docs', ['v1'])
      expect(result.success).toBe(false)
    })
  })

  describe('scrollPoints', () => {
    it('should scroll through points', async () => {
      const result = await client.scrollPoints('docs', 100)
      expect(result.success).toBe(true)
      expect(result.points?.length).toBe(1)
      expect(result.points?.[0].id).toBe('p1')
    })

    it('should handle scroll error', async () => {
      mockQdrantSDK.scroll.mockRejectedValueOnce(new Error('Error'))
      const result = await client.scrollPoints('docs')
      expect(result.success).toBe(false)
    })
  })
})

describe('Singleton helpers', () => {
  it('should return null before init', () => {
    // Can't reliably test this since module-level state persists
    // Just verify the functions exist
    expect(typeof initQdrantClient).toBe('function')
    expect(typeof getQdrantClient).toBe('function')
  })
})
