import { memo, useEffect, useMemo } from 'react'
import { useRAGStatusStore } from '../stores/rag-status-store'

/** Health check interval: 30 seconds */
const POLL_INTERVAL = 30_000

export const RAGStatusBar = memo(function RAGStatusBar() {
  const httpOnline = useRAGStatusStore((s) => s.httpOnline)
  const wissenOnline = useRAGStatusStore((s) => s.wissenOnline)
  const collectionCount = useRAGStatusStore((s) => s.collectionCount)
  const contextInjectionEnabled = useRAGStatusStore((s) => s.contextInjectionEnabled)
  const checkHealth = useRAGStatusStore((s) => s.checkHealth)

  // Initial check + polling
  useEffect(() => {
    checkHealth()
    const id = setInterval(checkHealth, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [checkHealth])

  const statusInfo = useMemo(() => {
    // Still loading
    if (httpOnline === null && wissenOnline === null) return null

    const anyOnline = httpOnline || wissenOnline

    if (!contextInjectionEnabled) {
      return {
        dot: 'bg-gray-400',
        text: 'Knowledge Base: disabled',
        color: 'text-gray-500 dark:text-gray-500'
      }
    }

    if (anyOnline) {
      const sources: string[] = []
      if (httpOnline) sources.push('RAG Server')
      if (wissenOnline) sources.push('Wissen')
      const colText = collectionCount > 0 ? ` · ${collectionCount} collection${collectionCount !== 1 ? 's' : ''}` : ''
      return {
        dot: 'bg-green-500',
        text: `Knowledge Base: ${sources.join(' + ')}${colText}`,
        color: 'text-green-600 dark:text-green-400'
      }
    }

    return {
      dot: 'bg-red-500',
      text: 'Knowledge Base: offline',
      color: 'text-red-500 dark:text-red-400'
    }
  }, [httpOnline, wissenOnline, collectionCount, contextInjectionEnabled])

  if (!statusInfo) return null

  return (
    <div className="flex items-center gap-2 border-t border-gray-200 bg-gray-50 px-4 py-1 dark:border-gray-700 dark:bg-gray-800/50">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusInfo.dot}`} />
      <span className={`text-[11px] font-medium ${statusInfo.color}`}>
        {statusInfo.text}
      </span>
    </div>
  )
})
