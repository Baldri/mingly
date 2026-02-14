import { useState, useEffect, memo, useCallback } from 'react'
import type { DiscoveredService } from '../../shared/types'
import { useSettingsStore } from '../stores/settings-store'

interface RAGContextConfig {
  enabled: boolean
  collectionName: string
  maxChunks: number
  scoreThreshold: number
  preferLocal: boolean
  ragWissenEnabled: boolean
  ragWissenCollection: string
}

interface RAGWissenConfig {
  host: string
  port: number
  protocol: 'http' | 'https'
  enabled: boolean
  defaultCollection: string
  apiMode: 'rest' | 'jsonrpc'
}

interface DocMindStatus {
  config?: any
  mcp?: { connected: boolean; tools?: number; error?: string }
  rest?: { reachable: boolean; error?: string }
  contextInjection?: { enabled: boolean }
}

interface CollectionInfo {
  name: string
  points_count?: number
  vectors_count?: number
}

// ── Sub-Components ────────────────────────────────────────────────

const StatusDot = memo(({ status }: { status: boolean | null }) => (
  <div
    className={`h-3 w-3 rounded-full flex-shrink-0 ${
      status === true
        ? 'bg-green-500'
        : status === false
          ? 'bg-red-500'
          : 'bg-gray-400 animate-pulse'
    }`}
  />
))
StatusDot.displayName = 'StatusDot'

