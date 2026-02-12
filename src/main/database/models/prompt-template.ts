import { dbRun, dbAll, dbGet } from '../index'
import { generateId } from '../../utils/id-generator'
import type { PromptTemplate, TemplateCategory, TemplateVariable } from '../../../shared/types'

function rowToTemplate(row: Record<string, any>): PromptTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    systemPrompt: row.system_prompt as string,
    category: row.category as TemplateCategory,
    variables: row.variables ? JSON.parse(row.variables as string) : undefined,
    isFavorite: row.is_favorite === 1,
    isBuiltin: row.is_builtin === 1,
    usageCount: row.usage_count as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  }
}

export const PromptTemplateModel = {
  create(data: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>): PromptTemplate {
    const id = generateId()
    const now = Date.now()

    dbRun(
      `INSERT INTO prompt_templates (id, name, description, system_prompt, category, variables, is_favorite, is_builtin, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        data.name,
        data.description || null,
        data.systemPrompt,
        data.category,
        data.variables ? JSON.stringify(data.variables) : null,
        data.isFavorite ? 1 : 0,
        data.isBuiltin ? 1 : 0,
        now,
        now
      ]
    )

    return {
      id,
      ...data,
      usageCount: 0,
      createdAt: now,
      updatedAt: now
    }
  },

  findAll(category?: TemplateCategory): PromptTemplate[] {
    if (category) {
      return dbAll('SELECT * FROM prompt_templates WHERE category = ? ORDER BY is_favorite DESC, usage_count DESC, name ASC', [category])
        .map(rowToTemplate)
    }
    return dbAll('SELECT * FROM prompt_templates ORDER BY is_favorite DESC, usage_count DESC, name ASC')
      .map(rowToTemplate)
  },

  findById(id: string): PromptTemplate | null {
    const row = dbGet('SELECT * FROM prompt_templates WHERE id = ?', [id])
    return row ? rowToTemplate(row) : null
  },

  findFavorites(): PromptTemplate[] {
    return dbAll('SELECT * FROM prompt_templates WHERE is_favorite = 1 ORDER BY usage_count DESC, name ASC')
      .map(rowToTemplate)
  },

  update(id: string, data: Partial<Omit<PromptTemplate, 'id' | 'createdAt' | 'isBuiltin'>>): PromptTemplate | null {
    const existing = this.findById(id)
    if (!existing) return null

    const now = Date.now()
    const updates: string[] = []
    const params: any[] = []

    if (data.name !== undefined) { updates.push('name = ?'); params.push(data.name) }
    if (data.description !== undefined) { updates.push('description = ?'); params.push(data.description || null) }
    if (data.systemPrompt !== undefined) { updates.push('system_prompt = ?'); params.push(data.systemPrompt) }
    if (data.category !== undefined) { updates.push('category = ?'); params.push(data.category) }
    if (data.variables !== undefined) { updates.push('variables = ?'); params.push(data.variables ? JSON.stringify(data.variables) : null) }
    if (data.isFavorite !== undefined) { updates.push('is_favorite = ?'); params.push(data.isFavorite ? 1 : 0) }

    if (updates.length === 0) return existing

    updates.push('updated_at = ?')
    params.push(now)
    params.push(id)

    dbRun(`UPDATE prompt_templates SET ${updates.join(', ')} WHERE id = ?`, params)
    return this.findById(id)
  },

  delete(id: string): boolean {
    const existing = this.findById(id)
    if (!existing) return false
    dbRun('DELETE FROM prompt_templates WHERE id = ?', [id])
    return true
  },

  toggleFavorite(id: string): PromptTemplate | null {
    const existing = this.findById(id)
    if (!existing) return null
    const newFav = existing.isFavorite ? 0 : 1
    dbRun('UPDATE prompt_templates SET is_favorite = ?, updated_at = ? WHERE id = ?', [newFav, Date.now(), id])
    return this.findById(id)
  },

  incrementUsage(id: string): void {
    dbRun('UPDATE prompt_templates SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?', [Date.now(), id])
  },

  count(): number {
    const row = dbGet('SELECT COUNT(*) as cnt FROM prompt_templates')
    return row ? (row.cnt as number) : 0
  },

  countBuiltins(): number {
    const row = dbGet('SELECT COUNT(*) as cnt FROM prompt_templates WHERE is_builtin = 1')
    return row ? (row.cnt as number) : 0
  }
}
