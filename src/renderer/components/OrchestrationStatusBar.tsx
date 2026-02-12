import { memo, useMemo } from 'react'
import { useOrchestratorStore } from '../stores/orchestrator-store'

export const OrchestrationStatusBar = memo(function OrchestrationStatusBar() {
  const enabled = useOrchestratorStore((state) => state.enabled)
  const isAnalyzing = useOrchestratorStore((state) => state.isAnalyzing)
  const isExecuting = useOrchestratorStore((state) => state.isExecuting)
  const lastResult = useOrchestratorStore((state) => state.lastResult)
  const activeProposal = useOrchestratorStore((state) => state.activeProposal)

  const statusInfo = useMemo(() => {
    if (!enabled) return null
    if (isExecuting) return { text: 'Delegating to specialized models...', color: 'text-indigo-600 dark:text-indigo-400', pulse: true }
    if (isAnalyzing) return { text: 'Analyzing for delegation...', color: 'text-blue-600 dark:text-blue-400', pulse: true }
    if (activeProposal) return { text: 'Delegation suggestion available', color: 'text-yellow-600 dark:text-yellow-400', pulse: false }
    if (lastResult) {
      const cost = lastResult.totalCost > 0 ? ` ($${lastResult.totalCost.toFixed(4)})` : ''
      const latency = lastResult.totalLatencyMs > 0 ? ` in ${(lastResult.totalLatencyMs / 1000).toFixed(1)}s` : ''
      return {
        text: `Delegation complete: ${lastResult.subTaskResults.length} sub-task(s)${latency}${cost}`,
        color: 'text-green-600 dark:text-green-400',
        pulse: false
      }
    }
    return null
  }, [enabled, isAnalyzing, isExecuting, activeProposal, lastResult])

  if (!statusInfo) return null

  return (
    <div className="flex items-center gap-2 border-t border-gray-200 bg-gray-50 px-4 py-1.5 dark:border-gray-700 dark:bg-gray-800/50">
      {statusInfo.pulse && (
        <div className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
        </div>
      )}
      <span className={`text-xs font-medium ${statusInfo.color}`}>
        {statusInfo.text}
      </span>
    </div>
  )
})
