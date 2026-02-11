import React, { useState, useEffect, memo } from 'react'

interface ProviderBudget {
  monthlyLimit: number
  warningThreshold: number
  autoFallback: boolean
  fallbackProvider?: string
}

interface BudgetConfig {
  enabled: boolean
  globalMonthlyLimit: number
  providers: Record<string, ProviderBudget>
}

interface BudgetStatusData {
  config: BudgetConfig
  currentMonth: {
    totalSpent: number
    byProvider: Record<string, { spent: number; limit: number; percentage: number; warning: boolean; exceeded: boolean }>
    globalPercentage: number
    globalWarning: boolean
    globalExceeded: boolean
  }
}

export const BudgetTab = memo(function BudgetTab() {
  const [status, setStatus] = useState<BudgetStatusData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [globalLimit, setGlobalLimit] = useState(50)

  useEffect(() => {
    loadStatus()
  }, [])

  const loadStatus = async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.budget.getStatus()
      if (result.success) {
        setStatus(result)
        setEnabled(result.config.enabled)
        setGlobalLimit(result.config.globalMonthlyLimit)
      }
    } catch (error) {
      console.error('Failed to load budget status:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = async () => {
    setSaving(true)
    const newEnabled = !enabled
    setEnabled(newEnabled)
    await window.electronAPI.budget.updateConfig({ enabled: newEnabled })
    await loadStatus()
    setSaving(false)
  }

  const handleSaveLimit = async () => {
    setSaving(true)
    await window.electronAPI.budget.updateConfig({ globalMonthlyLimit: globalLimit })
    await loadStatus()
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
      </div>
    )
  }

  const currentMonth = status?.currentMonth

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Budget Management</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Set monthly spending limits and track costs
        </p>
      </div>

      {/* Enable/Disable Toggle */}
      <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div>
          <h4 className="font-medium text-gray-900 dark:text-white">Enable Budget Limits</h4>
          <p className="text-sm text-gray-500 dark:text-gray-400">Get warnings when approaching spending limits</p>
        </div>
        <button
          onClick={handleToggle}
          disabled={saving}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>

      {/* Global Limit */}
      {enabled && (
        <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <h4 className="font-medium text-gray-900 dark:text-white mb-3">Monthly Global Limit</h4>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 dark:text-gray-400">$</span>
            <input
              type="number"
              min={0}
              step={5}
              value={globalLimit}
              onChange={(e) => setGlobalLimit(Number(e.target.value))}
              className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
            />
            <span className="text-sm text-gray-500 dark:text-gray-400">/ month</span>
            <button
              onClick={handleSaveLimit}
              disabled={saving}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Save
            </button>
          </div>

          {/* Current Month Progress */}
          {currentMonth && (
            <div className="mt-4">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600 dark:text-gray-400">
                  ${currentMonth.totalSpent.toFixed(2)} of ${globalLimit.toFixed(2)}
                </span>
                <span className={`font-medium ${
                  currentMonth.globalExceeded ? 'text-red-600' : currentMonth.globalWarning ? 'text-yellow-600' : 'text-green-600'
                }`}>
                  {(currentMonth.globalPercentage * 100).toFixed(0)}%
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className={`h-2 rounded-full transition-all ${
                    currentMonth.globalExceeded ? 'bg-red-500' : currentMonth.globalWarning ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(currentMonth.globalPercentage * 100, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Per-Provider Breakdown */}
      {enabled && currentMonth && Object.keys(currentMonth.byProvider).length > 0 && (
        <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <h4 className="font-medium text-gray-900 dark:text-white mb-3">Provider Spending</h4>
          <div className="space-y-3">
            {Object.entries(currentMonth.byProvider).map(([provider, data]) => (
              <div key={provider}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="font-medium text-gray-900 dark:text-white capitalize">{provider}</span>
                  <span className={`text-sm ${data.exceeded ? 'text-red-600' : data.warning ? 'text-yellow-600' : 'text-gray-500'}`}>
                    ${data.spent.toFixed(4)}{data.limit > 0 ? ` / $${data.limit.toFixed(2)}` : ''}
                  </span>
                </div>
                {data.limit > 0 && (
                  <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                    <div
                      className={`h-1.5 rounded-full ${
                        data.exceeded ? 'bg-red-500' : data.warning ? 'bg-yellow-500' : 'bg-blue-500'
                      }`}
                      style={{ width: `${Math.min(data.percentage * 100, 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Info */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-900/20">
        <div className="flex gap-3">
          <svg className="h-5 w-5 flex-shrink-0 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <h5 className="text-sm font-semibold text-blue-900 dark:text-blue-300">Cost Estimation</h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              Costs are estimated based on token counts. Actual charges from providers may vary slightly.
              Budget resets at the start of each calendar month.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
})
