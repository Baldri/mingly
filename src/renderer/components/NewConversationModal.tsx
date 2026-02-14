import React, { useState, useEffect } from 'react'
import { X, Cpu, Sparkles } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import { useSettingsStore } from '../stores/settings-store'

interface Props {
  isOpen: boolean
  onClose: () => void
}

const CLOUD_PROVIDERS = [
  { id: 'anthropic', name: 'Claude (Anthropic)', group: 'cloud' },
  { id: 'openai', name: 'ChatGPT (OpenAI)', group: 'cloud' },
  { id: 'google', name: 'Gemini (Google)', group: 'cloud' }
]

const CLOUD_MODELS: Record<string, { id: string; name: string }[]> = {
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

interface LocalModel {
  id: string
  name: string
  source: string
  port: number
  size?: number
}

export function NewConversationModal({ isOpen, onClose }: Props) {
  const { createConversation } = useChatStore()
  const { settings, apiKeysConfigured, checkAPIKeys } = useSettingsStore()

  const [title, setTitle] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState('claude-3-5-sonnet-20241022')
  const [localModels, setLocalModels] = useState<LocalModel[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [keysLoaded, setKeysLoaded] = useState(false)

  // Load API keys on mount to fix the "no key" warning on first open
  useEffect(() => {
    if (isOpen && !keysLoaded) {
      checkAPIKeys().then(() => setKeysLoaded(true))
    }
  }, [isOpen, keysLoaded, checkAPIKeys])

  // Discover local models when modal opens
  useEffect(() => {
    if (!isOpen) return
    setDiscovering(true)
    window.electronAPI.localLLM.discover()
      .then((result: { success: boolean; models?: LocalModel[] }) => {
        if (result.success && result.models) {
          setLocalModels(result.models)
        }
      })
      .catch(() => {})
      .finally(() => setDiscovering(false))
  }, [isOpen])

  // Apply defaults from settings
  useEffect(() => {
    if (settings) {
      setProvider(settings.defaultProvider)
      setModel(settings.defaultModel)
    }
  }, [settings])

  // Update model when provider changes
  useEffect(() => {
    if (provider === 'auto') {
      setModel('gemma-router')
      return
    }
    if (provider === 'local') {
      const first = localModels[0]
      if (first) setModel(first.id)
      return
    }
    const firstCloud = CLOUD_MODELS[provider]?.[0]?.id
    if (firstCloud) setModel(firstCloud)
  }, [provider, localModels])

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

  // For cloud providers, check API key. Auto/local don't need one.
  const needsApiKey = provider !== 'auto' && provider !== 'local'
  const hasAPIKey = !needsApiKey || apiKeysConfigured[provider]

  // Build provider list: auto-routing + cloud + local
  const allProviders = [
    { id: 'auto', name: 'Gemma Auto-Routing', group: 'auto' as const },
    ...CLOUD_PROVIDERS,
    ...(localModels.length > 0
      ? [{ id: 'local', name: `Local Models (${localModels.length})`, group: 'local' as const }]
      : [])
  ]

  // Build model list for current provider
  let availableModels: { id: string; name: string }[] = []
  if (provider === 'auto') {
    availableModels = [{ id: 'gemma-router', name: 'Automatic (Gemma decides)' }]
  } else if (provider === 'local') {
    availableModels = localModels.map((m) => ({
      id: m.id,
      name: `${m.name} (${m.source})`
    }))
  } else {
    availableModels = CLOUD_MODELS[provider] || []
  }

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
              {allProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.group === 'auto' ? '\u2728 ' : p.group === 'local' ? '\uD83D\uDDA5 ' : ''}
                  {p.name}
                </option>
              ))}
            </select>

            {/* Discovering indicator */}
            {discovering && (
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 flex items-center gap-1">
                <Cpu size={12} className="animate-pulse" />
                Scanning for local models...
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Provider hints */}
          {provider === 'auto' && (
            <div className="p-3 bg-purple-50 dark:bg-purple-900/20 text-purple-800 dark:text-purple-200 rounded-lg text-sm flex items-start gap-2">
              <Sparkles size={16} className="flex-shrink-0 mt-0.5" />
              <span>Gemma analyzes each message and routes it to the best available model automatically.</span>
            </div>
          )}

          {provider === 'local' && (
            <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded-lg text-sm flex items-start gap-2">
              <Cpu size={16} className="flex-shrink-0 mt-0.5" />
              <span>Running locally — no data leaves your machine.</span>
            </div>
          )}

          {needsApiKey && keysLoaded && !apiKeysConfigured[provider] && (
            <div className="p-3 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-900 dark:text-yellow-200 rounded-lg text-sm">
              No API key configured for {provider}. Please add one in Settings.
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
