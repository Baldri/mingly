import { useEffect, useState, useRef } from 'react'
import { useTemplateStore } from '../stores/template-store'
import type { PromptTemplate, TemplateCategory, TemplateVariable } from '../../shared/types'

const CATEGORIES: Array<{ id: TemplateCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'code', label: 'Code' },
  { id: 'creative', label: 'Creative' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'translation', label: 'Translation' },
  { id: 'business', label: 'Business' },
  { id: 'education', label: 'Education' },
  { id: 'custom', label: 'Custom' },
]

const CATEGORY_COLORS: Record<string, string> = {
  code: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  creative: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  analysis: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  translation: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  business: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  education: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
  custom: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
}

interface TemplateFormData {
  name: string
  description: string
  systemPrompt: string
  category: TemplateCategory
  variables: TemplateVariable[]
}

const EMPTY_FORM: TemplateFormData = {
  name: '',
  description: '',
  systemPrompt: '',
  category: 'custom',
  variables: [],
}

export function TemplatesTab() {
  const {
    templates,
    filter,
    isLoading,
    error,
    loadTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    toggleFavorite,
    exportTemplates,
    importTemplates,
    setFilter,
    clearError,
  } = useTemplateStore()

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<TemplateFormData>(EMPTY_FORM)
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  const filteredTemplates = filter.favoriteOnly
    ? templates.filter((t) => t.isFavorite)
    : templates

  const handleCreate = () => {
    setEditingId(null)
    setFormData(EMPTY_FORM)
    setShowForm(true)
  }

  const handleEdit = (template: PromptTemplate) => {
    setEditingId(template.id)
    setFormData({
      name: template.name,
      description: template.description || '',
      systemPrompt: template.systemPrompt,
      category: template.category,
      variables: template.variables || [],
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.systemPrompt.trim()) return

    const data = {
      name: formData.name.trim(),
      description: formData.description.trim() || undefined,
      systemPrompt: formData.systemPrompt.trim(),
      category: formData.category,
      variables: formData.variables.length > 0 ? formData.variables : undefined,
      isFavorite: false,
      isBuiltin: false,
    }

    if (editingId) {
      await updateTemplate(editingId, data)
    } else {
      await createTemplate(data)
    }

    setShowForm(false)
    setEditingId(null)
    setFormData(EMPTY_FORM)
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingId(null)
    setFormData(EMPTY_FORM)
  }

  const handleDelete = async (id: string) => {
    await deleteTemplate(id)
  }

  const handleExport = async () => {
    const json = await exportTemplates()
    if (json) {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'mingly-templates.json'
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const count = await importTemplates(text)
    if (count > 0) {
      // Reset input so the same file can be re-imported if needed
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const addVariable = () => {
    setFormData((prev) => ({
      ...prev,
      variables: [
        ...prev.variables,
        { name: '', label: '', required: false },
      ],
    }))
  }

  const updateVariable = (index: number, field: keyof TemplateVariable, value: string | boolean) => {
    setFormData((prev) => ({
      ...prev,
      variables: prev.variables.map((v, i) =>
        i === index ? { ...v, [field]: value } : v
      ),
    }))
  }

  const removeVariable = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      variables: prev.variables.filter((_, i) => i !== index),
    }))
  }

  if (isLoading && templates.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Prompt Templates
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Reusable system prompts for consistent AI behavior
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700 transition-colors"
          >
            Export
          </button>
          <label className="cursor-pointer rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700 transition-colors">
            Import
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
          </label>
          <button
            onClick={handleCreate}
            className="rounded-lg bg-blue-500 px-3 py-1.5 text-sm text-white hover:bg-blue-600 transition-colors"
          >
            + New Template
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-900/20">
          <span className="text-sm text-red-700 dark:text-red-400">{error}</span>
          <button
            onClick={clearError}
            className="text-sm text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Category Filter */}
      <div className="flex flex-wrap items-center gap-2">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setFilter({ category: cat.id })}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter.category === cat.id
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            }`}
          >
            {cat.label}
          </button>
        ))}
        <span className="mx-2 text-gray-300 dark:text-gray-600">|</span>
        <button
          onClick={() => setFilter({ favoriteOnly: !filter.favoriteOnly })}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            filter.favoriteOnly
              ? 'bg-yellow-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
          }`}
        >
          Favorites Only
        </button>
      </div>

      {/* Template Form */}
      {showForm && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-900/10">
          <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
            {editingId ? 'Edit Template' : 'New Template'}
          </h4>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Code Reviewer"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  Category
                </label>
                <select
                  value={formData.category}
                  onChange={(e) =>
                    setFormData({ ...formData, category: e.target.value as TemplateCategory })
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CATEGORIES.filter((c) => c.id !== 'all').map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Description
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description of what this template does"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                System Prompt *
              </label>
              <textarea
                value={formData.systemPrompt}
                onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                placeholder="You are a helpful assistant that..."
                rows={5}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-mono dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">
                Use {'{{variableName}}'} for dynamic variables
              </p>
            </div>

            {/* Variables */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Variables ({formData.variables.length})
                </label>
                <button
                  onClick={addVariable}
                  className="text-xs text-blue-500 hover:text-blue-700"
                >
                  + Add Variable
                </button>
              </div>
              {formData.variables.map((variable, i) => (
                <div key={i} className="mb-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={variable.name}
                    onChange={(e) => updateVariable(i, 'name', e.target.value)}
                    placeholder="name"
                    className="w-28 rounded border border-gray-300 px-2 py-1 text-xs font-mono dark:border-gray-600 dark:bg-gray-800"
                  />
                  <input
                    type="text"
                    value={variable.label}
                    onChange={(e) => updateVariable(i, 'label', e.target.value)}
                    placeholder="Label"
                    className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                  />
                  <input
                    type="text"
                    value={variable.defaultValue || ''}
                    onChange={(e) => updateVariable(i, 'defaultValue', e.target.value)}
                    placeholder="Default"
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={(e) => updateVariable(i, 'required', e.target.checked)}
                      className="rounded"
                    />
                    Req
                  </label>
                  <button
                    onClick={() => removeVariable(i)}
                    className="text-red-400 hover:text-red-600"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>

            {/* Form Actions */}
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSave}
                disabled={!formData.name.trim() || !formData.systemPrompt.trim()}
                className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {editingId ? 'Save Changes' : 'Create Template'}
              </button>
              <button
                onClick={handleCancel}
                className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template List */}
      {filteredTemplates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {filter.favoriteOnly
              ? 'No favorite templates yet'
              : filter.category !== 'all'
                ? `No templates in "${filter.category}" category`
                : 'No templates yet'}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Templates will appear here once they are created or imported
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredTemplates.map((template) => (
            <div
              key={template.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleFavorite(template.id)}
                    className={`text-lg ${
                      template.isFavorite
                        ? 'text-yellow-500'
                        : 'text-gray-300 hover:text-yellow-400 dark:text-gray-600'
                    }`}
                    title={template.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    {template.isFavorite ? '\u2605' : '\u2606'}
                  </button>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {template.name}
                      </span>
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          CATEGORY_COLORS[template.category] || CATEGORY_COLORS.custom
                        }`}
                      >
                        {template.category}
                      </span>
                      {template.isBuiltin && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                          built-in
                        </span>
                      )}
                    </div>
                    {template.description && (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">
                        {template.description}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="ml-4 flex items-center gap-3">
                <span className="text-xs text-gray-400" title="Usage count">
                  {template.usageCount}x
                </span>
                {!template.isBuiltin && (
                  <>
                    <button
                      onClick={() => handleEdit(template)}
                      className="text-xs text-blue-500 hover:text-blue-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(template.id)}
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Info */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-900/20">
        <div className="flex gap-3">
          <svg
            className="h-5 w-5 flex-shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="flex-1">
            <h5 className="text-sm font-semibold text-blue-900 dark:text-blue-300">
              Using Templates
            </h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              Select a template when creating a new conversation to apply its system prompt
              automatically. Templates with variables will prompt you for values.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
