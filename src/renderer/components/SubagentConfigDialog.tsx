/**
 * SubagentConfigDialog — modal for configuring subtask provider/model.
 *
 * After the master LLM decomposes a task into subtasks,
 * this dialog lets the user choose provider/model per subtask.
 * Quick-actions: "Alle lokal" / "Alle Cloud" set all at once.
 */

import { memo, useState, useCallback } from 'react'
import type { AgentModelSlot, SubagentTask } from '../../shared/types'

interface SubagentConfigDialogProps {
  subtasks: SubagentTask[]
  masterSlot: AgentModelSlot
  masterSummary: string
  onUpdateSlot: (taskId: string, slot: AgentModelSlot) => void
  onStart: () => void
  onCancel: () => void
}

// Default local/cloud presets
const LOCAL_PRESET: AgentModelSlot = {
  provider: 'ollama',
  model: 'llama3.1:8b',
  label: 'Lokal'
}

const CLOUD_PRESETS: AgentModelSlot[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514', label: 'Claude Sonnet' },
  { provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' }
]

export const SubagentConfigDialog = memo(function SubagentConfigDialog({
  subtasks,
  masterSlot,
  masterSummary,
  onUpdateSlot,
  onStart,
  onCancel
}: SubagentConfigDialogProps) {
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [customProvider, setCustomProvider] = useState('')
  const [customModel, setCustomModel] = useState('')

  const handleSetAllLocal = useCallback(() => {
    for (const task of subtasks) {
      onUpdateSlot(task.id, { ...LOCAL_PRESET })
    }
  }, [subtasks, onUpdateSlot])

  const handleSetAllCloud = useCallback(() => {
    for (const task of subtasks) {
      onUpdateSlot(task.id, { ...masterSlot })
    }
  }, [subtasks, masterSlot, onUpdateSlot])

  const handleCustomSlot = useCallback((taskId: string) => {
    if (customProvider && customModel) {
      onUpdateSlot(taskId, {
        provider: customProvider,
        model: customModel,
        label: `${customProvider}/${customModel}`
      })
      setEditingTaskId(null)
      setCustomProvider('')
      setCustomModel('')
    }
  }, [customProvider, customModel, onUpdateSlot])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl rounded-xl bg-white shadow-2xl dark:bg-gray-900">
        {/* Header */}
        <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Subtask-Konfiguration
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {masterSummary}
          </p>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-6 py-3 dark:border-gray-700">
          <span className="text-xs text-gray-500 dark:text-gray-400">Schnellauswahl:</span>
          <button
            onClick={handleSetAllLocal}
            className="rounded-md border border-purple-300 px-3 py-1 text-xs font-medium text-purple-700 hover:bg-purple-50 dark:border-purple-700 dark:text-purple-300 dark:hover:bg-purple-900/20"
          >
            🏠 Alle lokal (Ollama)
          </button>
          <button
            onClick={handleSetAllCloud}
            className="rounded-md border border-blue-300 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/20"
          >
            ☁️ Alle Cloud (Master-Modell)
          </button>
        </div>

        {/* Subtask list */}
        <div className="max-h-96 overflow-y-auto px-6 py-4 space-y-3">
          {subtasks.map((task, index) => (
            <div
              key={task.id}
              className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                      {index + 1}
                    </span>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {task.title}
                    </span>
                  </div>
                  <p className="mt-1 ml-7 text-xs text-gray-500 dark:text-gray-400">
                    {task.description}
                  </p>
                </div>

                {/* Slot selector */}
                <div className="flex-shrink-0">
                  {editingTaskId === task.id ? (
                    <div className="flex items-center gap-1">
                      <select
                        value={customProvider}
                        onChange={(e) => setCustomProvider(e.target.value)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                      >
                        <option value="">Provider...</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="openai">OpenAI</option>
                        <option value="google">Google</option>
                        <option value="ollama">Ollama</option>
                        <option value="generic-openai">OpenAI-Kompatibel</option>
                      </select>
                      <input
                        type="text"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder="Modell..."
                        className="w-28 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                      />
                      <button
                        onClick={() => handleCustomSlot(task.id)}
                        disabled={!customProvider || !customModel}
                        className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        ✓
                      </button>
                      <button
                        onClick={() => setEditingTaskId(null)}
                        className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        task.slot.provider === 'ollama'
                          ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                      }`}>
                        {task.slot.label || `${task.slot.provider}/${task.slot.model}`}
                      </span>
                      <button
                        onClick={() => {
                          setEditingTaskId(task.id)
                          setCustomProvider(task.slot.provider)
                          setCustomModel(task.slot.model)
                        }}
                        className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
                        title="Ändern"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      {/* Quick presets per task */}
                      <button
                        onClick={() => onUpdateSlot(task.id, { ...LOCAL_PRESET })}
                        className="rounded p-0.5 text-purple-400 hover:bg-purple-50 hover:text-purple-600 dark:hover:bg-purple-900/20"
                        title="Lokal (Ollama)"
                      >
                        🏠
                      </button>
                      {CLOUD_PRESETS.map((preset) => (
                        <button
                          key={preset.provider}
                          onClick={() => onUpdateSlot(task.id, { ...preset })}
                          className="rounded p-0.5 text-blue-400 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20"
                          title={preset.label}
                        >
                          ☁️
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <button
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Abbrechen
          </button>
          <button
            onClick={onStart}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            🚀 Subtasks starten
          </button>
        </div>
      </div>
    </div>
  )
})

export default SubagentConfigDialog
