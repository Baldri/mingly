import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import { useSettingsStore } from '../stores/settings-store'

interface Props {
  isOpen: boolean
  onClose: () => void
}

const PROVIDERS = [
  { id: 'anthropic', name: 'Claude (Anthropic)' },
  { id: 'openai', name: 'ChatGPT (OpenAI)' },
  { id: 'google', name: 'Gemini (Google)' }
]

const MODELS: Record<string, { id: string; name: string }[]> = {
  anthropic: [
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' }
  ],
  openai: [
    { id: 'gpt-4-turbo-preview', name: 'GPT-4 Turbo' },
    { id: 'gpt-4', name: 'GPT-4' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
  ],
  google: [
    { id: 'gemini-pro', name: 'Gemini Pro' },
    { id: 'gemini-pro-vision', name: 'Gemini Pro Vision' }
  ]
}

export function NewConversationModal({ isOpen, onClose }: Props) {
  const { createConversation } = useChatStore()
  const { settings, apiKeysConfigured } = useSettingsStore()

  const [title, setTitle] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState('claude-3-5-sonnet-20241022')

  useEffect(() => {
    if (settings) {
      setProvider(settings.defaultProvider)
      setModel(settings.defaultModel)
    }
  }, [settings])

  useEffect(() => {
    // Update model when provider changes
    const firstModel = MODELS[provider]?.[0]?.id
    if (firstModel) {
      setModel(firstModel)
    }
  }, [provider])

  const handleCreate = async () => {
    if (!title.trim()) return

    await createConversation(title.trim(), provider, model)
    setTitle('')
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreate()
    }
  }

  if (!isOpen) return null

  const hasAPIKey = apiKeysConfigured[provider]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-[500px] max-w-[90vw]">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold">New Conversation</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Conversation Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., Code Review Help"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {MODELS[provider]?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {!hasAPIKey && (
            <div className="p-3 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-900 dark:text-yellow-200 rounded-lg text-sm">
              ⚠️ No API key configured for {provider}. Please add one in
              Settings.
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!title.trim() || !hasAPIKey}
              className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
