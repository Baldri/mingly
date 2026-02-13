import { useState, useEffect } from 'react'
import { ArrowLeft, Check, AlertCircle, Monitor, Server, Wifi, Info } from 'lucide-react'
import { useSettingsStore } from '../stores/settings-store'
import { useTranslation } from '../utils/i18n'
import { PrivacySettingsTab } from './PrivacySettingsTab'
import { NetworkAIServersTab } from './NetworkAIServersTab'
import { FileAccessTab } from './FileAccessTab'
import { RAGSettingsTab } from './RAGSettingsTab'
import { AnalyticsTab } from './AnalyticsTab'
import { MCPServersTab } from './MCPServersTab'
import { IntegrationsTab } from './IntegrationsTab'
import { BudgetTab } from './BudgetTab'

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
  { id: 'openai', name: 'OpenAI (ChatGPT)', placeholder: 'sk-...' },
  { id: 'google', name: 'Google (Gemini)', placeholder: 'AIza...' }
]

type SettingsTab = 'general' | 'network' | 'files' | 'privacy' | 'rag' | 'analytics' | 'mcp' | 'integrations' | 'budget'

const TABS: Array<{ id: SettingsTab; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: '\u2699\uFE0F' },
  { id: 'network', label: 'Network AI', icon: '\uD83C\uDF10' },
  { id: 'files', label: 'File Access', icon: '\uD83D\uDCC1' },
  { id: 'rag', label: 'Knowledge', icon: '\uD83E\uDDE0' },
  { id: 'mcp', label: 'MCP Tools', icon: '\uD83D\uDD27' },
  { id: 'analytics', label: 'Analytics', icon: '\uD83D\uDCCA' },
  { id: 'integrations', label: 'Integrations', icon: '\uD83D\uDD17' },
  { id: 'budget', label: 'Budget', icon: '\uD83D\uDCB0' },
  { id: 'privacy', label: 'Privacy', icon: '\uD83D\uDD12' }
]

interface Props {
  onBack: () => void
}

export function SettingsPage({ onBack }: Props) {
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

  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const { t } = useTranslation()

  useEffect(() => {
    loadSettings()
    checkAPIKeys()
  }, [loadSettings, checkAPIKeys])

  const handleSaveAPIKey = async (provider: string) => {
    const key = apiKeys[provider]
    if (!key) return

    setValidating({ ...validating, [provider]: true })

    const saveSuccess = await saveAPIKey(provider, key)

    if (saveSuccess) {
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
    await checkAPIKeys()

    setTimeout(() => {
      setValidationStatus({ ...validationStatus, [provider]: null })
    }, 5000)
  }

  if (!settings) return null

  return (
    <div className="flex h-screen bg-white dark:bg-gray-900">
      {/* Left Sidebar */}
      <div className="w-56 border-r border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex flex-col">
        <div className="p-4 border-b border-gray-300 dark:border-gray-700">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <ArrowLeft size={16} />
            Back to Chat
          </button>
          <h2 className="text-xl font-bold mt-3">Settings</h2>
        </div>

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                activeTab === tab.id
                  ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl">
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

              {/* Deployment Mode Section */}
              <DeploymentModeSection
                t={t}
                currentMode={settings.deploymentMode || 'standalone'}
                onModeChange={(mode) => updateSettings({ deploymentMode: mode })}
              />
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
        </div>
      </div>
    </div>
  )
}

// ── Deployment Mode Section ─────────────────────────────────────

const DEPLOYMENT_MODES = [
  { id: 'standalone' as const, icon: Monitor, labelKey: 'settings.deployment.standalone' },
  { id: 'server' as const, icon: Server, labelKey: 'settings.deployment.server' },
  { id: 'hybrid' as const, icon: Wifi, labelKey: 'settings.deployment.hybrid' },
] as const

function DeploymentModeSection({
  t,
  currentMode,
  onModeChange,
}: {
  t: (key: string) => string
  currentMode: string
  onModeChange: (mode: 'standalone' | 'server' | 'hybrid') => void
}) {
  const [changed, setChanged] = useState(false)

  const handleChange = (mode: 'standalone' | 'server' | 'hybrid') => {
    if (mode !== currentMode) {
      onModeChange(mode)
      setChanged(true)
    }
  }

  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">{t('settings.deployment.title')}</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {t('settings.deployment.description')}
      </p>

      <div className="space-y-2">
        {DEPLOYMENT_MODES.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            onClick={() => handleChange(id)}
            className={`flex w-full items-center gap-3 rounded-lg border-2 px-4 py-3 text-left text-sm transition-all ${
              currentMode === id
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <Icon className={`h-5 w-5 flex-shrink-0 ${currentMode === id ? 'text-blue-500' : 'text-gray-400'}`} />
            <span className={currentMode === id ? 'font-medium text-blue-700 dark:text-blue-300' : ''}>
              {t(labelKey)}
            </span>
          </button>
        ))}
      </div>

      {changed && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Info className="h-4 w-4 flex-shrink-0" />
          {t('settings.deployment.restart')}
        </div>
      )}
    </div>
  )
}
