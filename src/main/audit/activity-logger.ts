/**
 * ActivityLogger — logs user and system actions into the activity_log table.
 *
 * Shared interface (Phase 4.1) used identically in Claude Remote, Mingly, and Nexbid.
 * Uses the same singleton + dbRun/dbAll pattern as ConversationSessionManager.
 */

import { dbRun, dbAll } from '../database/index.js'
import { randomUUID } from 'crypto'
import { createLogger } from '../../shared/logger'
import type { ActivityLogEntry, ActivityLoggerInterface } from './types.js'

const logger = createLogger('ActivityLogger')

export class ActivityLogger implements ActivityLoggerInterface {
  /**
   * Insert an activity log entry.
   * ID and createdAt are generated automatically.
   */
  log(entry: Omit<ActivityLogEntry, 'id' | 'createdAt'>): void {
    const id = randomUUID()
    const createdAt = new Date().toISOString()

    try {
      dbRun(
        `INSERT INTO activity_log
         (id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          entry.actorType,
          entry.actorId,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.details ? JSON.stringify(entry.details) : null,
          createdAt,
        ]
      )
    } catch (err) {
      logger.error('Failed to write activity log', { error: String(err), action: entry.action })
    }
  }

  /**
   * Query the activity log with optional filters.
   */
  query(filter: {
    entityType?: string
    action?: string
    since?: string
    limit?: number
  } = {}): ActivityLogEntry[] {
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (filter.entityType) {
      conditions.push('entity_type = ?')
      params.push(filter.entityType)
    }

    if (filter.action) {
      conditions.push('action = ?')
      params.push(filter.action)
    }

    if (filter.since) {
      conditions.push('created_at >= ?')
      params.push(filter.since)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filter.limit ?? 100

    const sql = `SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ?`
    params.push(limit)

    const rows = dbAll(sql, params)
    return rows.map(this.mapRow)
  }

  private mapRow(row: Record<string, unknown>): ActivityLogEntry {
    return {
      id: row.id as string,
      actorType: row.actor_type as string,
      actorId: row.actor_id as string,
      action: row.action as string,
      entityType: row.entity_type as string,
      entityId: row.entity_id as string,
      details: row.details ? JSON.parse(row.details as string) : null,
      createdAt: row.created_at as string,
    }
  }
}

// Singleton
let instance: ActivityLogger | null = null
export function getActivityLogger(): ActivityLogger {
  if (!instance) {
    instance = new ActivityLogger()
  }
  return instance
}
