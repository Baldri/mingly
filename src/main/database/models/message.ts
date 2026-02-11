import { dbRun, dbAll, dbGet } from '../index'
import { generateId } from '../../utils/id-generator'
import type { Message } from '../../../shared/types'

export class MessageModel {
  static create(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    tokens?: number
  ): Message {
    const id = generateId()
    const now = Date.now()

    dbRun(
      `INSERT INTO messages (id, conversation_id, role, content, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, conversationId, role, content, tokens ?? null, now]
    )

    return { id, conversationId, role, content, tokens, createdAt: now }
  }

  static findByConversation(conversationId: string): Message[] {
    const rows = dbAll(
      `SELECT id, conversation_id, role, content, tokens, created_at
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
      [conversationId]
    )

    return rows.map((row) => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      role: row.role as 'user' | 'assistant',
      content: row.content as string,
      tokens: row.tokens as number | undefined,
      createdAt: row.created_at as number
    }))
  }

  static deleteByConversation(conversationId: string): void {
    dbRun('DELETE FROM messages WHERE conversation_id = ?', [conversationId])
  }

  static delete(id: string): void {
    dbRun('DELETE FROM messages WHERE id = ?', [id])
  }

  static count(conversationId?: string): number {
    if (conversationId) {
      const result = dbGet(
        'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
        [conversationId]
      )
      return (result?.count as number) || 0
    } else {
      const result = dbGet('SELECT COUNT(*) as count FROM messages')
      return (result?.count as number) || 0
    }
  }

  static getLatest(conversationId: string, limit: number = 10): Message[] {
    const rows = dbAll(
      `SELECT id, conversation_id, role, content, tokens, created_at
       FROM messages WHERE conversation_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [conversationId, limit]
    )

    // Reverse to get chronological order
    return rows.reverse().map((row) => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      role: row.role as 'user' | 'assistant',
      content: row.content as string,
      tokens: row.tokens as number | undefined,
      createdAt: row.created_at as number
    }))
  }
}
