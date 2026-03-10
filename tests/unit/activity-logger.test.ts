/**
 * ActivityLogger Tests (Paperclip Phase 4.1)
 * Tests the SQLite-backed activity logger with mocked database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock database
vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn()
}))

import { ActivityLogger, getActivityLogger } from '../../src/main/audit/activity-logger'
import { dbRun, dbAll } from '../../src/main/database/index'
import type { ActivityLogEntry } from '../../src/main/audit/types'

describe('ActivityLogger', () => {
  let logger: ActivityLogger

  beforeEach(() => {
    logger = new ActivityLogger()
    vi.clearAllMocks()
  })

  describe('log', () => {
    it('should insert an activity log entry with auto-generated id and timestamp', () => {
      logger.log({
        actorType: 'user',
        actorId: 'local',
        action: 'conversation.create',
        entityType: 'conversation',
        entityId: 'conv_123',
        details: { provider: 'anthropic' }
      })

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('INSERT INTO activity_log')

      // params: [id, actor_type, actor_id, action, entity_type, entity_id, details, created_at]
      const [id, actorType, actorId, action, entityType, entityId, details, createdAt] = params as string[]
      expect(id).toMatch(/^[0-9a-f-]{36}$/) // UUID format
      expect(actorType).toBe('user')
      expect(actorId).toBe('local')
      expect(action).toBe('conversation.create')
      expect(entityType).toBe('conversation')
      expect(entityId).toBe('conv_123')
      expect(JSON.parse(details)).toEqual({ provider: 'anthropic' })
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO 8601
    })

    it('should handle null details', () => {
      logger.log({
        actorType: 'system',
        actorId: 'system',
        action: 'session.create',
        entityType: 'session',
        entityId: 'sess_abc',
        details: null
      })

      expect(dbRun).toHaveBeenCalledOnce()
      const params = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0][1] as (string | null)[]
      expect(params[6]).toBeNull() // details should be null
    })

    it('should not throw on database error', () => {
      ;(dbRun as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('DB write failed')
      })

      // Should not throw — errors are caught and logged
      expect(() => {
        logger.log({
          actorType: 'user',
          actorId: 'local',
          action: 'budget.exceeded',
          entityType: 'budget',
          entityId: 'global',
          details: { amount: 50.5 }
        })
      }).not.toThrow()
    })
  })

  describe('query', () => {
    it('should query without filters', () => {
      logger.query()

      expect(dbAll).toHaveBeenCalledOnce()
      const [sql, params] = (dbAll as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('ORDER BY created_at DESC')
      expect(sql).not.toContain('WHERE')
      expect(params).toContain(100) // default limit
    })

    it('should filter by action', () => {
      logger.query({ action: 'budget.exceeded' })

      const [sql, params] = (dbAll as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('WHERE')
      expect(sql).toContain('action = ?')
      expect(params).toContain('budget.exceeded')
    })

    it('should filter by entityType', () => {
      logger.query({ entityType: 'conversation' })

      const [sql, params] = (dbAll as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('entity_type = ?')
      expect(params).toContain('conversation')
    })

    it('should filter by since timestamp', () => {
      logger.query({ since: '2026-03-01T00:00:00.000Z' })

      const [sql, params] = (dbAll as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('created_at >= ?')
      expect(params).toContain('2026-03-01T00:00:00.000Z')
    })

    it('should combine multiple filters with AND', () => {
      logger.query({ action: 'message.send', entityType: 'conversation', limit: 10 })

      const [sql, params] = (dbAll as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sql).toContain('action = ?')
      expect(sql).toContain('AND')
      expect(sql).toContain('entity_type = ?')
      expect(params).toContain(10)
    })

    it('should respect custom limit', () => {
      logger.query({ limit: 5 })

      const params = (dbAll as ReturnType<typeof vi.fn>).mock.calls[0][1] as number[]
      expect(params[params.length - 1]).toBe(5)
    })

    it('should map rows correctly', () => {
      ;(dbAll as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: 'uuid-1',
          actor_type: 'user',
          actor_id: 'local',
          action: 'conversation.create',
          entity_type: 'conversation',
          entity_id: 'conv_1',
          details: '{"provider":"anthropic"}',
          created_at: '2026-03-10T10:00:00.000Z'
        }
      ])

      const results = logger.query()

      expect(results).toHaveLength(1)
      const entry: ActivityLogEntry = results[0]
      expect(entry.id).toBe('uuid-1')
      expect(entry.actorType).toBe('user')
      expect(entry.actorId).toBe('local')
      expect(entry.action).toBe('conversation.create')
      expect(entry.entityType).toBe('conversation')
      expect(entry.entityId).toBe('conv_1')
      expect(entry.details).toEqual({ provider: 'anthropic' })
      expect(entry.createdAt).toBe('2026-03-10T10:00:00.000Z')
    })

    it('should handle null details in row mapping', () => {
      ;(dbAll as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: 'uuid-2',
          actor_type: 'system',
          actor_id: 'system',
          action: 'session.create',
          entity_type: 'session',
          entity_id: 'sess_1',
          details: null,
          created_at: '2026-03-10T10:00:00.000Z'
        }
      ])

      const results = logger.query()
      expect(results[0].details).toBeNull()
    })
  })

  describe('getActivityLogger singleton', () => {
    it('should return same instance on repeated calls', () => {
      const a = getActivityLogger()
      const b = getActivityLogger()
      expect(a).toBe(b)
    })
  })
})
