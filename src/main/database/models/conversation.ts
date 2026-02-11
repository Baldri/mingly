import { dbRun, dbAll, dbGet } from '../index'
import { generateId } from '../../utils/id-generator'

export interface Conversation {
  id: string
  title: string
  provider: string
  model: string
  createdAt: number
  updatedAt: number
}

export class ConversationModel {
  static create(
    title: string,
    provider: string,
    model: string
  ): Conversation {
    const id = generateId()
    const now = Date.now()

    dbRun(
      `INSERT INTO conversations (id, title, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, title, provider, model, now, now]
    )

    return { id, title, provider, model, createdAt: now, updatedAt: now }
  }

  static findById(id: string): Conversation | null {
    const row = dbGet(
      `SELECT id, title, provider, model, created_at, updated_at
       FROM conversations WHERE id = ?`,
      [id]
    )

    if (!row) return null

    return {
      id: row.id as string,
      title: row.title as string,
      provider: row.provider as string,
      model: row.model as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }
  }

  static findAll(): Conversation[] {
    const rows = dbAll(
      `SELECT id, title, provider, model, created_at, updated_at
       FROM conversations ORDER BY updated_at DESC`
    )

    return rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      provider: row.provider as string,
      model: row.model as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }))
  }

  static update(
    id: string,
    data: Partial<Pick<Conversation, 'title' | 'provider' | 'model'>>
  ): void {
    const now = Date.now()
    const updates: string[] = []
    const values: any[] = []

    if (data.title !== undefined) {
      updates.push('title = ?')
      values.push(data.title)
    }
    if (data.provider !== undefined) {
      updates.push('provider = ?')
      values.push(data.provider)
    }
    if (data.model !== undefined) {
      updates.push('model = ?')
      values.push(data.model)
    }

    updates.push('updated_at = ?')
    values.push(now)
    values.push(id)

    dbRun(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`,
      values
    )
  }

  static updateTimestamp(id: string): void {
    const now = Date.now()
    dbRun(
      'UPDATE conversations SET updated_at = ? WHERE id = ?',
      [now, id]
    )
  }

  static delete(id: string): void {
    dbRun('DELETE FROM conversations WHERE id = ?', [id])
  }

  static count(): number {
    const result = dbGet('SELECT COUNT(*) as count FROM conversations')
    return (result?.count as number) || 0
  }
}
