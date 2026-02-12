import { memo, useState, useCallback } from 'react'
import type { DelegationProposal } from '../../main/routing/hybrid-orchestrator'

interface DelegationProposalDialogProps {
  isOpen: boolean
  proposal: DelegationProposal
  isExecuting: boolean
  onApprove: (proposalId: string) => void
  onDeny: (proposalId: string) => void
  onDismiss: () => void
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  openai: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  google: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  ollama: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
}

const CATEGORY_LABELS: Record<string, string> = {
  code: 'Code',
  creative: 'Creative',
  analysis: 'Analysis',
  translation: 'Translation',
  general: 'General',
  math: 'Math',
  research: 'Research'
}

export const DelegationProposalDialog = memo(function DelegationProposalDialog({
  isOpen,
  proposal,
  isExecuting,
  onApprove,
  onDeny,
  onDismiss
}: DelegationProposalDialogProps) {
  const [alwaysApprove, setAlwaysApprove] = useState(false)

  const handleApprove = useCallback(() => {
    onApprove(proposal.id)
  }, [onApprove, proposal.id])

  const handleDeny = useCallback(() => {
    onDeny(proposal.id)
  }, [onDeny, proposal.id])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl dark:bg-gray-800">
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900/30">
            <svg
              className="h-6 w-6 text-indigo-600 dark:text-indigo-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Smart Delegation Suggestion
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              A specialized model could handle parts of this request better
            </p>
          </div>
        </div>

        {/* Analysis */}
        <div className="mb-4 rounded-lg bg-gray-50 p-4 dark:bg-gray-900/50">
          <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">
            {proposal.analysis}
          </p>
        </div>

        {/* Sub-task cards */}
        <div className="mb-4 max-h-64 space-y-3 overflow-y-auto">
          {proposal.subTasks.map((subTask) => (
            <div
              key={subTask.id}
              className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {subTask.description}
                  </p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {subTask.reasoning}
                  </p>
                </div>

                {/* Provider badge */}
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    PROVIDER_COLORS[subTask.suggestedProvider] ||
                    'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                  }`}
                >
                  {subTask.suggestedProvider}/{subTask.suggestedModel.split('/').pop()}
                </span>
              </div>

              <div className="mt-2 flex items-center gap-3">
                {/* Category tag */}
                <span className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                  {CATEGORY_LABELS[subTask.category] || subTask.category}
                </span>

                {/* Confidence bar */}
                <div className="flex flex-1 items-center gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">Confidence</span>
                  <div className="h-1.5 flex-1 rounded-full bg-gray-200 dark:bg-gray-700">
                    <div
                      className={`h-1.5 rounded-full ${
                        subTask.confidence >= 0.9
                          ? 'bg-green-500'
                          : subTask.confidence >= 0.75
                            ? 'bg-blue-500'
                            : 'bg-yellow-500'
                      }`}
                      style={{ width: `${Math.round(subTask.confidence * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                    {Math.round(subTask.confidence * 100)}%
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Estimated cost */}
        {proposal.estimatedCost > 0 && (
          <div className="mb-4 flex items-center justify-between rounded-lg bg-blue-50 px-4 py-2 dark:bg-blue-900/20">
            <span className="text-sm text-blue-700 dark:text-blue-300">Estimated cost</span>
            <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">
              ${proposal.estimatedCost.toFixed(4)}
            </span>
          </div>
        )}

        {/* Always approve checkbox */}
        <div className="mb-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={alwaysApprove}
              onChange={(e) => setAlwaysApprove(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-2 focus:ring-indigo-500"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Always approve for similar requests
            </span>
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onDismiss}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            disabled={isExecuting}
          >
            Dismiss
          </button>
          <button
            onClick={handleDeny}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            disabled={isExecuting}
          >
            Deny
          </button>
          <button
            onClick={handleApprove}
            disabled={isExecuting}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 dark:bg-indigo-700 dark:hover:bg-indigo-600"
          >
            {isExecuting ? (
              <>
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Executing...
              </>
            ) : (
              'Approve & Execute'
            )}
          </button>
        </div>
      </div>
    </div>
  )
})
