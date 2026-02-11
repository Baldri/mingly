import React, { useState, useEffect, memo } from 'react'

interface IntegrationStatus {
  slack: { configured: boolean; teamName?: string }
  notion: { configured: boolean; workspaceName?: string }
  obsidian: { configured: boolean; vaultPath?: string; indexedFiles?: number }
}

export const IntegrationsTab = memo(function IntegrationsTab() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [loading, setLoading] = useState(true)

  // Slack form
  const [slackWebhook, setSlackWebhook] = useState('')
  const [slackTeam, setSlackTeam] = useState('')
  const [slackBotToken, setSlackBotToken] = useState('')
  const [slackSaving, setSlackSaving] = useState(false)
  const [slackError, setSlackError] = useState<string | null>(null)
  const [slackIndexing, setSlackIndexing] = useState(false)
  const [slackIndexResult, setSlackIndexResult] = useState<string | null>(null)

  // Notion form
  const [notionKey, setNotionKey] = useState('')
  const [notionWorkspace, setNotionWorkspace] = useState('')
  const [notionSaving, setNotionSaving] = useState(false)
  const [notionError, setNotionError] = useState<string | null>(null)

  // Obsidian
  const [obsidianIndexing, setObsidianIndexing] = useState(false)
  const [obsidianError, setObsidianError] = useState<string | null>(null)

  useEffect(() => {
    loadStatus()
  }, [])

  const loadStatus = async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.integrations.getStatus()
      if (result.success) setStatus(result.status)
    } catch (error) {
      console.error('Failed to load integration status:', error)
    } finally {
      setLoading(false)
    }
  }

  // ---- Slack ----
  const handleConfigureSlack = async () => {
    setSlackError(null)
    setSlackSaving(true)
    try {
      const result = await window.electronAPI.integrations.slack.configure(slackWebhook, slackTeam || undefined, slackBotToken || undefined)
      if (result.success) {
        setSlackWebhook('')
        setSlackTeam('')
        setSlackBotToken('')
        await loadStatus()
      } else {
        setSlackError(result.error || 'Failed')
      }
    } catch (error) {
      setSlackError((error as Error).message)
    } finally {
      setSlackSaving(false)
    }
  }

  const handleDisconnectSlack = async () => {
    await window.electronAPI.integrations.slack.disconnect()
    await loadStatus()
  }

  const handleIndexSlackToRAG = async () => {
    setSlackIndexing(true)
    setSlackIndexResult(null)
    setSlackError(null)
    try {
      const result = await window.electronAPI.integrations.slack.indexToRAG({ daysBack: 30 })
      if (result.success) {
        setSlackIndexResult(`Indexed ${result.indexed || 0} conversation threads`)
      } else {
        setSlackError(result.error || 'Indexing failed')
      }
    } catch (error) {
      setSlackError((error as Error).message)
    } finally {
      setSlackIndexing(false)
    }
  }

  // ---- Notion ----
  const handleConfigureNotion = async () => {
    setNotionError(null)
    setNotionSaving(true)
    try {
      const result = await window.electronAPI.integrations.notion.configure(notionKey, notionWorkspace || undefined)
      if (result.success) {
        setNotionKey('')
        setNotionWorkspace('')
        await loadStatus()
      } else {
        setNotionError(result.error || 'Failed')
      }
    } catch (error) {
      setNotionError((error as Error).message)
    } finally {
      setNotionSaving(false)
    }
  }

  const handleDisconnectNotion = async () => {
    await window.electronAPI.integrations.notion.disconnect()
    await loadStatus()
  }

  // ---- Obsidian ----
  const handleSelectVault = async () => {
    setObsidianError(null)
    try {
      const result = await window.electronAPI.file.select()
      if (result && result.filePaths && result.filePaths[0]) {
        const vaultResult = await window.electronAPI.integrations.obsidian.setVault(result.filePaths[0])
        if (vaultResult.success) {
          await loadStatus()
        } else {
          setObsidianError(vaultResult.error || 'Failed')
        }
      }
    } catch (error) {
      setObsidianError((error as Error).message)
    }
  }

  const handleIndexVault = async () => {
    setObsidianIndexing(true)
    setObsidianError(null)
    try {
      const result = await window.electronAPI.integrations.obsidian.index()
      if (!result.success) {
        setObsidianError(result.error || 'Indexing failed')
      }
      await loadStatus()
    } catch (error) {
      setObsidianError((error as Error).message)
    } finally {
      setObsidianIndexing(false)
    }
  }

  const handleDisconnectObsidian = async () => {
    await window.electronAPI.integrations.obsidian.disconnect()
    await loadStatus()
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
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Integrations</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Connect Mingly to your workflow tools
        </p>
      </div>

      {/* Slack */}
      <IntegrationCard
        title="Slack"
        description="Share AI conversations & index channels for RAG"
        icon={<SlackIcon />}
        configured={status?.slack.configured || false}
        connectedLabel={status?.slack.teamName}
        onDisconnect={handleDisconnectSlack}
      >
        {!status?.slack.configured ? (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Webhook URL</label>
              <input
                type="url"
                value={slackWebhook}
                onChange={(e) => setSlackWebhook(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Team Name (optional)</label>
              <input
                type="text"
                value={slackTeam}
                onChange={(e) => setSlackTeam(e.target.value)}
                placeholder="My Workspace"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Bot Token (optional, for RAG indexing)</label>
              <input
                type="password"
                value={slackBotToken}
                onChange={(e) => setSlackBotToken(e.target.value)}
                placeholder="xoxb-..."
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
              <p className="mt-1 text-xs text-gray-400">Requires channels:read and channels:history scopes</p>
            </div>
            {slackError && <p className="text-sm text-red-600 dark:text-red-400">{slackError}</p>}
            <button
              onClick={handleConfigureSlack}
              disabled={!slackWebhook || slackSaving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {slackSaving ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {slackError && <p className="text-sm text-red-600 dark:text-red-400">{slackError}</p>}
            {slackIndexResult && <p className="text-sm text-green-600 dark:text-green-400">{slackIndexResult}</p>}
            <button
              onClick={handleIndexSlackToRAG}
              disabled={slackIndexing}
              className="rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/20"
            >
              {slackIndexing ? 'Indexing...' : 'Index Channels to RAG'}
            </button>
            <p className="text-xs text-gray-400">Indexes the last 30 days of channel messages into the knowledge base</p>
          </div>
        )}
      </IntegrationCard>

      {/* Notion */}
      <IntegrationCard
        title="Notion"
        description="Save conversations as Notion pages"
        icon={<NotionIcon />}
        configured={status?.notion.configured || false}
        connectedLabel={status?.notion.workspaceName}
        onDisconnect={handleDisconnectNotion}
      >
        {!status?.notion.configured && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Internal Integration Token</label>
              <input
                type="password"
                value={notionKey}
                onChange={(e) => setNotionKey(e.target.value)}
                placeholder="ntn_..."
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Workspace Name (optional)</label>
              <input
                type="text"
                value={notionWorkspace}
                onChange={(e) => setNotionWorkspace(e.target.value)}
                placeholder="My Workspace"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            {notionError && <p className="text-sm text-red-600 dark:text-red-400">{notionError}</p>}
            <button
              onClick={handleConfigureNotion}
              disabled={!notionKey || notionSaving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {notionSaving ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        )}
      </IntegrationCard>

      {/* Obsidian */}
      <IntegrationCard
        title="Obsidian"
        description="Index your Obsidian vault for RAG knowledge base"
        icon={<ObsidianIcon />}
        configured={status?.obsidian.configured || false}
        connectedLabel={status?.obsidian.vaultPath ? `${status.obsidian.indexedFiles || 0} files indexed` : undefined}
        onDisconnect={handleDisconnectObsidian}
      >
        {!status?.obsidian.configured ? (
          <div className="space-y-3">
            {obsidianError && <p className="text-sm text-red-600 dark:text-red-400">{obsidianError}</p>}
            <button
              onClick={handleSelectVault}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Select Vault Directory
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
              {status?.obsidian.vaultPath}
            </div>
            {obsidianError && <p className="text-sm text-red-600 dark:text-red-400">{obsidianError}</p>}
            <button
              onClick={handleIndexVault}
              disabled={obsidianIndexing}
              className="rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/20"
            >
              {obsidianIndexing ? 'Indexing...' : 'Re-index Vault'}
            </button>
          </div>
        )}
      </IntegrationCard>
    </div>
  )
})

// ---- Shared Card Component ----

function IntegrationCard({ title, description, icon, configured, connectedLabel, onDisconnect, children }: {
  title: string
  description: string
  icon: React.ReactNode
  configured: boolean
  connectedLabel?: string
  onDisconnect: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
            {icon}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-gray-900 dark:text-white">{title}</h4>
              {configured && (
                <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/20 dark:text-green-400">
                  Connected
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {configured && connectedLabel ? connectedLabel : description}
            </p>
          </div>
        </div>
        {configured && (
          <button
            onClick={onDisconnect}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            Disconnect
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

// ---- Icons ----

function SlackIcon() {
  return (
    <svg className="h-6 w-6 text-purple-600 dark:text-purple-400" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  )
}

function NotionIcon() {
  return (
    <svg className="h-6 w-6 text-gray-900 dark:text-white" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L18.09 2.31c-.466-.373-.746-.56-1.493-.56L3.46 2.483c-.746.046-1.026.466-.7.886l1.699.84zm.793 1.886v13.869c0 .746.373 1.026 1.166.98l14.475-.84c.793-.046.887-.513.887-1.073V5.233c0-.56-.187-.84-.7-.793l-15.128.84c-.56.047-.7.327-.7.814zm14.29.467c.093.42 0 .84-.42.886l-.7.14v10.264c-.607.327-1.167.513-1.633.513-.746 0-.933-.233-1.493-.933l-4.572-7.177v6.943l1.447.327s0 .84-1.166.84l-3.22.187c-.093-.187 0-.653.327-.733l.84-.213V8.24l-1.167-.094c-.093-.42.14-1.026.793-1.073l3.453-.233 4.759 7.27V8.007l-1.213-.14c-.094-.514.28-.887.747-.933l3.172-.187z"/>
    </svg>
  )
}

function ObsidianIcon() {
  return (
    <svg className="h-6 w-6 text-violet-600 dark:text-violet-400" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18L19.82 7.6 12 12 4.18 7.6 12 4.18zM4 9.28l7 3.5v7.94l-7-3.5V9.28zm9 11.44v-7.94l7-3.5v7.94l-7 3.5z"/>
    </svg>
  )
}
