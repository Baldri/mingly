import { dbRun, dbAll, dbGet } from '../index'
import { generateId } from '../../utils/id-generator'

export interface Conversation {
  id: string
  title: string
  provider: string
  model: string
  templateId?: string
  /** RAG-Wissen project ID (e.g. "acme", "university") */
  projectId?: string
  /** Qdrant collection name for per-conversation RAG context */
  ragCollectionName?: string
  createdAt: number
  updatedAt: number
}

export class ConversationModel {
  static create(
    title: string,
    provider: string,
    model: string,
    templateId?: string,
    projectId?: string,
    ragCollectionName?: string
  ): Conversation {
    const id = generateId()
    const now = Date.now()

    dbRun(
      `INSERT INTO conversations (id, title, provider, model, template_id, project_id, rag_collection_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, provider, model, templateId || null, projectId || null, ragCollectionName || null, now, now]
    )

    return {
      id, title, provider, model,
      templateId: templateId || undefined,
      projectId: projectId || undefined,
      ragCollectionName: ragCollectionName || undefined,
      createdAt: now, updatedAt: now
    }
  }

  static findById(id: string): Conversation | null {
    const row = dbGet(
      `SELECT id, title, provider, model, template_id, project_id, rag_collection_name, created_at, updated_at
       FROM conversations WHERE id = ?`,
      [id]
    )

    if (!row) return null

    return ConversationModel.rowToConversation(row)
  }

  static findAll(): Conversation[] {
    const rows = dbAll(
      `SELECT id, title, provider, model, template_id, project_id, rag_collection_name, created_at, updated_at
       FROM conversations ORDER BY updated_at DESC`
    )

    return rows.map(ConversationModel.rowToConversation)
  }

  static findByProject(projectId: string): Conversation[] {
    const rows = dbAll(
      `SELECT id, title, provider, model, template_id, project_id, rag_collection_name, created_at, updated_at
       FROM conversations WHERE project_id = ? ORDER BY updated_at DESC`,
      [projectId]
    )

    return rows.map(ConversationModel.rowToConversation)
  }

  private static rowToConversation(row: Record<string, any>): Conversation {
    return {
      id: row.id as string,
      title: row.title as string,
      provider: row.provider as string,
      model: row.model as string,
      templateId: (row.template_id as string) || undefined,
      projectId: (row.project_id as string) || undefined,
      ragCollectionName: (row.rag_collection_name as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }
  }

  static update(
    id: string,
    data: Partial<Pick<Conversation, 'title' | 'provider' | 'model' | 'projectId' | 'ragCollectionName'>>
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
    if (data.projectId !== undefined) {
      updates.push('project_id = ?')
      values.push(data.projectId)
    }
    if (data.ragCollectionName !== undefined) {
      updates.push('rag_collection_name = ?')
      values.push(data.ragCollectionName)
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
