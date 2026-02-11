/**
 * EmbeddingGenerator Tests
 * Tests embedding model initialization and vector generation (mocking transformers).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @xenova/transformers
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({
      data: new Float32Array(1024).fill(0.1)
    })
  )
}))

import { EmbeddingGenerator, getEmbeddingGenerator } from '../../src/main/rag/embeddings'

describe('EmbeddingGenerator', () => {
  let generator: EmbeddingGenerator

  beforeEach(() => {
    vi.clearAllMocks()
    generator = new EmbeddingGenerator()
  })

  describe('getDimension', () => {
    it('should return 1024 for multilingual-e5-large', () => {
      expect(generator.getDimension()).toBe(1024)
    })
  })

  describe('initialize', () => {
    it('should initialize the model', async () => {
      await generator.initialize()
      // Should not throw
    })

    it('should only initialize once', async () => {
      await generator.initialize()
      await generator.initialize()

      const { pipeline } = await import('@xenova/transformers')
      // pipeline should only be called once
      expect(pipeline).toHaveBeenCalledTimes(1)
    })
  })

  describe('embed', () => {
    it('should generate embedding vector', async () => {
      const embedding = await generator.embed('Hello world')
      expect(Array.isArray(embedding)).toBe(true)
      expect(embedding.length).toBe(1024)
    })

    it('should auto-initialize if not initialized', async () => {
      const embedding = await generator.embed('test')
      expect(embedding.length).toBe(1024)
    })
  })

  describe('embedBatch', () => {
    it('should generate embeddings for multiple texts', async () => {
      const embeddings = await generator.embedBatch(['hello', 'world', 'test'])
      expect(embeddings.length).toBe(3)
      expect(embeddings[0].length).toBe(1024)
    })

    it('should handle empty batch', async () => {
      const embeddings = await generator.embedBatch([])
      expect(embeddings).toEqual([])
    })
  })

  describe('custom model name', () => {
    it('should accept custom model name', () => {
      const custom = new EmbeddingGenerator('custom/model')
      expect(custom.getDimension()).toBe(1024)
    })
  })
})

describe('getEmbeddingGenerator', () => {
  it('should return a singleton', () => {
    expect(typeof getEmbeddingGenerator).toBe('function')
    const gen = getEmbeddingGenerator()
    expect(gen).toBeInstanceOf(EmbeddingGenerator)
  })
})
