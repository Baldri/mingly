import { useState, useEffect } from 'react'
import type { NetworkAIServerConfig } from '../../shared/network-ai-types'

export function NetworkAIServersTab() {
  const [servers, setServers] = useState<NetworkAIServerConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [discovering, setDiscovering] = useState(false)
  const [testingServer, setTestingServer] = useState<string | null>(null)

  // Add server form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    type: 'ollama' as const,
    host: 'localhost',
    port: 11434,
    protocol: 'http' as const,
    apiKeyRequired: false,
    apiKey: '',
    tlsVerify: true,
    allowSelfSigned: false
  })

  useEffect(() => {
    loadServers()
  }, [])

  const loadServers = async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.networkAI.listServers()
      if (result.success) {
        setServers(result.servers)
      }
    } catch (error) {
      console.error('Failed to load servers:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDiscoverServers = async () => {
    try {
      setDiscovering(true)
      const result = await window.electronAPI.networkAI.discover('192.168.1')
      if (result.success) {
        console.log('Discovered servers:', result.servers)
        // Refresh server list
        await loadServers()
      }
    } catch (error) {
      console.error('Failed to discover servers:', error)
    } finally {
      setDiscovering(false)
    }
  }

  const handleTestConnection = async (serverId: string) => {
    try {
      setTestingServer(serverId)
      const result = await window.electronAPI.networkAI.testConnection(serverId)

      if (result.success) {
        alert(`✅ Connection successful!\nResponse time: ${result.responseTime}ms`)
      } else {
        alert(`❌ Connection failed:\n${result.error}`)
      }
    } catch (error) {
      console.error('Failed to test connection:', error)
      alert(`❌ Connection failed:\n${error}`)
    } finally {
      setTestingServer(null)
    }
  }

  const handleAddServer = async () => {
    try {
      const result = await window.electronAPI.networkAI.addServer({
        name: formData.name,
        type: formData.type,
        host: formData.host,
        port: formData.port,
        protocol: formData.protocol,
        apiKeyRequired: formData.apiKeyRequired,
        tlsVerify: formData.tlsVerify,
        allowSelfSigned: formData.allowSelfSigned
      })

      if (result.success) {
        setServers([...servers, result.server])
        setShowAddForm(false)
        // Reset form
        setFormData({
          name: '',
          type: 'ollama',
          host: 'localhost',
          port: 11434,
          protocol: 'http',
          apiKeyRequired: false,
          apiKey: '',
          tlsVerify: true,
          allowSelfSigned: false
        })
      }
    } catch (error) {
      console.error('Failed to add server:', error)
    }
  }

  const handleRemoveServer = async (serverId: string) => {
    if (!confirm('Are you sure you want to remove this server?')) return

    try {
      const result = await window.electronAPI.networkAI.removeServer(serverId)
      if (result.success) {
        setServers(servers.filter((s) => s.id !== serverId))
      }
    } catch (error) {
      console.error('Failed to remove server:', error)
    }
  }

  const getServerTypeLabel = (type: string): string => {
    const labels: Record<string, string> = {
      'ollama': 'Ollama',
      'vllm': 'vLLM',
      'text-generation-webui': 'Text Gen WebUI',
      'llamacpp': 'llama.cpp',
      'openai-compatible': 'OpenAI Compatible',
      'custom': 'Custom'
    }
    return labels[type] || type
  }

  const getServerTypeColor = (type: string): string => {
    const colors: Record<string, string> = {
      'ollama': 'bg-purple-100 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400',
      'vllm': 'bg-blue-100 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400',
      'text-generation-webui': 'bg-green-100 text-green-600 dark:bg-green-900/20 dark:text-green-400',
      'llamacpp': 'bg-orange-100 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400',
      'openai-compatible': 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900/20 dark:text-cyan-400',
      'custom': 'bg-gray-100 text-gray-600 dark:bg-gray-900/20 dark:text-gray-400'
    }
    return colors[type] || colors['custom']
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
          Network AI Servers
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Connect to local and network AI servers (Ollama, vLLM, etc.)
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Server
        </button>
        <button
          onClick={handleDiscoverServers}
          disabled={discovering}
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {discovering ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-transparent"></div>
              Discovering...
            </>
          ) : (
            <>
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              Discover Network
            </>
          )}
        </button>
      </div>

      {/* Add Server Form */}
      {showAddForm && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
          <h4 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">
            Add New Server
          </h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="My Ollama Server"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Type
              </label>
              <select
                value={formData.type}
                onChange={(e) =>
                  setFormData({ ...formData, type: e.target.value as any })
                }
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              >
                <option value="ollama">Ollama</option>
                <option value="vllm">vLLM</option>
                <option value="text-generation-webui">Text Gen WebUI</option>
                <option value="llamacpp">llama.cpp</option>
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Host
              </label>
              <input
                type="text"
                value={formData.host}
                onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                placeholder="localhost or 192.168.1.100"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Port
              </label>
              <input
                type="number"
                value={formData.port}
                onChange={(e) =>
                  setFormData({ ...formData, port: parseInt(e.target.value) })
                }
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={handleAddServer}
              disabled={!formData.name || !formData.host}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Add Server
            </button>
          </div>
        </div>
      )}

      {/* Server List */}
      <div>
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          Configured Servers ({servers.length})
        </h4>

        {servers.length === 0 ? (
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
                d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              No servers configured yet
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Add a server or discover network servers
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((server) => (
              <div
                key={server.id}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
                      <svg
                        className="h-6 w-6 text-gray-600 dark:text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
                        />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h5 className="font-medium text-gray-900 dark:text-white">
                          {server.name}
                        </h5>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getServerTypeColor(server.type)}`}
                        >
                          {getServerTypeLabel(server.type)}
                        </span>
                        {server.isLocal && (
                          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-600 dark:bg-blue-900/20 dark:text-blue-400">
                            Local
                          </span>
                        )}
                        {server.isLAN && !server.isLocal && (
                          <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-600 dark:bg-green-900/20 dark:text-green-400">
                            LAN
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        <span className="font-mono">
                          {server.protocol}://{server.host}:{server.port}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="ml-4 flex gap-2">
                  <button
                    onClick={() => handleTestConnection(server.id)}
                    disabled={testingServer === server.id}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    {testingServer === server.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    onClick={() => handleRemoveServer(server.id)}
                    className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800 dark:hover:text-red-400"
                    title="Remove server"
                  >
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
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
          <div>
            <h5 className="text-sm font-semibold text-blue-900 dark:text-blue-300">
              Enterprise Feature
            </h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              Connect to AI servers running in your local network for maximum privacy and control.
              All data stays within your network - no cloud uploads required.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
