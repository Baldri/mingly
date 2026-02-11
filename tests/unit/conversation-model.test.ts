/**
 * ConversationModel Tests
 * Tests CRUD operations on the conversations table (mocking DB layer).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn().mockReturnValue([]),
  dbGet: vi.fn().mockReturnValue(null)
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn().mockReturnValue('test-id-1234')
}))

import { ConversationModel } from '../../src/main/database/models/conversation'
import { dbRun, dbAll, dbGet } from '../../src/main/database/index'

describe('ConversationModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('create', () => {
    it('should create a conversation and return it', () => {
      const result = ConversationModel.create('Test Chat', 'anthropic', 'claude-3')

      expect(result.id).toBe('test-id-1234')
      expect(result.title).toBe('Test Chat')
      expect(result.provider).toBe('anthropic')
      expect(result.model).toBe('claude-3')
      expect(result.createdAt).toBeGreaterThan(0)
      expect(result.updatedAt).toBe(result.createdAt)
    })

    it('should call dbRun with INSERT statement', () => {
      ConversationModel.create('Title', 'openai', 'gpt-4')

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('INSERT INTO conversations')
      expect(params[0]).toBe('test-id-1234')
      expect(params[1]).toBe('Title')
      expect(params[2]).toBe('openai')
      expect(params[3]).toBe('gpt-4')
    })
  })

  describe('findById', () => {
    it('should return null when not found', () => {
      (dbGet as any).mockReturnValue(null)
      expect(ConversationModel.findById('no-exist')).toBeNull()
    })

    it('should return conversation when found', () => {
      const now = Date.now()
      ;(dbGet as any).mockReturnValue({
        id: 'c1', title: 'Chat', provider: 'google', model: 'gemini',
        created_at: now, updated_at: now
      })

      const result = ConversationModel.findById('c1')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('c1')
      expect(result!.title).toBe('Chat')
      expect(result!.provider).toBe('google')
    })
  })

  describe('findAll', () => {
    it('should return empty array when no conversations', () => {
      (dbAll as any).mockReturnValue([])
      expect(ConversationModel.findAll()).toEqual([])
    })

    it('should return mapped conversations', () => {
      const now = Date.now()
      ;(dbAll as any).mockReturnValue([
        { id: 'c1', title: 'A', provider: 'openai', model: 'gpt-4', created_at: now, updated_at: now },
        { id: 'c2', title: 'B', provider: 'anthropic', model: 'claude', created_at: now, updated_at: now }
      ])

      const result = ConversationModel.findAll()
      expect(result.length).toBe(2)
      expect(result[0].title).toBe('A')
      expect(result[1].title).toBe('B')
    })
  })

  describe('update', () => {
    it('should update title only', () => {
      ConversationModel.update('c1', { title: 'New Title' })

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('UPDATE conversations SET')
      expect(sql).toContain('title = ?')
      expect(params[0]).toBe('New Title')
    })

    it('should update multiple fields', () => {
      ConversationModel.update('c1', { title: 'T', provider: 'openai', model: 'gpt-4' })

      const [sql] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('title = ?')
      expect(sql).toContain('provider = ?')
      expect(sql).toContain('model = ?')
    })
  })

  describe('updateTimestamp', () => {
    it('should call dbRun with UPDATE', () => {
      ConversationModel.updateTimestamp('c1')
      expect(dbRun).toHaveBeenCalledOnce()
      const [sql] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('UPDATE conversations SET updated_at')
    })
  })

  describe('delete', () => {
    it('should call dbRun with DELETE', () => {
      ConversationModel.delete('c1')
      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('DELETE FROM conversations')
      expect(params).toEqual(['c1'])
    })
  })

  describe('count', () => {
    it('should return 0 when empty', () => {
      (dbGet as any).mockReturnValue({ count: 0 })
      expect(ConversationModel.count()).toBe(0)
    })

    it('should return count value', () => {
      (dbGet as any).mockReturnValue({ count: 42 })
      expect(ConversationModel.count()).toBe(42)
    })

    it('should return 0 when result is null', () => {
      (dbGet as any).mockReturnValue(null)
      expect(ConversationModel.count()).toBe(0)
    })
  })
})
