/**
 * Tracking & Analytics Engine
 * Collects usage metrics for LLM interactions: tokens, costs, latency, RAG hits.
 * Stores data in the sql.js database for local-only analytics.
 */

import { dbRun, dbAll, dbGet } from '../database/index'

// ── Cost tables (USD per 1M tokens) ────────────────────────────

const COST_TABLE: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-opus-20240229': { input: 15, output: 75 },
  'claude-3-sonnet-20240229': { input: 3, output: 15 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  // OpenAI
  'gpt-4-turbo-preview': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-4-32k': { input: 60, output: 120 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'gpt-3.5-turbo-16k': { input: 3, output: 4 },
  // Google
  'gemini-pro': { input: 0.5, output: 1.5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-ultra': { input: 7, output: 21 }
}

// Rough estimate: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4

// ── Types ──────────────────────────────────────────────────────

export interface TrackingEvent {
  id: string
  conversationId: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputCost: number
  outputCost: number
  totalCost: number
  latencyMs: number
  ragUsed: boolean
  ragSourceCount: number
  success: boolean
  errorMessage: string | null
  createdAt: number
}

export interface UsageSummary {
  totalMessages: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalCost: number
  byProvider: Record<string, { messages: number; tokens: number; cost: number }>
  byModel: Record<string, { messages: number; tokens: number; cost: number }>
  avgLatencyMs: number
  ragHitRate: number
  errorRate: number
}

export interface DailyUsage {
  date: string
  messages: number
  tokens: number
  cost: number
}

// ── Tracking Engine ────────────────────────────────────────────

export class TrackingEngine {
  /**
   * Estimate token count from text length.
   * This is a rough approximation; real token counts should come from
   * provider APIs when available.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  /**
   * Calculate cost for a given model and token counts.
   */
  calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): { inputCost: number; outputCost: number; totalCost: number } {
    const rates = COST_TABLE[model]
    if (!rates) {
      return { inputCost: 0, outputCost: 0, totalCost: 0 }
    }

    const inputCost = (inputTokens / 1_000_000) * rates.input
    const outputCost = (outputTokens / 1_000_000) * rates.output
    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost
    }
  }

  /**
   * Record a completed LLM interaction.
   */
  recordEvent(params: {
    conversationId: string
    provider: string
    model: string
    inputText: string
    outputText: string
    latencyMs: number
    ragUsed: boolean
    ragSourceCount: number
    success: boolean
    errorMessage?: string
    inputTokens?: number
    outputTokens?: number
  }): TrackingEvent {
    const inputTokens = params.inputTokens ?? this.estimateTokens(params.inputText)
    const outputTokens = params.outputTokens ?? this.estimateTokens(params.outputText)
    const totalTokens = inputTokens + outputTokens

    const { inputCost, outputCost, totalCost } = this.calculateCost(
      params.model,
      inputTokens,
      outputTokens
    )

    const id = `trk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    const now = Date.now()

    dbRun(
      `INSERT INTO tracking_events
        (id, conversation_id, provider, model, input_tokens, output_tokens, total_tokens,
         input_cost, output_cost, total_cost, latency_ms, rag_used, rag_source_count,
         success, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.conversationId,
        params.provider,
        params.model,
        inputTokens,
        outputTokens,
        totalTokens,
        inputCost,
        outputCost,
        totalCost,
        params.latencyMs,
        params.ragUsed ? 1 : 0,
        params.ragSourceCount,
        params.success ? 1 : 0,
        params.errorMessage ?? null,
        now
      ]
    )

    return {
      id,
      conversationId: params.conversationId,
      provider: params.provider,
      model: params.model,
      inputTokens,
      outputTokens,
      totalTokens,
      inputCost,
      outputCost,
      totalCost,
      latencyMs: params.latencyMs,
      ragUsed: params.ragUsed,
      ragSourceCount: params.ragSourceCount,
      success: params.success,
      errorMessage: params.errorMessage ?? null,
      createdAt: now
    }
  }

  /**
   * Get a usage summary for a given time range.
   * If no range is given, returns all-time summary.
   */
  getSummary(fromMs?: number, toMs?: number): UsageSummary {
    let whereClause = ''
    const params: any[] = []

    if (fromMs !== undefined) {
      whereClause += ' WHERE created_at >= ?'
      params.push(fromMs)
    }
    if (toMs !== undefined) {
      whereClause += whereClause ? ' AND created_at <= ?' : ' WHERE created_at <= ?'
      params.push(toMs)
    }

    // Aggregate totals
    const totals = dbGet(
      `SELECT
        COUNT(*) as total_messages,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(AVG(latency_ms), 0) as avg_latency,
        COALESCE(SUM(CASE WHEN rag_used = 1 THEN 1 ELSE 0 END), 0) as rag_count,
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as error_count
       FROM tracking_events${whereClause}`,
      params
    )

    // By provider
    const providerRows = dbAll(
      `SELECT provider,
        COUNT(*) as messages,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COALESCE(SUM(total_cost), 0) as cost
       FROM tracking_events${whereClause}
       GROUP BY provider`,
      params
    )

    const byProvider: Record<string, { messages: number; tokens: number; cost: number }> = {}
    for (const row of providerRows) {
      byProvider[row.provider as string] = {
        messages: row.messages as number,
        tokens: row.tokens as number,
        cost: row.cost as number
      }
    }

    // By model
    const modelRows = dbAll(
      `SELECT model,
        COUNT(*) as messages,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COALESCE(SUM(total_cost), 0) as cost
       FROM tracking_events${whereClause}
       GROUP BY model`,
      params
    )

    const byModel: Record<string, { messages: number; tokens: number; cost: number }> = {}
    for (const row of modelRows) {
      byModel[row.model as string] = {
        messages: row.messages as number,
        tokens: row.tokens as number,
        cost: row.cost as number
      }
    }

    const totalMessages = (totals?.total_messages as number) || 0

    return {
      totalMessages,
      totalInputTokens: (totals?.total_input_tokens as number) || 0,
      totalOutputTokens: (totals?.total_output_tokens as number) || 0,
      totalTokens: (totals?.total_tokens as number) || 0,
      totalCost: (totals?.total_cost as number) || 0,
      byProvider,
      byModel,
      avgLatencyMs: (totals?.avg_latency as number) || 0,
      ragHitRate: totalMessages > 0
        ? ((totals?.rag_count as number) || 0) / totalMessages
        : 0,
      errorRate: totalMessages > 0
        ? ((totals?.error_count as number) || 0) / totalMessages
        : 0
    }
  }

  /**
   * Get daily usage for the last N days.
   */
  getDailyUsage(days: number = 30): DailyUsage[] {
    const fromMs = Date.now() - days * 24 * 60 * 60 * 1000

    const rows = dbAll(
      `SELECT
        DATE(created_at / 1000, 'unixepoch') as date,
        COUNT(*) as messages,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COALESCE(SUM(total_cost), 0) as cost
       FROM tracking_events
       WHERE created_at >= ?
       GROUP BY DATE(created_at / 1000, 'unixepoch')
       ORDER BY date ASC`,
      [fromMs]
    )

    return rows.map((row) => ({
      date: row.date as string,
      messages: row.messages as number,
      tokens: row.tokens as number,
      cost: row.cost as number
    }))
  }

  /**
   * DSGVO/DSG — Enforce data retention: delete tracking events older than N days.
   */
  enforceRetention(retentionDays: number = 365): { success: boolean; deletedCount: number } {
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)
    try {
      dbRun(`DELETE FROM tracking_events WHERE created_at < ?`, [cutoff])
      return { success: true, deletedCount: 0 } // sql.js doesn't return affected rows easily
    } catch (error) {
      console.error('Failed to enforce tracking retention:', error)
      return { success: false, deletedCount: 0 }
    }
  }

  /**
   * Get recent events (for debugging or detailed view).
   */
  getRecentEvents(limit: number = 50): TrackingEvent[] {
    const rows = dbAll(
      `SELECT * FROM tracking_events ORDER BY created_at DESC LIMIT ?`,
      [limit]
    )

    return rows.map((row) => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      provider: row.provider as string,
      model: row.model as string,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      totalTokens: row.total_tokens as number,
      inputCost: row.input_cost as number,
      outputCost: row.output_cost as number,
      totalCost: row.total_cost as number,
      latencyMs: row.latency_ms as number,
      ragUsed: (row.rag_used as number) === 1,
      ragSourceCount: row.rag_source_count as number,
      success: (row.success as number) === 1,
      errorMessage: row.error_message as string | null,
      createdAt: row.created_at as number
    }))
  }
}

// ── Singleton ──────────────────────────────────────────────────

let engineInstance: TrackingEngine | null = null

export function getTrackingEngine(): TrackingEngine {
  if (!engineInstance) {
    engineInstance = new TrackingEngine()
  }
  return engineInstance
}
