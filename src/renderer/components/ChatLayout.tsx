import { lazy, Suspense, useState } from 'react'
import { Columns2 } from 'lucide-react'
import { ConversationSidebar } from './ConversationSidebar'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { OrchestrationStatusBar } from './OrchestrationStatusBar'
import { RAGStatusBar } from './RAGStatusBar'
import { RoutingModeToggle } from './RoutingModeToggle'
import { useChatStore } from '../stores/chat-store'
import { useOrchestratorStore } from '../stores/orchestrator-store'

const ComparisonView = lazy(() => import('./ComparisonView').then(m => ({ default: m.ComparisonView })))

/** Lazy-loaded dialogs — only fetched when triggered */
const SensitiveDataConsentDialog = lazy(() => import('./SensitiveDataConsentDialog').then(m => ({ default: m.SensitiveDataConsentDialog })))
const DelegationProposalDialog = lazy(() => import('./DelegationProposalDialog').then(m => ({ default: m.DelegationProposalDialog })))
const UpgradeDialog = lazy(() => import('./UpgradeDialog'))
const LicenseKeyDialog = lazy(() => import('./LicenseKeyDialog'))

export function ChatLayout() {
  const sensitiveDataConsent = useChatStore((state) => state.sensitiveDataConsent)
  const hideSensitiveDataConsent = useChatStore((state) => state.hideSensitiveDataConsent)
  const handleConsentGranted = useChatStore((state) => state.handleConsentGranted)
  const handleUseLocalLLM = useChatStore((state) => state.handleUseLocalLLM)
  const error = useChatStore((state) => state.error)
  const setError = useChatStore((state) => state.setError)
  const currentConversation = useChatStore((state) => state.currentConversation)

  const activeProposal = useOrchestratorStore((state) => state.activeProposal)
  const isExecuting = useOrchestratorStore((state) => state.isExecuting)
  const approveProposal = useOrchestratorStore((state) => state.approveProposal)
  const denyProposal = useOrchestratorStore((state) => state.denyProposal)
  const dismissProposal = useOrchestratorStore((state) => state.dismissProposal)

  const [comparisonMode, setComparisonMode] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-white dark:bg-gray-900">
      <ConversationSidebar />

      <div className="flex-1 flex flex-col">
        {/* Error Banner — live region so screen readers announce errors */}
        <div role="alert" aria-live="assertive" aria-atomic="true">
          {error && (
            <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 dark:border-red-900 dark:bg-red-900/20">
              <svg className="h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="flex-1 text-sm text-red-700 dark:text-red-300">{error}</span>
              <button
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="flex-shrink-0 rounded p-0.5 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/40"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Chat Header — model info + routing toggle + comparison toggle */}
        <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-200 dark:border-gray-700">
          {/* Active model indicator */}
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            {currentConversation ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                <span>{currentConversation.provider}</span>
                <span className="text-gray-300 dark:text-gray-600">/</span>
                <span className="font-medium text-gray-700 dark:text-gray-300">{currentConversation.model}</span>
              </>
            ) : (
              <span className="text-gray-400">No conversation selected</span>
            )}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setComparisonMode(!comparisonMode)}
              title={comparisonMode ? 'Exit comparison mode' : 'Compare models side-by-side'}
              className={`p-1.5 rounded-md transition-colors ${
                comparisonMode
                  ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300'
              }`}
            >
              <Columns2 size={16} />
            </button>
            <RoutingModeToggle />
          </div>
        </div>

        {/* Main content — either comparison view or normal chat */}
        {comparisonMode ? (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400">Loading comparison...</div>}>
            <ComparisonView onClose={() => setComparisonMode(false)} />
          </Suspense>
        ) : (
          <>
            <MessageList />
            <RAGStatusBar />
            <OrchestrationStatusBar />
            <MessageInput />
          </>
        )}
      </div>

      {/* Sensitive Data Consent Dialog — lazy loaded */}
      {sensitiveDataConsent.isOpen && sensitiveDataConsent.request && (
        <Suspense fallback={null}>
          <SensitiveDataConsentDialog
            isOpen={sensitiveDataConsent.isOpen}
            onClose={hideSensitiveDataConsent}
            request={sensitiveDataConsent.request}
            matches={sensitiveDataConsent.matches}
            onSendAnyway={handleConsentGranted}
            onUseLocalLLM={handleUseLocalLLM}
          />
        </Suspense>
      )}

      {/* Delegation Proposal Dialog — lazy loaded */}
      {activeProposal && (
        <Suspense fallback={null}>
          <DelegationProposalDialog
            isOpen={!!activeProposal}
            proposal={activeProposal}
            isExecuting={isExecuting}
            onApprove={approveProposal}
            onDeny={denyProposal}
            onDismiss={dismissProposal}
          />
        </Suspense>
      )}

      {/* Upgrade & License Dialogs — lazy loaded */}
      <Suspense fallback={null}>
        <UpgradeDialog />
        <LicenseKeyDialog />
      </Suspense>
    </div>
  )
}
