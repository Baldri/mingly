import { useEffect, useState } from 'react'
import { useOrchestratorStore } from '../stores/orchestrator-store'

const CATEGORIES = ['code', 'creative', 'analysis', 'general', 'conversation'] as const

const CATEGORY_LABELS: Record<string, string> = {
  code: 'Code',
  creative: 'Creative',
  analysis: 'Analysis',
  general: 'General',
  conversation: 'Conversation',
}

const PROVIDER_OPTIONS = [
  { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { provider: 'anthropic', model: 'claude-3-opus', label: 'Claude 3 Opus' },
  { provider: 'openai', model: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  { provider: 'openai', model: 'gpt-4', label: 'GPT-4' },
  { provider: 'google', model: 'gemini-ultra', label: 'Gemini Ultra' },
  { provider: 'google', model: 'gemini-pro', label: 'Gemini Pro' },
]

export function OrchestratorSettingsTab() {
  const { config, loadConfig, updateConfig } = useOrchestratorStore()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadConfig().finally(() => setLoading(false))
  }, [loadConfig])

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
      </div>
    )
  }

  const handleToggle = () => {
    updateConfig({ enabled: !config.enabled })
  }

  const handleThresholdChange = (value: number) => {
    updateConfig({ delegationThreshold: value })
  }

  const handleAutoApproveChange = (value: number) => {
    updateConfig({ autoApproveThreshold: value })
  }

  const handleMaxSubTasksChange = (value: number) => {
    updateConfig({ maxSubTasks: value })
  }

  const handlePreferredModelChange = (category: string, selected: string) => {
    const option = PROVIDER_OPTIONS.find(
      (o) => `${o.provider}:${o.model}` === selected
    )
    if (!option && selected !== '') return

    const updated = { ...config.preferredModels }
    if (selected === '') {
      delete updated[category as keyof typeof updated]
    } else if (option) {
      updated[category as keyof typeof updated] = {
        provider: option.provider,
        model: option.model,
      }
    }
    updateConfig({ preferredModels: updated })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Orchestrator
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Intelligent task delegation across multiple LLMs for optimal results
        </p>
      </div>

      {/* Enable Toggle */}
      <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div>
          <h4 className="text-sm font-medium text-gray-900 dark:text-white">
            Enable Orchestrator
          </h4>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Analyze messages and suggest delegation to specialized models
          </p>
        </div>
        <button
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            config.enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              config.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Settings (only shown when enabled) */}
      {config.enabled && (
        <>
          {/* Delegation Threshold */}
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white">
                Delegation Threshold
              </h4>
              <span className="text-sm font-mono text-blue-600 dark:text-blue-400">
                {config.delegationThreshold.toFixed(2)}
              </span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Minimum confidence required to suggest delegation (higher = more selective)
            </p>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={config.delegationThreshold}
              onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>Aggressive (0.0)</span>
              <span>Selective (1.0)</span>
            </div>
          </div>

          {/* Auto-Approve Cost Limit */}
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white">
                Auto-Approve Cost Limit
              </h4>
              <span className="text-sm font-mono text-blue-600 dark:text-blue-400">
                {config.autoApproveThreshold === 0
                  ? 'Always ask'
                  : `$${config.autoApproveThreshold.toFixed(2)}`}
              </span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Automatically approve delegations below this cost (0 = always ask for approval)
            </p>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={config.autoApproveThreshold}
              onChange={(e) => handleAutoApproveChange(parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>Always ask</span>
              <span>$1.00</span>
            </div>
          </div>

          {/* Max Sub-Tasks */}
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white">
                Max Sub-Tasks
              </h4>
              <span className="text-sm font-mono text-blue-600 dark:text-blue-400">
                {config.maxSubTasks}
              </span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Maximum number of sub-tasks per delegation
            </p>
            <input
              type="range"
              min="1"
              max="5"
              step="1"
              value={config.maxSubTasks}
              onChange={(e) => handleMaxSubTasksChange(parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>1</span>
              <span>5</span>
            </div>
          </div>

          {/* Preferred Models per Category */}
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">
              Preferred Models per Category
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Override which model handles each request category
            </p>
            <div className="space-y-3">
              {CATEGORIES.map((cat) => {
                const pref = config.preferredModels[cat]
                const currentValue = pref ? `${pref.provider}:${pref.model}` : ''
                return (
                  <div key={cat} className="flex items-center gap-3">
                    <span className="w-28 text-sm text-gray-700 dark:text-gray-300">
                      {CATEGORY_LABELS[cat]}
                    </span>
                    <select
                      value={currentValue}
                      onChange={(e) => handlePreferredModelChange(cat, e.target.value)}
                      className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Auto (best available)</option>
                      {PROVIDER_OPTIONS.map((opt) => (
                        <option
                          key={`${opt.provider}:${opt.model}`}
                          value={`${opt.provider}:${opt.model}`}
                        >
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

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
              How Orchestration Works
            </h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              When enabled, Mingly analyzes your messages and suggests splitting complex
              tasks across specialized models. You always review and approve delegations
              before they execute.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
