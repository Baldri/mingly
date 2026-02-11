/**
 * MessageModel Tests
 * Tests CRUD operations on the messages table (mocking DB layer).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn().mockReturnValue([]),
  dbGet: vi.fn().mockReturnValue(null)
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn().mockReturnValue('msg-id-5678')
}))

import { MessageModel } from '../../src/main/database/models/message'
import { dbRun, dbAll, dbGet } from '../../src/main/database/index'

describe('MessageModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('create', () => {
    it('should create a user message', () => {
      const msg = MessageModel.create('conv-1', 'user', 'Hello world')

      expect(msg.id).toBe('msg-id-5678')
      expect(msg.conversationId).toBe('conv-1')
      expect(msg.role).toBe('user')
      expect(msg.content).toBe('Hello world')
      expect(msg.createdAt).toBeGreaterThan(0)
    })

    it('should create an assistant message with tokens', () => {
      const msg = MessageModel.create('conv-1', 'assistant', 'Hi there', 150)

      expect(msg.role).toBe('assistant')
      expect(msg.tokens).toBe(150)
    })

    it('should call dbRun with INSERT', () => {
      MessageModel.create('conv-1', 'user', 'test')

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('INSERT INTO messages')
      expect(params[1]).toBe('conv-1')
      expect(params[2]).toBe('user')
      expect(params[3]).toBe('test')
    })

    it('should pass null tokens when not provided', () => {
      MessageModel.create('conv-1', 'user', 'test')
      const params = (dbRun as any).mock.calls[0][1]
      expect(params[4]).toBeNull()
    })
  })

  describe('findByConversation', () => {
    it('should return empty array when no messages', () => {
      (dbAll as any).mockReturnValue([])
      expect(MessageModel.findByConversation('conv-1')).toEqual([])
    })

    it('should map rows to Message objects', () => {
      const now = Date.now()
      ;(dbAll as any).mockReturnValue([
        { id: 'm1', conversation_id: 'c1', role: 'user', content: 'Hi', tokens: null, created_at: now },
        { id: 'm2', conversation_id: 'c1', role: 'assistant', content: 'Hello!', tokens: 50, created_at: now + 1 }
      ])

      const msgs = MessageModel.findByConversation('c1')
      expect(msgs.length).toBe(2)
      expect(msgs[0].role).toBe('user')
      expect(msgs[1].role).toBe('assistant')
      expect(msgs[1].tokens).toBe(50)
    })
  })

  describe('deleteByConversation', () => {
    it('should delete all messages for conversation', () => {
      MessageModel.deleteByConversation('conv-1')

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('DELETE FROM messages WHERE conversation_id')
      expect(params).toEqual(['conv-1'])
    })
  })

  describe('delete', () => {
    it('should delete a single message', () => {
      MessageModel.delete('msg-1')

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('DELETE FROM messages WHERE id')
      expect(params).toEqual(['msg-1'])
    })
  })

  describe('count', () => {
    it('should count all messages when no conversationId', () => {
      (dbGet as any).mockReturnValue({ count: 100 })
      expect(MessageModel.count()).toBe(100)

      const [sql] = (dbGet as any).mock.calls[0]
      expect(sql).not.toContain('WHERE')
    })

    it('should count messages for specific conversation', () => {
      (dbGet as any).mockReturnValue({ count: 5 })
      expect(MessageModel.count('conv-1')).toBe(5)

      const [sql, params] = (dbGet as any).mock.calls[0]
      expect(sql).toContain('WHERE conversation_id')
      expect(params).toEqual(['conv-1'])
    })

    it('should return 0 when result is null', () => {
      (dbGet as any).mockReturnValue(null)
      expect(MessageModel.count()).toBe(0)
    })
  })

  describe('getLatest', () => {
    it('should return messages in chronological order', () => {
      (dbAll as any).mockReturnValue([
        { id: 'm3', conversation_id: 'c1', role: 'assistant', content: 'Third', tokens: null, created_at: 3 },
        { id: 'm2', conversation_id: 'c1', role: 'user', content: 'Second', tokens: null, created_at: 2 }
      ])

      const msgs = MessageModel.getLatest('c1', 2)
      // Should be reversed to chronological order
      expect(msgs[0].content).toBe('Second')
      expect(msgs[1].content).toBe('Third')
    })

    it('should pass limit to query', () => {
      (dbAll as any).mockReturnValue([])
      MessageModel.getLatest('c1', 5)

      const [sql, params] = (dbAll as any).mock.calls[0]
      expect(sql).toContain('LIMIT ?')
      expect(params).toEqual(['c1', 5])
    })
  })
})
