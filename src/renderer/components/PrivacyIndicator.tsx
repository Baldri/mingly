/**
 * PrivacyIndicator — Compact badge showing current privacy mode.
 * Displayed in the chat header next to the RAG status bar.
 */

import { memo, useEffect, useMemo } from 'react'
import { usePrivacyStore } from '../stores/privacy-store'
import { useChatStore } from '../stores/chat-store'

const MODE_CONFIG = {
  shield: {
    label: 'Shield',
    dot: 'bg-green-500',
    text: 'text-green-600 dark:text-green-400',
    tooltip: 'PII replaced with fake Swiss data before sending to LLM'
  },
  vault: {
    label: 'Vault',
    dot: 'bg-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
    tooltip: 'PII redacted with [CATEGORY] markers'
  },
  transparent: {
    label: 'Transparent',
    dot: 'bg-yellow-500',
    text: 'text-yellow-600 dark:text-yellow-400',
    tooltip: 'PII detected but not modified'
  },
  local_only: {
    label: 'Local Only',
    dot: 'bg-purple-500',
    text: 'text-purple-600 dark:text-purple-400',
    tooltip: 'Messages routed only to local LLMs'
  }
} as const

export const PrivacyIndicator = memo(function PrivacyIndicator() {
  const mode = usePrivacyStore((s) => s.mode)
  const enabled = usePrivacyStore((s) => s.enabled)
  const sessionAnonymizedCount = usePrivacyStore((s) => s.sessionAnonymizedCount)
  const loadMode = usePrivacyStore((s) => s.loadMode)
  const conversationId = useChatStore((s) => s.currentConversation?.id)

  useEffect(() => {
    if (conversationId) {
      loadMode(conversationId)
    }
  }, [conversationId, loadMode])

  const config = useMemo(() => MODE_CONFIG[mode], [mode])

  if (!enabled) return null

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 dark:border-gray-700 dark:bg-gray-800/50"
      title={config.tooltip}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${config.dot}`} />
      <span className={`text-[11px] font-medium ${config.text}`}>
        {config.label}
      </span>
      {sessionAnonymizedCount > 0 && (
        <span className="text-[10px] text-gray-400 dark:text-gray-500">
          ({sessionAnonymizedCount})
        </span>
      )}
    </div>
  )
})
