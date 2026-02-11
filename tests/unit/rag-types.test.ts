/**
 * RAG Types Tests
 * Validates exported constants and types for Qdrant vector database integration.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_EMBEDDING_MODEL } from '../../src/shared/rag-types'

describe('RAG Types', () => {
  describe('DEFAULT_EMBEDDING_MODEL', () => {
    it('should define a default embedding model', () => {
      expect(DEFAULT_EMBEDDING_MODEL).toBeDefined()
    })

    it('should be a local provider', () => {
      expect(DEFAULT_EMBEDDING_MODEL.provider).toBe('local')
    })

    it('should have valid dimensions', () => {
      expect(DEFAULT_EMBEDDING_MODEL.dimensions).toBe(1024)
    })

    it('should have valid max tokens', () => {
      expect(DEFAULT_EMBEDDING_MODEL.maxTokens).toBe(512)
    })

    it('should use multilingual-e5-large', () => {
      expect(DEFAULT_EMBEDDING_MODEL.modelId).toContain('multilingual-e5-large')
    })

    it('should have a human-readable name', () => {
      expect(DEFAULT_EMBEDDING_MODEL.name).toBe('multilingual-e5-large')
    })
  })
})
