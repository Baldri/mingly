import { dbRun, dbAll, dbGet } from '../index'
import { generateId } from '../../utils/id-generator'
import type { ComparisonSession, ComparisonResult, ComparisonModelConfig } from '../../../shared/types'

function rowToSession(row: Record<string, any>): ComparisonSession {
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    models: JSON.parse(row.models as string),
    createdAt: row.created_at as number
  }
}

function rowToResult(row: Record<string, any>): ComparisonResult {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    provider: row.provider as string,
    model: row.model as string,
    response: row.response as string,
    tokens: row.tokens as number | undefined,
    cost: row.cost as number | undefined,
    latencyMs: row.latency_ms as number,
    isWinner: row.is_winner === 1,
    createdAt: row.created_at as number
  }
}

export const ComparisonModel = {
  createSession(prompt: string, models: ComparisonModelConfig[]): ComparisonSession {
    const id = generateId()
    const now = Date.now()

    dbRun(
      'INSERT INTO comparison_sessions (id, prompt, models, created_at) VALUES (?, ?, ?, ?)',
      [id, prompt, JSON.stringify(models), now]
    )

    return { id, prompt, models, createdAt: now }
  },

  addResult(data: Omit<ComparisonResult, 'id' | 'createdAt'>): ComparisonResult {
    const id = generateId()
    const now = Date.now()

    dbRun(
      `INSERT INTO comparison_results (id, session_id, provider, model, response, tokens, cost, latency_ms, is_winner, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.sessionId,
        data.provider,
        data.model,
        data.response,
        data.tokens || null,
        data.cost || null,
        data.latencyMs,
        data.isWinner ? 1 : 0,
        now
      ]
    )

    return { id, ...data, createdAt: now }
  },

  getSession(id: string): ComparisonSession | null {
    const row = dbGet('SELECT * FROM comparison_sessions WHERE id = ?', [id])
    return row ? rowToSession(row) : null
  },

  getSessionResults(sessionId: string): ComparisonResult[] {
    return dbAll('SELECT * FROM comparison_results WHERE session_id = ? ORDER BY created_at ASC', [sessionId])
      .map(rowToResult)
  },

  getHistory(limit: number = 20): Array<ComparisonSession & { results: ComparisonResult[] }> {
    const sessions = dbAll('SELECT * FROM comparison_sessions ORDER BY created_at DESC LIMIT ?', [limit])
      .map(rowToSession)

    return sessions.map((session) => ({
      ...session,
      results: this.getSessionResults(session.id)
    }))
  },

  markWinner(sessionId: string, resultId: string): boolean {
    // Clear previous winners for this session
    dbRun('UPDATE comparison_results SET is_winner = 0 WHERE session_id = ?', [sessionId])
    // Set new winner
    dbRun('UPDATE comparison_results SET is_winner = 1 WHERE id = ? AND session_id = ?', [resultId, sessionId])
    return true
  }
}
