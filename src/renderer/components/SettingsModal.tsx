// DEPRECATED: Replaced by SettingsPage.tsx. Kept for rollback if needed.
import React, { useState, useEffect } from 'react'
import { X, Check, AlertCircle } from 'lucide-react'
import { useSettingsStore } from '../stores/settings-store'
import { PrivacySettingsTab } from './PrivacySettingsTab'
import { NetworkAIServersTab } from './NetworkAIServersTab'
import { FileAccessTab } from './FileAccessTab'
import { RAGSettingsTab } from './RAGSettingsTab'
import { AnalyticsTab } from './AnalyticsTab'
import { MCPServersTab } from './MCPServersTab'
import { IntegrationsTab } from './IntegrationsTab'
import { BudgetTab } from './BudgetTab'

interface Props {
  isOpen: boolean
  onClose: () => void
}

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    placeholder: 'sk-ant-...'
  },
  { id: 'openai', name: 'OpenAI (ChatGPT)', placeholder: 'sk-...' },
  { id: 'google', name: 'Google (Gemini)', placeholder: 'AIza...' }
]

export function SettingsModal({ isOpen, onClose }: Props) {
  const {
    settings,
    apiKeysConfigured,
    loadSettings,
    updateSettings,
    checkAPIKeys,
    saveAPIKey,
    validateAPIKey
  } = useSettingsStore()

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({
    anthropic: '',
    openai: '',
    google: ''
  })

  const [validating, setValidating] = useState<Record<string, boolean>>({})
  const [validationStatus, setValidationStatus] = useState<
    Record<string, boolean | null>
  >({})

  const [activeTab, setActiveTab] = useState<'general' | 'network' | 'files' | 'privacy' | 'rag' | 'analytics' | 'mcp' | 'integrations' | 'budget'>('general')

  useEffect(() => {
    if (isOpen) {
      loadSettings()
      checkAPIKeys()
    }
  }, [isOpen, loadSettings, checkAPIKeys])

  const handleSaveAPIKey = async (provider: string) => {
    const key = apiKeys[provider]
    if (!key) return

    setValidating({ ...validating, [provider]: true })

    // Save FIRST, then validate
    const saveSuccess = await saveAPIKey(provider, key)

    if (saveSuccess) {
      // Now validate the saved key
      const isValid = await validateAPIKey(provider)

      if (isValid) {
        setApiKeys({ ...apiKeys, [provider]: '' })
        setValidationStatus({ ...validationStatus, [provider]: true })
      } else {
        setValidationStatus({ ...validationStatus, [provider]: false })
      }
    } else {
      setValidationStatus({ ...validationStatus, [provider]: false })
    }

    setValidating({ ...validating, [provider]: false })

    // Refresh API keys status to update "Configured" badge
    await checkAPIKeys()

    // Clear validation status after 5 seconds (increased from 3)
    setTimeout(() => {
      setValidationStatus({ ...validationStatus, [provider]: null })
    }, 5000)
  }

  if (!isOpen || !settings) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-[700px] max-w-[90vw] max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex space-x-4 overflow-x-auto scrollbar-hide">
            <button
              onClick={() => setActiveTab('general')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'general'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              General
            </button>
            <button
              onClick={() => setActiveTab('network')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'network'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              🌐 Network AI
            </button>
            <button
              onClick={() => setActiveTab('files')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'files'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              📁 File Access
            </button>
            <button
              onClick={() => setActiveTab('rag')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'rag'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              🧠 Knowledge
            </button>
            <button
              onClick={() => setActiveTab('mcp')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'mcp'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              🔧 MCP Tools
            </button>
            <button
              onClick={() => setActiveTab('analytics')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'analytics'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              📊 Analytics
            </button>
            <button
              onClick={() => setActiveTab('integrations')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'integrations'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              🔗 Integrations
            </button>
            <button
              onClick={() => setActiveTab('budget')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'budget'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              💰 Budget
            </button>
            <button
              onClick={() => setActiveTab('privacy')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'privacy'
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              🔒 Privacy
            </button>
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === 'general' ? (
          <div className="space-y-6">
            {/* API Keys Section */}
            <div>
            <h3 className="text-lg font-semibold mb-3">API Keys</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Your API keys are stored securely in your system keychain.
            </p>

            <div className="space-y-4">
              {PROVIDERS.map((provider) => (
                <div key={provider.id} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium">
                      {provider.name}
                    </label>
                    {apiKeysConfigured[provider.id] && (
                      <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                        <Check size={14} />
                        Configured
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={apiKeys[provider.id]}
                      onChange={(e) =>
                        setApiKeys({ ...apiKeys, [provider.id]: e.target.value })
                      }
                      placeholder={provider.placeholder}
                      className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => handleSaveAPIKey(provider.id)}
                      disabled={
                        !apiKeys[provider.id] || validating[provider.id]
                      }
                      className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {validating[provider.id] ? 'Validating...' : 'Save'}
                    </button>
                  </div>
                  {validationStatus[provider.id] === false && (
                    <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                      <AlertCircle size={14} />
                      Invalid API key
                    </p>
                  )}
                  {validationStatus[provider.id] === true && (
                    <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                      <Check size={14} />
                      API key saved successfully
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Preferences Section */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Preferences</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Default Provider
                </label>
                <select
                  value={settings.defaultProvider}
                  onChange={(e) =>
                    updateSettings({ defaultProvider: e.target.value as any })
                  }
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="anthropic">Claude (Anthropic)</option>
                  <option value="openai">ChatGPT (OpenAI)</option>
                  <option value="google">Gemini (Google)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Theme</label>
                <select
                  value={settings.theme}
                  onChange={(e) =>
                    updateSettings({ theme: e.target.value as 'light' | 'dark' })
                  }
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>
            </div>
          </div>
          </div>
        ) : activeTab === 'network' ? (
          <NetworkAIServersTab />
        ) : activeTab === 'files' ? (
          <FileAccessTab />
        ) : activeTab === 'rag' ? (
          <RAGSettingsTab />
        ) : activeTab === 'mcp' ? (
          <MCPServersTab />
        ) : activeTab === 'analytics' ? (
          <AnalyticsTab />
        ) : activeTab === 'integrations' ? (
          <IntegrationsTab />
        ) : activeTab === 'budget' ? (
          <BudgetTab />
        ) : (
          <PrivacySettingsTab />
        )}

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
