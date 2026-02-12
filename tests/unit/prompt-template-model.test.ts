/**
 * PromptTemplateModel Tests
 * Tests CRUD, favorites, usage counting, built-in seeding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock database functions
const mockDb: Record<string, any>[] = []
let nextId = 0

vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn((sql: string, params: any[] = []) => {
    if (sql.startsWith('INSERT')) {
      mockDb.push({
        id: params[0],
        name: params[1],
        description: params[2],
        system_prompt: params[3],
        category: params[4],
        variables: params[5],
        is_favorite: params[6],
        is_builtin: params[7],
        usage_count: 0,
        created_at: params[8] || Date.now(),
        updated_at: params[9] || Date.now()
      })
    } else if (sql.startsWith('DELETE')) {
      const id = params[params.length - 1]
      const idx = mockDb.findIndex((r) => r.id === id)
      if (idx >= 0) mockDb.splice(idx, 1)
    } else if (sql.startsWith('UPDATE') && sql.includes('usage_count = usage_count + 1')) {
      const id = params[params.length - 1]
      const row = mockDb.find((r) => r.id === id)
      if (row) row.usage_count++
    } else if (sql.startsWith('UPDATE') && sql.includes('is_favorite')) {
      const id = params[params.length - 1]
      const row = mockDb.find((r) => r.id === id)
      if (row) row.is_favorite = params[0]
    } else if (sql.startsWith('UPDATE')) {
      const id = params[params.length - 1]
      const row = mockDb.find((r) => r.id === id)
      if (row) {
        // Parse SET clause to update fields
        if (sql.includes('name = ?')) row.name = params[0]
      }
    }
  }),
  dbAll: vi.fn((sql: string, params: any[] = []) => {
    if (sql.includes('WHERE category = ?')) {
      return mockDb.filter((r) => r.category === params[0])
    }
    if (sql.includes('WHERE is_favorite = 1')) {
      return mockDb.filter((r) => r.is_favorite === 1)
    }
    return [...mockDb]
  }),
  dbGet: vi.fn((sql: string, params: any[] = []) => {
    if (sql.includes('COUNT(*)')) {
      if (sql.includes('is_builtin = 1')) {
        return { cnt: mockDb.filter((r) => r.is_builtin === 1).length }
      }
      return { cnt: mockDb.length }
    }
    const id = params[0]
    return mockDb.find((r) => r.id === id) || null
  })
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn(() => `tmpl-${++nextId}`)
}))

import { PromptTemplateModel } from '../../src/main/database/models/prompt-template'

describe('PromptTemplateModel', () => {
  beforeEach(() => {
    mockDb.length = 0
    nextId = 0
    vi.clearAllMocks()
  })

  describe('create', () => {
    it('should create a template and return it', () => {
      const template = PromptTemplateModel.create({
        name: 'Test Template',
        description: 'A test template',
        systemPrompt: 'You are a test assistant.',
        category: 'custom',
        isFavorite: false,
        isBuiltin: false
      })

      expect(template.id).toBe('tmpl-1')
      expect(template.name).toBe('Test Template')
      expect(template.systemPrompt).toBe('You are a test assistant.')
      expect(template.category).toBe('custom')
      expect(template.usageCount).toBe(0)
    })

    it('should create a template with variables', () => {
      const template = PromptTemplateModel.create({
        name: 'With Vars',
        systemPrompt: 'Help with {{language}}',
        category: 'code',
        variables: [{ name: 'language', label: 'Language', required: true }],
        isFavorite: false,
        isBuiltin: false
      })

      expect(template.variables).toHaveLength(1)
      expect(template.variables![0].name).toBe('language')
    })
  })

  describe('findAll', () => {
    it('should return all templates', () => {
      PromptTemplateModel.create({ name: 'A', systemPrompt: 'a', category: 'code', isFavorite: false, isBuiltin: false })
      PromptTemplateModel.create({ name: 'B', systemPrompt: 'b', category: 'creative', isFavorite: false, isBuiltin: false })

      const all = PromptTemplateModel.findAll()
      expect(all.length).toBe(2)
    })

    it('should filter by category', () => {
      PromptTemplateModel.create({ name: 'A', systemPrompt: 'a', category: 'code', isFavorite: false, isBuiltin: false })
      PromptTemplateModel.create({ name: 'B', systemPrompt: 'b', category: 'creative', isFavorite: false, isBuiltin: false })

      const codeOnly = PromptTemplateModel.findAll('code')
      expect(codeOnly.length).toBe(1)
      expect(codeOnly[0].category).toBe('code')
    })
  })

  describe('findById', () => {
    it('should find a template by id', () => {
      const created = PromptTemplateModel.create({ name: 'Find Me', systemPrompt: 'x', category: 'custom', isFavorite: false, isBuiltin: false })
      const found = PromptTemplateModel.findById(created.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Find Me')
    })

    it('should return null for unknown id', () => {
      expect(PromptTemplateModel.findById('nonexistent')).toBeNull()
    })
  })

  describe('delete', () => {
    it('should delete an existing template', () => {
      const created = PromptTemplateModel.create({ name: 'Delete Me', systemPrompt: 'x', category: 'custom', isFavorite: false, isBuiltin: false })
      const result = PromptTemplateModel.delete(created.id)
      expect(result).toBe(true)
    })

    it('should return false for unknown id', () => {
      expect(PromptTemplateModel.delete('nonexistent')).toBe(false)
    })
  })

  describe('toggleFavorite', () => {
    it('should toggle favorite status', () => {
      const created = PromptTemplateModel.create({ name: 'Fav', systemPrompt: 'x', category: 'custom', isFavorite: false, isBuiltin: false })
      const toggled = PromptTemplateModel.toggleFavorite(created.id)
      expect(toggled).not.toBeNull()
      // The mock updates is_favorite to 1 (toggled from 0)
      expect(mockDb[0].is_favorite).toBe(1)
    })

    it('should return null for unknown id', () => {
      expect(PromptTemplateModel.toggleFavorite('nonexistent')).toBeNull()
    })
  })

  describe('incrementUsage', () => {
    it('should increment usage count', () => {
      const created = PromptTemplateModel.create({ name: 'Used', systemPrompt: 'x', category: 'custom', isFavorite: false, isBuiltin: false })
      PromptTemplateModel.incrementUsage(created.id)
      expect(mockDb[0].usage_count).toBe(1)
      PromptTemplateModel.incrementUsage(created.id)
      expect(mockDb[0].usage_count).toBe(2)
    })
  })

  describe('count', () => {
    it('should count all templates', () => {
      PromptTemplateModel.create({ name: 'A', systemPrompt: 'a', category: 'code', isFavorite: false, isBuiltin: false })
      expect(PromptTemplateModel.count()).toBe(1)
    })

    it('should count builtins', () => {
      PromptTemplateModel.create({ name: 'A', systemPrompt: 'a', category: 'code', isFavorite: false, isBuiltin: true })
      PromptTemplateModel.create({ name: 'B', systemPrompt: 'b', category: 'code', isFavorite: false, isBuiltin: false })
      expect(PromptTemplateModel.countBuiltins()).toBe(1)
    })
  })
})