const Toggle = memo(({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <button
    onClick={() => !disabled && onChange(!value)}
    disabled={disabled}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
      value ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
        value ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
))
Toggle.displayName = 'Toggle'

// ── Main Component ────────────────────────────────────────────────

export const RAGSettingsTab = memo(function RAGSettingsTab() {
  const settings = useSettingsStore((s) => s.settings)
  const ragServerName = settings?.ragServerName || 'RAG-Wissen'

  // Context injection config
  const [config, setConfig] = useState<RAGContextConfig>({
    enabled: false,
    collectionName: 'documents',
    maxChunks: 3,
    scoreThreshold: 0.65,
    preferLocal: true,
    ragWissenEnabled: false,
    ragWissenCollection: 'documents'
  })

  // RAG-Wissen / DocMind server config
  const [wissenConfig, setWissenConfig] = useState<RAGWissenConfig>({
    host: 'localhost',
    port: 8001,
    protocol: 'http',
    enabled: true,
    defaultCollection: 'documents',
    apiMode: 'jsonrpc'
  })

  // DocMind status
  const [docMindStatus, setDocMindStatus] = useState<DocMindStatus | null>(null)

  // Server statuses
  const [ragHttpOnline, setRagHttpOnline] = useState<boolean | null>(null)
  const [wissenOnline, setWissenOnline] = useState<boolean | null>(null)

  const [collections, setCollections] = useState<CollectionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  // Service Discovery
  const [discoveredServices, setDiscoveredServices] = useState<DiscoveredService[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)

  const discoverServers = useCallback(async () => {
    setIsDiscovering(true)
    try {
      const result = await window.electronAPI.serviceDiscovery.discover({ type: 'rag' })
      if (result.success && result.services) {
        setDiscoveredServices(result.services)
      }
    } catch {
      // Discovery failed
    } finally {
      setIsDiscovering(false)
    }
  }, [])

  // Server config form
  const [showServerConfig, setShowServerConfig] = useState(false)
  const [serverForm, setServerForm] = useState({
    host: 'localhost',
    port: '8001',
    apiMode: 'jsonrpc' as 'rest' | 'jsonrpc'
  })

  useEffect(() => {
    loadData()
  }, [])

  const loadData = useCallback(async () => {
    try {
      setLoading(true)

      // Load all configs in parallel
      const [configResult, wissenConfigResult, docMindStatusResult] = await Promise.allSettled([
        window.electronAPI.ragContext.getConfig(),
        window.electronAPI.ragWissen.getConfig(),
        window.electronAPI.docmind?.getStatus()
      ])

      if (configResult.status === 'fulfilled' && configResult.value.success && configResult.value.config) {
        setConfig(configResult.value.config)
      }

      if (wissenConfigResult.status === 'fulfilled' && wissenConfigResult.value.success && wissenConfigResult.value.config) {
        const wc = wissenConfigResult.value.config
        setWissenConfig(wc)
        setServerForm({
          host: wc.host || 'localhost',
          port: String(wc.port || 8001),
          apiMode: wc.apiMode || 'jsonrpc'
        })
      }

      if (docMindStatusResult.status === 'fulfilled' && docMindStatusResult.value?.success) {
        setDocMindStatus(docMindStatusResult.value)
      }

      // Check servers + collections in parallel
      await Promise.all([checkRagHttpHealth(), checkWissenHealth(), loadCollections()])
    } catch (error) {
      console.error('Failed to load RAG settings:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  const checkRagHttpHealth = async () => {
    try {
      const result = await window.electronAPI.ragHttp.health()
      setRagHttpOnline(result.success === true)
    } catch {
      setRagHttpOnline(false)
    }
  }

  const checkWissenHealth = async () => {
    try {
      const result = await window.electronAPI.ragWissen.health()
      setWissenOnline(result.success === true)
    } catch {
      setWissenOnline(false)
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
        showStatus('Settings saved', 'success')
      } else {
        showStatus('Failed to save settings', 'error')
      }
    } catch {
      showStatus('Failed to save settings', 'error')
    } finally {
      setSaving(false)
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

  const handleToggleWissen = async (ragWissenEnabled: boolean) => {
    const updated = { ...config, ragWissenEnabled }
    setConfig(updated)
    try {
      await window.electronAPI.ragContext.updateConfig({ ragWissenEnabled })
    } catch (error) {
      console.error('Failed to toggle RAG server:', error)
    }
  }

  const handleSaveServerConfig = async () => {
    try {
      setSaving(true)
      const port = parseInt(serverForm.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        showStatus('Invalid port number', 'error')
        return
      }

      const updates: Partial<RAGWissenConfig> = {
        host: serverForm.host,
        port,
        apiMode: serverForm.apiMode,
        enabled: true
      }

      const result = await window.electronAPI.ragWissen.updateConfig(updates)
      if (result.success) {
        setWissenConfig({ ...wissenConfig, ...updates })
        showStatus('Server configuration saved', 'success')
        // Re-check health with new config
        setTimeout(checkWissenHealth, 500)
      } else {
        showStatus('Failed to save server configuration', 'error')
      }
    } catch {
      showStatus('Failed to save server configuration', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDocMindInit = async () => {
    try {
      setSaving(true)
      const result = await window.electronAPI.docmind?.initialize()
      if (result?.success) {
        showStatus('DocMind initialized successfully', 'success')
        // Refresh status
        const status = await window.electronAPI.docmind?.getStatus()
        if (status?.success) setDocMindStatus(status)
        setTimeout(checkWissenHealth, 500)
      } else {
        showStatus('DocMind initialization failed', 'error')
      }
    } catch {
      showStatus('Failed to initialize DocMind', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDocMindMCPToggle = async () => {
    try {
      setSaving(true)
      if (docMindStatus?.mcp?.connected) {
        await window.electronAPI.docmind?.disconnectMCP()
      } else {
        await window.electronAPI.docmind?.connectMCP()
      }
      // Refresh status
      const status = await window.electronAPI.docmind?.getStatus()
      if (status?.success) setDocMindStatus(status)
    } catch (error) {
      console.error('DocMind MCP toggle failed:', error)
    } finally {
      setSaving(false)
    }
  }

  const showStatus = (text: string, type: 'success' | 'error') => {
    setStatusMessage({ text, type })
    setTimeout(() => setStatusMessage(null), 3000)
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

      {/* ── Service Discovery ─────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Discover RAG Servers</h4>
          <button
            onClick={discoverServers}
            disabled={isDiscovering}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            {isDiscovering ? 'Scanning...' : 'Discover'}
          </button>
        </div>

        {discoveredServices.length > 0 && (
          <div className="space-y-2">
            {['local', 'network', 'cloud'].map((location) => {
              const services = discoveredServices.filter((s) => s.location === location)
              if (services.length === 0) return null
              return (
                <div key={location}>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                    {location === 'local' ? 'Local' : location === 'network' ? 'Network' : 'Cloud'}
                  </p>
                  {services.map((s, i) => (
                    <div
                      key={`${s.url}-${i}`}
                      className="flex items-center justify-between rounded border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm mb-1"
                    >
                      <div className="flex items-center gap-2">
                        <StatusDot status={s.status === 'online'} />
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white">{s.name}</span>
                          {s.provider && (
                            <span className="ml-1.5 text-xs text-gray-400">{s.provider}</span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-gray-400">{s.url}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Server Status Overview ─────────────────────────────── */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Server Status</h4>

        {/* RAG HTTP Server */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <StatusDot status={ragHttpOnline} />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  RAG HTTP Server (Qdrant)
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {ragHttpOnline ? 'Connected' : 'Offline'} — Local vector database
                </p>
              </div>
            </div>
            <button
              onClick={checkRagHttpHealth}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* RAG-Wissen / DocMind Server */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <StatusDot status={wissenOnline} />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  {ragServerName} Server
                  {wissenConfig.apiMode === 'rest' && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/20 dark:text-purple-400">
                      DocMind
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {wissenOnline ? 'Connected' : 'Offline'} — {wissenConfig.host}:{wissenConfig.port} ({wissenConfig.apiMode})
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowServerConfig(!showServerConfig)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                {showServerConfig ? 'Close' : 'Configure'}
              </button>
              <button
                onClick={checkWissenHealth}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>

        {/* DocMind MCP Status */}
        {docMindStatus && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <StatusDot status={docMindStatus.mcp?.connected ?? null} />
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    DocMind MCP Tools
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {docMindStatus.mcp?.connected
                      ? `Connected — ${docMindStatus.mcp?.tools || 0} tools available`
                      : 'Disconnected — MCP stdio server'}
                  </p>
                </div>
              </div>
              <button
                onClick={handleDocMindMCPToggle}
                disabled={saving}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                  docMindStatus.mcp?.connected
                    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
                    : 'text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-900/20'
                } disabled:opacity-50`}
              >
                {docMindStatus.mcp?.connected ? 'Disconnect' : 'Connect'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Server Configuration Form ──────────────────────────── */}
      {showServerConfig && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-900/10">
          <h4 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">
            {ragServerName} Server Configuration
          </h4>
          <div className="space-y-4">
            {/* Display Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Display Name
              </label>
              <input
                type="text"
                defaultValue={ragServerName}
                onBlur={(e) => {
                  const name = e.target.value.trim()
                  useSettingsStore.getState().updateSettings({ ragServerName: name || undefined })
                }}
                placeholder="RAG-Wissen"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Customize how your RAG server is displayed throughout the app
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Host
                </label>
                <input
                  type="text"
                  value={serverForm.host}
                  onChange={(e) => setServerForm({ ...serverForm, host: e.target.value })}
                  placeholder="localhost"
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Port
                </label>
                <input
                  type="number"
                  value={serverForm.port}
                  onChange={(e) => setServerForm({ ...serverForm, port: e.target.value })}
                  placeholder="8001"
                  min={1}
                  max={65535}
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  API Mode
                </label>
                <select
                  value={serverForm.apiMode}
                  onChange={(e) => setServerForm({ ...serverForm, apiMode: e.target.value as 'rest' | 'jsonrpc' })}
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                >
                  <option value="jsonrpc">JSON-RPC (MCP-over-HTTP)</option>
                  <option value="rest">REST (DocMind FastAPI)</option>
                </select>
              </div>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              <strong>JSON-RPC:</strong> Standard MCP protocol via HTTP (default port 8001).{' '}
              <strong>REST:</strong> Native DocMind FastAPI endpoints (default port 8000).
            </p>

            {/* Presets */}
            <div className="flex gap-2">
              <button
                onClick={() => setServerForm({ host: 'localhost', port: '8001', apiMode: 'jsonrpc' })}
                className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                Default (8001 JSON-RPC)
              </button>
              <button
                onClick={() => setServerForm({ host: 'localhost', port: '8000', apiMode: 'rest' })}
                className="rounded-md border border-purple-300 px-3 py-1 text-xs font-medium text-purple-600 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-900/20"
              >
                DocMind (8000 REST)
              </button>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowServerConfig(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveServerConfig}
                disabled={saving}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save & Test Connection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DocMind Quick-Init (if not yet initialized) */}
      {window.electronAPI.docmind && !docMindStatus?.mcp?.connected && !docMindStatus?.rest?.reachable && (
        <div className="rounded-lg border border-purple-200 bg-purple-50/50 p-4 dark:border-purple-900 dark:bg-purple-900/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-purple-900 dark:text-purple-300">
                DocMind Integration
              </p>
              <p className="text-xs text-purple-700 dark:text-purple-400">
                Connect to your DocMind knowledge base (MCP + REST + Context Injection)
              </p>
            </div>
            <button
              onClick={handleDocMindInit}
              disabled={saving}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {saving ? 'Initializing...' : 'Initialize DocMind'}
            </button>
          </div>
        </div>
      )}

      {/* ── Auto-Context Injection Toggle ──────────────────────── */}
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
          <Toggle value={config.enabled} onChange={handleToggleEnabled} />
        </div>
      </div>

      {/* RAG-Wissen as Source Toggle */}
      <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              Include {ragServerName} in Context
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Use {ragServerName} / DocMind as an additional knowledge source in the fallback chain
            </p>
          </div>
          <Toggle value={config.ragWissenEnabled} onChange={handleToggleWissen} />
        </div>
      </div>

      {/* ── Configuration ──────────────────────────────────────── */}
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
          Context Injection Configuration
        </h4>

        {/* Collection Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Collection Name
          </label>
          <select
            value={config.collectionName}
            onChange={(e) => setConfig({ ...config, collectionName: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm dark:text-white"
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
              Try local Qdrant first, fall back to {ragServerName} / external server
            </p>
          </div>
          <Toggle
            value={config.preferLocal}
            onChange={(v) => setConfig({ ...config, preferLocal: v })}
          />
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

      {/* ── Collections List ────────────────────────────────────── */}
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
              {ragHttpOnline
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

      {/* ── Info Box ────────────────────────────────────────────── */}
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
              before each message. The fallback chain:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-blue-800 dark:text-blue-400">
              <li>1. <strong>Local Qdrant</strong> — Fast, runs in-process</li>
              <li>2. <strong>{ragServerName} / DocMind</strong> — Semantic search with hybrid retrieval</li>
              <li>3. <strong>External HTTP RAG</strong> — Custom Python server</li>
            </ul>
            <p className="mt-2 text-xs text-blue-700 dark:text-blue-500">
              Configure server connections above, then enable Auto-Context Injection.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
})
