/**
 * ConversationSessionManager Tests (Paperclip Phase 2.3)
 * Tests session state persistence with mocked database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock database
vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbGet: vi.fn(),
  dbAll: vi.fn(() => [])
}))

import { ConversationSessionManager, getSessionManager } from '../../src/main/services/session-state'
import { dbRun, dbGet, dbAll } from '../../src/main/database/index'

describe('ConversationSessionManager', () => {
  let manager: ConversationSessionManager

  beforeEach(() => {
    manager = new ConversationSessionManager()
    vi.clearAllMocks()
  })

  describe('getOrCreate', () => {
    it('should return existing session if found', () => {
      const mockRow = {
        id: 'sess-1',
        conversation_id: 'conv_123',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        session_params: '{"threadId":"t1"}',
        session_display_id: null,
        total_input_tokens: 500,
        total_output_tokens: 200,
        total_cost: 0.012,
        last_error: null,
        created_at: 1710000000000,
        updated_at: 1710000001000
      }
      ;(dbGet as ReturnType<typeof vi.fn>).mockReturnValue(mockRow)

      const session = manager.getOrCreate('conv_123', 'anthropic', 'claude-3-5-sonnet-20241022')

      expect(dbGet).toHaveBeenCalledOnce()
      expect(dbRun).not.toHaveBeenCalled() // no INSERT
      expect(session.id).toBe('sess-1')
      expect(session.conversationId).toBe('conv_123')
      expect(session.provider).toBe('anthropic')
      expect(session.sessionParams).toEqual({ threadId: 't1' })
      expect(session.totalInputTokens).toBe(500)
      expect(session.totalCost).toBe(0.012)
    })

    it('should create new session if not found', () => {
      ;(dbGet as ReturnType<typeof vi.fn>).mockReturnValue(null)

      const session = manager.getOrCreate('conv_new', 'openai', 'gpt-4')

      expect(dbGet).toHaveBeenCalledOnce()
      expect(dbRun).toHaveBeenCalledOnce()

      const [sql] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('INSERT INTO conversation_sessions')

      expect(session.conversationId).toBe('conv_new')
      expect(session.provider).toBe('openai')
      expect(session.model).toBe('gpt-4')
      expect(session.totalInputTokens).toBe(0)
      expect(session.totalOutputTokens).toBe(0)
      expect(session.totalCost).toBe(0)
      expect(session.sessionParams).toBeNull()
      expect(session.lastError).toBeNull()
      expect(session.id).toMatch(/^[0-9a-f-]{36}$/) // UUID
    })

    it('should be idempotent — second call returns existing session', () => {
      // First call: not found → create
      ;(dbGet as ReturnType<typeof vi.fn>).mockReturnValueOnce(null)
      const created = manager.getOrCreate('conv_1', 'anthropic', 'claude-3-5-sonnet-20241022')

      // Second call: found → return
      ;(dbGet as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        id: created.id,
        conversation_id: 'conv_1',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        session_params: null,
        session_display_id: null,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
        last_error: null,
        created_at: created.createdAt,
        updated_at: created.updatedAt
      })
      const existing = manager.getOrCreate('conv_1', 'anthropic', 'claude-3-5-sonnet-20241022')

      expect(dbRun).toHaveBeenCalledTimes(1) // only one INSERT
      expect(existing.id).toBe(created.id)
    })
  })

  describe('updateParams', () => {
    it('should update session parameters as JSON', () => {
      const params = { threadId: 'thread_abc', lastMessageId: 'msg_xyz' }
      manager.updateParams('conv_1', 'openai', params)

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, args] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('UPDATE conversation_sessions')
      expect(sql).toContain('SET session_params = ?')
      expect(JSON.parse(args[0] as string)).toEqual(params)
      expect(args[2]).toBe('conv_1') // conversation_id
      expect(args[3]).toBe('openai') // provider
    })
  })

  describe('addUsage', () => {
    it('should accumulate token usage', () => {
      manager.addUsage('conv_1', 'anthropic', 100, 50, 0.005)

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, args] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('total_input_tokens = total_input_tokens + ?')
      expect(sql).toContain('total_output_tokens = total_output_tokens + ?')
      expect(sql).toContain('total_cost = total_cost + ?')
      expect(args[0]).toBe(100) // inputTokens
      expect(args[1]).toBe(50)  // outputTokens
      expect(args[2]).toBe(0.005) // cost
    })
  })

  describe('setError', () => {
    it('should record an error on the session', () => {
      manager.setError('conv_1', 'openai', 'Rate limit exceeded')

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, args] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('SET last_error = ?')
      expect(args[0]).toBe('Rate limit exceeded')
    })
  })

  describe('get', () => {
    it('should return session if found', () => {
      ;(dbGet as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'sess-1',
        conversation_id: 'conv_1',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        session_params: null,
        session_display_id: null,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
        last_error: null,
        created_at: 1710000000000,
        updated_at: 1710000000000
      })

      const session = manager.get('conv_1', 'anthropic')
      expect(session).not.toBeNull()
      expect(session?.conversationId).toBe('conv_1')
    })

    it('should return null if not found', () => {
      ;(dbGet as ReturnType<typeof vi.fn>).mockReturnValue(null)

      const session = manager.get('conv_nonexistent', 'anthropic')
      expect(session).toBeNull()
    })
  })

  describe('getAll', () => {
    it('should return all sessions for a conversation', () => {
      ;(dbAll as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: 'sess-1', conversation_id: 'conv_1', provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022', session_params: null,
          session_display_id: null, total_input_tokens: 100,
          total_output_tokens: 50, total_cost: 0.005,
          last_error: null, created_at: 1710000000000, updated_at: 1710000001000
        },
        {
          id: 'sess-2', conversation_id: 'conv_1', provider: 'openai',
          model: 'gpt-4', session_params: '{"threadId":"t1"}',
          session_display_id: null, total_input_tokens: 200,
          total_output_tokens: 100, total_cost: 0.015,
          last_error: null, created_at: 1710000000000, updated_at: 1710000002000
        }
      ])

      const sessions = manager.getAll('conv_1')
      expect(sessions).toHaveLength(2)
      expect(sessions[0].provider).toBe('anthropic')
      expect(sessions[1].provider).toBe('openai')
      expect(sessions[1].sessionParams).toEqual({ threadId: 't1' })
    })

    it('should return empty array for conversation with no sessions', () => {
      ;(dbAll as ReturnType<typeof vi.fn>).mockReturnValue([])

      const sessions = manager.getAll('conv_empty')
      expect(sessions).toEqual([])
    })
  })

  describe('getSessionManager singleton', () => {
    it('should return same instance on repeated calls', () => {
      const a = getSessionManager()
      const b = getSessionManager()
      expect(a).toBe(b)
    })
  })
})
