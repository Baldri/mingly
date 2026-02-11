import React, { useState, useEffect, useMemo, memo } from 'react'

interface UsageSummary {
  totalMessages: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalCost: number
  byProvider: Record<string, { messages: number; tokens: number; cost: number }>
  byModel: Record<string, { messages: number; tokens: number; cost: number }>
  avgLatencyMs: number
  ragHitRate: number
  errorRate: number
}

interface DailyUsage {
  date: string
  messages: number
  tokens: number
  cost: number
}

type TimeRange = '7d' | '30d' | 'all'

export const AnalyticsTab = memo(function AnalyticsTab() {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [dailyUsage, setDailyUsage] = useState<DailyUsage[]>([])
  const [timeRange, setTimeRange] = useState<TimeRange>('30d')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [timeRange])

  const loadData = async () => {
    try {
      setLoading(true)

      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 365
      const fromMs = timeRange === 'all' ? undefined : Date.now() - days * 24 * 60 * 60 * 1000

      const [summaryResult, dailyResult] = await Promise.all([
        window.electronAPI.tracking.getSummary(fromMs),
        window.electronAPI.tracking.getDailyUsage(days)
      ])

      if (summaryResult.success) {
        setSummary(summaryResult.summary)
      }
      if (dailyResult.success) {
        setDailyUsage(dailyResult.dailyUsage)
      }
    } catch (error) {
      console.error('Failed to load analytics:', error)
    } finally {
      setLoading(false)
    }
  }

  const formatCost = (cost: number): string => {
    if (cost < 0.01) return cost > 0 ? '<$0.01' : '$0.00'
    return `$${cost.toFixed(2)}`
  }

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
    return String(tokens)
  }

  const formatLatency = (ms: number): string => {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.round(ms)}ms`
  }

  const getProviderColor = (provider: string): string => {
    switch (provider) {
      case 'anthropic': return 'bg-orange-500'
      case 'openai': return 'bg-green-500'
      case 'google': return 'bg-blue-500'
      case 'local': case 'ollama': return 'bg-purple-500'
      default: return 'bg-gray-500'
    }
  }

  const getProviderLabel = (provider: string): string => {
    switch (provider) {
      case 'anthropic': return 'Claude'
      case 'openai': return 'GPT'
      case 'google': return 'Gemini'
      case 'local': case 'ollama': return 'Local'
      default: return provider
    }
  }

  // Simple bar chart using CSS
  const maxDailyTokens = Math.max(...dailyUsage.map((d) => d.tokens), 1)

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
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Usage Analytics
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Track your AI usage, costs, and performance
          </p>
        </div>
        {/* Time Range Selector */}
        <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
          {(['7d', '30d', 'all'] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                timeRange === range
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {range === '7d' ? '7 Days' : range === '30d' ? '30 Days' : 'All Time'}
            </button>
          ))}
        </div>
      </div>

      {!summary || summary.totalMessages === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
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
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            No usage data yet
          </p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Start chatting to see your analytics here
          </p>
        </div>
      ) : (
        <>
          {/* Key Metrics */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {summary.totalMessages}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Messages</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                {formatTokens(summary.totalTokens)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Total Tokens</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                {formatCost(summary.totalCost)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Total Cost</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                {formatLatency(summary.avgLatencyMs)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Avg Latency</div>
            </div>
          </div>

          {/* Secondary Metrics */}
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="text-sm font-medium text-gray-600 dark:text-gray-400">Input Tokens</div>
              <div className="text-lg font-bold text-gray-900 dark:text-white">
                {formatTokens(summary.totalInputTokens)}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="text-sm font-medium text-gray-600 dark:text-gray-400">Output Tokens</div>
              <div className="text-lg font-bold text-gray-900 dark:text-white">
                {formatTokens(summary.totalOutputTokens)}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="text-sm font-medium text-gray-600 dark:text-gray-400">RAG Hit Rate</div>
              <div className="text-lg font-bold text-gray-900 dark:text-white">
                {(summary.ragHitRate * 100).toFixed(0)}%
              </div>
            </div>
          </div>

          {/* Provider Breakdown */}
          {Object.keys(summary.byProvider).length > 0 && (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
                By Provider
              </h4>
              <div className="space-y-2">
                {Object.entries(summary.byProvider)
                  .sort((a, b) => b[1].messages - a[1].messages)
                  .map(([provider, data]) => {
                    const pct = (data.messages / summary.totalMessages) * 100
                    return (
                      <div key={provider} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <div className={`h-3 w-3 rounded-full ${getProviderColor(provider)}`} />
                            <span className="text-sm font-medium text-gray-900 dark:text-white">
                              {getProviderLabel(provider)}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                            <span>{data.messages} msgs</span>
                            <span>{formatTokens(data.tokens)} tokens</span>
                            <span>{formatCost(data.cost)}</span>
                          </div>
                        </div>
                        <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                          <div
                            className={`h-2 rounded-full ${getProviderColor(provider)}`}
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          {/* Daily Usage Chart (simple CSS bars) */}
          {dailyUsage.length > 0 && (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
                Daily Token Usage
              </h4>
              <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <div className="flex items-end gap-1" style={{ height: '120px' }}>
                  {dailyUsage.slice(-14).map((day) => {
                    const height = maxDailyTokens > 0 ? (day.tokens / maxDailyTokens) * 100 : 0
                    return (
                      <div
                        key={day.date}
                        className="flex-1 group relative"
                        style={{ height: '100%' }}
                      >
                        <div
                          className="absolute bottom-0 w-full rounded-t bg-blue-500 dark:bg-blue-400 transition-all hover:bg-blue-600 dark:hover:bg-blue-300"
                          style={{ height: `${Math.max(height, 2)}%` }}
                        />
                        <div className="absolute bottom-full mb-1 hidden group-hover:block bg-gray-800 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10 left-1/2 -translate-x-1/2">
                          {day.date}: {formatTokens(day.tokens)} tokens, {formatCost(day.cost)}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between mt-2 text-xs text-gray-400 dark:text-gray-500">
                  <span>{dailyUsage.length > 0 ? dailyUsage[Math.max(dailyUsage.length - 14, 0)].date : ''}</span>
                  <span>{dailyUsage.length > 0 ? dailyUsage[dailyUsage.length - 1].date : ''}</span>
                </div>
              </div>
            </div>
          )}

          {/* Error Rate */}
          {summary.errorRate > 0 && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-900/20">
              <div className="flex items-center gap-2 text-sm text-yellow-800 dark:text-yellow-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                Error rate: {(summary.errorRate * 100).toFixed(1)}% of requests failed
              </div>
            </div>
          )}
        </>
      )}

      {/* Info */}
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
              About Cost Estimates
            </h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              Token counts are estimated from message length (~4 characters per token).
              Costs are calculated using published API pricing. Local models (Ollama) are free.
              All data is stored locally and never leaves your device.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
})
