import React, { useState, useEffect, memo } from 'react'
import type { MCPServer, MCPTool } from '../../shared/types'

export const MCPServersTab = memo(function MCPServersTab() {
  const [servers, setServers] = useState<MCPServer[]>([])
  const [tools, setTools] = useState<MCPTool[]>([])
  const [loading, setLoading] = useState(true)
  const [connectingServer, setConnectingServer] = useState<string | null>(null)
  const [expandedServer, setExpandedServer] = useState<string | null>(null)

  // Add server form
  const [showAddForm, setShowAddForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    command: '',
    args: '',
    env: ''
  })
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    loadServers()
  }, [])

  const loadServers = async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.mcp.listServers()
      if (result.success) {
        setServers(result.servers)
        // Load tools for all connected servers
        const toolsResult = await window.electronAPI.mcp.listTools()
        if (toolsResult.success) {
          setTools(toolsResult.tools)
        }
      }
    } catch (error) {
      console.error('Failed to load MCP servers:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAddServer = async () => {
    setFormError(null)

    if (!formData.name.trim() || !formData.command.trim()) {
      setFormError('Name and command are required')
      return
    }

    try {
      const args = formData.args.trim()
        ? formData.args.split(/\s+/).filter(Boolean)
        : undefined

      let env: Record<string, string> | undefined
      if (formData.env.trim()) {
        env = {}
        for (const line of formData.env.split('\n')) {
          const eqIndex = line.indexOf('=')
          if (eqIndex > 0) {
            const key = line.substring(0, eqIndex).trim()
            const value = line.substring(eqIndex + 1).trim()
            if (key) env[key] = value
          }
        }
      }

      const result = await window.electronAPI.mcp.addAndConnect({
        name: formData.name.trim(),
        command: formData.command.trim(),
        args,
        env
      })

      if (result.success) {
        setShowAddForm(false)
        setFormData({ name: '', command: '', args: '', env: '' })
        await loadServers()
      } else {
        setFormError(result.error || 'Failed to add server')
      }
    } catch (error) {
      setFormError((error as Error).message)
    }
  }

  const handleConnect = async (serverId: string) => {
    try {
      setConnectingServer(serverId)
      const result = await window.electronAPI.mcp.connect(serverId)
      if (result.success) {
        await loadServers()
      }
    } catch (error) {
      console.error('Failed to connect:', error)
    } finally {
      setConnectingServer(null)
    }
  }

  const handleDisconnect = async (serverId: string) => {
    try {
      setConnectingServer(serverId)
      const result = await window.electronAPI.mcp.disconnect(serverId)
      if (result.success) {
        await loadServers()
      }
    } catch (error) {
      console.error('Failed to disconnect:', error)
    } finally {
      setConnectingServer(null)
    }
  }

  const getServerTools = (serverId: string): MCPTool[] => {
    const server = servers.find((s) => s.id === serverId)
    if (!server) return []
    return tools.filter((t) => t.serverName === server.name)
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
          MCP Servers
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Connect to Model Context Protocol servers for extended tool capabilities
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
          onClick={loadServers}
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Add Server Form */}
      {showAddForm && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
          <h4 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">
            Add MCP Server
          </h4>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="My RAG Server"
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Command *
                </label>
                <input
                  type="text"
                  value={formData.command}
                  onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                  placeholder="python, npx, node, etc."
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Arguments (space-separated)
              </label>
              <input
                type="text"
                value={formData.args}
                onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                placeholder="-m mcp_server --port 3001"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-mono dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Environment Variables (one per line, KEY=VALUE)
              </label>
              <textarea
                value={formData.env}
                onChange={(e) => setFormData({ ...formData, env: e.target.value })}
                placeholder={'QDRANT_URL=http://localhost:6333\nCOLLECTION_NAME=default'}
                rows={3}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-mono dark:border-gray-600 dark:bg-gray-800"
              />
            </div>

            {formError && (
              <div className="text-sm text-red-600 dark:text-red-400">{formError}</div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAddForm(false)
                  setFormError(null)
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleAddServer}
                disabled={!formData.name.trim() || !formData.command.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Add & Connect
              </button>
            </div>
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
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              No MCP servers configured
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Add a server to connect to external tools and data sources
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((server) => {
              const serverTools = getServerTools(server.id)
              const isExpanded = expandedServer === server.id
              const isConnecting = connectingServer === server.id

              return (
                <div
                  key={server.id}
                  className="rounded-lg border border-gray-200 dark:border-gray-700"
                >
                  {/* Server Header */}
                  <div className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
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
                            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h5 className="font-medium text-gray-900 dark:text-white truncate">
                            {server.name}
                          </h5>
                          {server.connected ? (
                            <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/20 dark:text-green-400">
                              Connected
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                              Disconnected
                            </span>
                          )}
                          {server.connected && serverTools.length > 0 && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {serverTools.length} tool{serverTools.length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                          {server.command}{server.args ? ` ${server.args.join(' ')}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="ml-4 flex items-center gap-2">
                      {/* Expand/collapse tools */}
                      {server.connected && serverTools.length > 0 && (
                        <button
                          onClick={() => setExpandedServer(isExpanded ? null : server.id)}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          {isExpanded ? 'Hide Tools' : 'Show Tools'}
                        </button>
                      )}
                      {/* Connect/Disconnect */}
                      <button
                        onClick={() =>
                          server.connected
                            ? handleDisconnect(server.id)
                            : handleConnect(server.id)
                        }
                        disabled={isConnecting}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                          server.connected
                            ? 'border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20'
                            : 'border border-green-300 text-green-600 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/20'
                        } disabled:opacity-50`}
                      >
                        {isConnecting
                          ? 'Working...'
                          : server.connected
                            ? 'Disconnect'
                            : 'Connect'}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Tools List */}
                  {isExpanded && serverTools.length > 0 && (
                    <div className="border-t border-gray-200 bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/30">
                      <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                        Available Tools
                      </div>
                      <div className="space-y-2">
                        {serverTools.map((tool) => (
                          <div
                            key={tool.id}
                            className="rounded-md bg-white p-3 border border-gray-200 dark:bg-gray-800 dark:border-gray-700"
                          >
                            <div className="flex items-center gap-2">
                              <svg className="h-4 w-4 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              </svg>
                              <span className="text-sm font-medium text-gray-900 dark:text-white font-mono">
                                {tool.toolName}
                              </span>
                            </div>
                            {tool.description && (
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 pl-6">
                                {tool.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
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
              About MCP Servers
            </h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              MCP (Model Context Protocol) servers provide external tools that the AI can use
              during conversations. Servers communicate via stdio using JSON-RPC 2.0.
              Each server can expose multiple tools with specific input schemas.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
})
