/**
 * ConversationSessionManager — persists provider-specific session state
 * (e.g., OpenAI thread IDs, continuity tokens) across app restarts.
 *
 * Uses the same singleton + dbRun/dbGet/dbAll pattern as the rest of the codebase.
 */

import { dbRun, dbGet, dbAll } from '../database/index.js'
import { randomUUID } from 'crypto'

export interface ConversationSession {
  id: string
  conversationId: string
  provider: string
  model: string
  sessionParams: Record<string, unknown> | null
  sessionDisplayId: string | null
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export class ConversationSessionManager {
  /**
   * Get or create a session for a conversation + provider pair.
   */
  getOrCreate(conversationId: string, provider: string, model: string): ConversationSession {
    const existing = dbGet(
      'SELECT * FROM conversation_sessions WHERE conversation_id = ? AND provider = ?',
      [conversationId, provider]
    )

    if (existing) {
      return this.mapRow(existing)
    }

    const id = randomUUID()
    const now = Date.now()
    dbRun(
      `INSERT INTO conversation_sessions
       (id, conversation_id, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, conversationId, provider, model, now, now]
    )

    return {
      id,
      conversationId,
      provider,
      model,
      sessionParams: null,
      sessionDisplayId: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Update session parameters (provider-specific state).
   */
  updateParams(conversationId: string, provider: string, params: Record<string, unknown>): void {
    dbRun(
      `UPDATE conversation_sessions
       SET session_params = ?, updated_at = ?
       WHERE conversation_id = ? AND provider = ?`,
      [JSON.stringify(params), Date.now(), conversationId, provider]
    )
  }

  /**
   * Accumulate token usage and cost for a session.
   */
  addUsage(conversationId: string, provider: string, inputTokens: number, outputTokens: number, cost: number): void {
    dbRun(
      `UPDATE conversation_sessions
       SET total_input_tokens = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?,
           total_cost = total_cost + ?,
           updated_at = ?
       WHERE conversation_id = ? AND provider = ?`,
      [inputTokens, outputTokens, cost, Date.now(), conversationId, provider]
    )
  }

  /**
   * Record an error on a session.
   */
  setError(conversationId: string, provider: string, error: string): void {
    dbRun(
      `UPDATE conversation_sessions
       SET last_error = ?, updated_at = ?
       WHERE conversation_id = ? AND provider = ?`,
      [error, Date.now(), conversationId, provider]
    )
  }

  /**
   * Get session for a conversation + provider.
   */
  get(conversationId: string, provider: string): ConversationSession | null {
    const row = dbGet(
      'SELECT * FROM conversation_sessions WHERE conversation_id = ? AND provider = ?',
      [conversationId, provider]
    )
    return row ? this.mapRow(row) : null
  }

  /**
   * Get all sessions for a conversation.
   */
  getAll(conversationId: string): ConversationSession[] {
    const rows = dbAll(
      'SELECT * FROM conversation_sessions WHERE conversation_id = ? ORDER BY updated_at DESC',
      [conversationId]
    )
    return rows.map(this.mapRow)
  }

  private mapRow(row: Record<string, unknown>): ConversationSession {
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      provider: row.provider as string,
      model: row.model as string,
      sessionParams: row.session_params ? JSON.parse(row.session_params as string) : null,
      sessionDisplayId: row.session_display_id as string | null,
      totalInputTokens: (row.total_input_tokens as number) ?? 0,
      totalOutputTokens: (row.total_output_tokens as number) ?? 0,
      totalCost: (row.total_cost as number) ?? 0,
      lastError: row.last_error as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }
}

// Singleton
let instance: ConversationSessionManager | null = null
export function getSessionManager(): ConversationSessionManager {
  if (!instance) {
    instance = new ConversationSessionManager()
  }
  return instance
}
