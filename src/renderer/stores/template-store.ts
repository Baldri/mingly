import { create } from 'zustand'
import type { PromptTemplate, TemplateCategory } from '../../shared/types'

interface TemplateFilter {
  category: TemplateCategory | 'all'
  favoriteOnly: boolean
}

interface TemplateState {
  templates: PromptTemplate[]
  selectedTemplate: PromptTemplate | null
  filter: TemplateFilter
  isLoading: boolean
  error: string | null

  // Actions
  loadTemplates: () => Promise<void>
  createTemplate: (data: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>) => Promise<PromptTemplate | null>
  updateTemplate: (id: string, data: Partial<PromptTemplate>) => Promise<void>
  deleteTemplate: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>
  selectTemplate: (template: PromptTemplate | null) => void
  setFilter: (filter: Partial<TemplateFilter>) => void
  exportTemplates: () => Promise<string | null>
  importTemplates: (jsonString: string) => Promise<number>
  clearError: () => void
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: [],
  selectedTemplate: null,
  filter: { category: 'all', favoriteOnly: false },
  isLoading: false,
  error: null,

  loadTemplates: async () => {
    set({ isLoading: true, error: null })
    try {
      const category = get().filter.category
      const result = await window.electronAPI.templates.list(
        category === 'all' ? undefined : category
      )
      if (result.success && result.templates) {
        set({ templates: result.templates })
      }
    } catch (error) {
      console.error('Failed to load templates:', error)
      set({ error: 'Failed to load templates' })
    } finally {
      set({ isLoading: false })
    }
  },

  createTemplate: async (data) => {
    try {
      const result = await window.electronAPI.templates.create(data)
      if (result.success && result.template) {
        set((state) => ({ templates: [result.template, ...state.templates] }))
        return result.template
      }
      set({ error: result.error || 'Failed to create template' })
      return null
    } catch (error) {
      console.error('Failed to create template:', error)
      set({ error: 'Failed to create template' })
      return null
    }
  },

  updateTemplate: async (id, data) => {
    try {
      const result = await window.electronAPI.templates.update(id, data)
      if (result.success && result.template) {
        set((state) => ({
          templates: state.templates.map((t) => (t.id === id ? result.template : t)),
          selectedTemplate:
            state.selectedTemplate?.id === id ? result.template : state.selectedTemplate,
        }))
      }
    } catch (error) {
      console.error('Failed to update template:', error)
      set({ error: 'Failed to update template' })
    }
  },

  deleteTemplate: async (id) => {
    try {
      const result = await window.electronAPI.templates.delete(id)
      if (result.success) {
        set((state) => ({
          templates: state.templates.filter((t) => t.id !== id),
          selectedTemplate: state.selectedTemplate?.id === id ? null : state.selectedTemplate,
        }))
      }
    } catch (error) {
      console.error('Failed to delete template:', error)
      set({ error: 'Failed to delete template' })
    }
  },

  toggleFavorite: async (id) => {
    try {
      const result = await window.electronAPI.templates.toggleFavorite(id)
      if (result.success && result.template) {
        set((state) => ({
          templates: state.templates.map((t) => (t.id === id ? result.template : t)),
        }))
      }
    } catch (error) {
      console.error('Failed to toggle favorite:', error)
    }
  },

  selectTemplate: (template) => {
    set({ selectedTemplate: template })
  },

  setFilter: (filter) => {
    set((state) => ({
      filter: { ...state.filter, ...filter },
    }))
    // Reload with new filter
    get().loadTemplates()
  },

  exportTemplates: async () => {
    try {
      const result = await window.electronAPI.templates.export()
      if (result.success && result.json) {
        return result.json
      }
      return null
    } catch (error) {
      console.error('Failed to export templates:', error)
      set({ error: 'Failed to export templates' })
      return null
    }
  },

  importTemplates: async (jsonString) => {
    try {
      const result = await window.electronAPI.templates.import(jsonString)
      if (result.success) {
        // Reload after import
        await get().loadTemplates()
        return result.count || 0
      }
      set({ error: result.error || 'Failed to import templates' })
      return 0
    } catch (error) {
      console.error('Failed to import templates:', error)
      set({ error: 'Failed to import templates' })
      return 0
    }
  },

  clearError: () => set({ error: null }),
}))
