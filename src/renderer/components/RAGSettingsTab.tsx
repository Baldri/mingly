import { useState, useEffect, memo } from 'react'

interface RAGContextConfig {
  enabled: boolean
  collectionName: string
  maxChunks: number
  scoreThreshold: number
  preferLocal: boolean
}

interface CollectionInfo {
  name: string
  points_count?: number
  vectors_count?: number
}

export const RAGSettingsTab = memo(function RAGSettingsTab() {
  const [config, setConfig] = useState<RAGContextConfig>({
    enabled: false,
    collectionName: 'documents',
    maxChunks: 3,
    scoreThreshold: 0.65,
    preferLocal: true
  })
  const [serverOnline, setServerOnline] = useState<boolean | null>(null)
  const [collections, setCollections] = useState<CollectionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)

      // Load context injection config
      const configResult = await window.electronAPI.ragContext.getConfig()
      if (configResult.success && configResult.config) {
        setConfig(configResult.config)
      }

      // Check server health
      await checkServerHealth()

      // Load collections
      await loadCollections()
    } catch (error) {
      console.error('Failed to load RAG settings:', error)
    } finally {
      setLoading(false)
    }
  }

  const checkServerHealth = async () => {
    try {
      const result = await window.electronAPI.ragHttp.health()
      setServerOnline(result.success === true)
    } catch {
      setServerOnline(false)
    }
  }

  const loadCollections = async () => {
    try {
      const result = await window.electronAPI.ragHttp.listCollections()
      if (result.success && result.collections) {
        setCollections(result.collections)
      }
    } catch {
      setCollections([])
    }
  }

  const handleSaveConfig = async () => {
    try {
      setSaving(true)
      const result = await window.electronAPI.ragContext.updateConfig(config)
      if (result.success) {
        setStatusMessage({ text: 'Settings saved', type: 'success' })
      } else {
        setStatusMessage({ text: 'Failed to save settings', type: 'error' })
      }
    } catch (error) {
      setStatusMessage({ text: 'Failed to save settings', type: 'error' })
    } finally {
      setSaving(false)
      setTimeout(() => setStatusMessage(null), 3000)
    }
  }

  const handleToggleEnabled = async (enabled: boolean) => {
    const updated = { ...config, enabled }
    setConfig(updated)
    try {
      await window.electronAPI.ragContext.updateConfig({ enabled })
    } catch (error) {
      console.error('Failed to toggle RAG context:', error)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Knowledge Base (RAG)
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Configure retrieval-augmented generation to enrich conversations with your documents
        </p>
      </div>

      {/* Server Status */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`h-3 w-3 rounded-full ${
                serverOnline === true
                  ? 'bg-green-500'
                  : serverOnline === false
                    ? 'bg-red-500'
                    : 'bg-gray-400'
              }`}
            />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                RAG Server
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {serverOnline === true
                  ? 'Connected (localhost:8001)'
                  : serverOnline === false
                    ? 'Offline - start the RAG server to use knowledge base features'
                    : 'Checking...'}
              </p>
            </div>
          </div>
          <button
            onClick={checkServerHealth}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Auto-Context Injection Toggle */}
      <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              Auto-Context Injection
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Automatically search your knowledge base and inject relevant context into every conversation
            </p>
          </div>
          <button
            onClick={() => handleToggleEnabled(!config.enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                config.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Configuration */}
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
          Configuration
        </h4>

        {/* Collection Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Collection Name
          </label>
          <select
            value={config.collectionName}
            onChange={(e) => setConfig({ ...config, collectionName: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          >
            {collections.length > 0 ? (
              collections.map((col) => (
                <option key={col.name} value={col.name}>
                  {col.name} {col.points_count !== undefined ? `(${col.points_count} docs)` : ''}
                </option>
              ))
            ) : (
              <option value={config.collectionName}>{config.collectionName}</option>
            )}
          </select>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            The vector collection to search for relevant context
          </p>
        </div>

        {/* Max Chunks */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Max Context Chunks: {config.maxChunks}
          </label>
          <input
            type="range"
            min={1}
            max={10}
            value={config.maxChunks}
            onChange={(e) => setConfig({ ...config, maxChunks: parseInt(e.target.value) })}
            className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
            <span>1 (faster)</span>
            <span>10 (more context)</span>
          </div>
        </div>

        {/* Score Threshold */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Relevance Threshold: {config.scoreThreshold.toFixed(2)}
          </label>
          <input
            type="range"
            min={0.1}
            max={0.95}
            step={0.05}
            value={config.scoreThreshold}
            onChange={(e) => setConfig({ ...config, scoreThreshold: parseFloat(e.target.value) })}
            className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
            <span>0.10 (more results)</span>
            <span>0.95 (strict match)</span>
          </div>
        </div>

        {/* Prefer Local */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Prefer Local RAG
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Try local Qdrant first, fall back to external server
            </p>
          </div>
          <button
            onClick={() => setConfig({ ...config, preferLocal: !config.preferLocal })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.preferLocal ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                config.preferLocal ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSaveConfig}
            disabled={saving}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
          {statusMessage && (
            <span
              className={`text-sm ${
                statusMessage.type === 'success'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {statusMessage.text}
            </span>
          )}
        </div>
      </div>

      {/* Collections List */}
      <div>
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          Collections ({collections.length})
        </h4>

        {collections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              No collections found
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              {serverOnline
                ? 'Index documents via the RAG server to create collections'
                : 'Start the RAG server to manage collections'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {collections.map((col) => (
              <div
                key={col.name}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              >
                <div className="flex items-center gap-3">
                  <svg
                    className="h-5 w-5 text-purple-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
                    />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {col.name}
                    </p>
                    {col.points_count !== undefined && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {col.points_count} document chunks indexed
                      </p>
                    )}
                  </div>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    col.name === config.collectionName
                      ? 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/20'
                      : 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-900/20'
                  }`}
                >
                  {col.name === config.collectionName ? 'Active' : 'Available'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info Box */}
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
              How RAG Works
            </h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              When enabled, Mingly automatically searches your indexed documents for relevant context
              before each message. This context is injected into the system prompt so the AI can
              reference your knowledge base.
            </p>
            <ul className="mt-2 space-y-1 text-sm text-blue-800 dark:text-blue-400">
              <li>1. Index your documents via the RAG server</li>
              <li>2. Enable auto-context injection above</li>
              <li>3. Ask questions - relevant context is added automatically</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
})
