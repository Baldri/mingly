import { useState } from 'react'
import type { RiskLevel } from '../../main/security/sensitive-data-detector'
import type { UploadPermissionRequest } from '../../main/security/upload-permission-manager'

interface SensitiveDataConsentDialogProps {
  isOpen: boolean
  onClose: () => void
  request: UploadPermissionRequest
  matches: Array<{
    type: string
    value: string
    riskLevel: RiskLevel
  }>
  onSendAnyway: (rememberChoice: boolean) => void
  onUseLocalLLM: (rememberChoice: boolean) => void
}

export function SensitiveDataConsentDialog({
  isOpen,
  onClose,
  request,
  matches,
  onSendAnyway,
  onUseLocalLLM
}: SensitiveDataConsentDialogProps) {
  const [rememberChoice, setRememberChoice] = useState(false)

  if (!isOpen) return null

  // Group matches by risk level
  const criticalMatches = matches.filter((m) => m.riskLevel === 'critical')
  const highMatches = matches.filter((m) => m.riskLevel === 'high')
  const mediumMatches = matches.filter((m) => m.riskLevel === 'medium')
  const lowMatches = matches.filter((m) => m.riskLevel === 'low')

  const getRiskColor = (riskLevel: RiskLevel): string => {
    switch (riskLevel) {
      case 'critical':
        return 'text-red-600 dark:text-red-400'
      case 'high':
        return 'text-orange-600 dark:text-orange-400'
      case 'medium':
        return 'text-yellow-600 dark:text-yellow-400'
      case 'low':
        return 'text-blue-600 dark:text-blue-400'
    }
  }

  const getRiskBgColor = (riskLevel: RiskLevel): string => {
    switch (riskLevel) {
      case 'critical':
        return 'bg-red-100 dark:bg-red-900/20'
      case 'high':
        return 'bg-orange-100 dark:bg-orange-900/20'
      case 'medium':
        return 'bg-yellow-100 dark:bg-yellow-900/20'
      case 'low':
        return 'bg-blue-100 dark:bg-blue-900/20'
    }
  }

  const getTypeLabel = (type: string): string => {
    const labels: Record<string, string> = {
      'api-key': 'API Key',
      'email': 'Email Address',
      'phone': 'Phone Number',
      'ssn': 'Social Security Number',
      'credit-card': 'Credit Card',
      'password': 'Password',
      'ip-address': 'IP Address',
      'file-path': 'File Path',
      'url': 'URL',
      'custom': 'Custom Pattern'
    }
    return labels[type] || type
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl dark:bg-gray-800">
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/20">
            <svg
              className="h-6 w-6 text-yellow-600 dark:text-yellow-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Sensitive Data Detected
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Your message contains potentially sensitive information
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="mb-6 max-h-96 space-y-4 overflow-y-auto">
          {/* Destination Info */}
          <div className="rounded-lg bg-gray-50 p-4 dark:bg-gray-900/50">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">Destination:</span>{' '}
              <span className="capitalize">{request.destination}</span> LLM (
              <span className="font-mono">{request.provider}</span>)
            </div>
            {request.filePath !== '<message-content>' && (
              <div className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                <span className="font-medium">File:</span>{' '}
                <span className="font-mono text-xs">{request.filePath}</span>
              </div>
            )}
          </div>

          {/* Critical Matches */}
          {criticalMatches.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-red-600 dark:text-red-400">
                🚨 Critical Risk ({criticalMatches.length})
              </h3>
              <div className="space-y-2">
                {criticalMatches.map((match, idx) => (
                  <div
                    key={idx}
                    className={`rounded-md p-3 ${getRiskBgColor(match.riskLevel)}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-900 dark:text-white">
                        {getTypeLabel(match.type)}
                      </span>
                      <span className="font-mono text-xs text-gray-600 dark:text-gray-400">
                        {match.value}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* High/Medium/Low Matches */}
          {[
            { level: 'high', matches: highMatches, emoji: '⚠️' },
            { level: 'medium', matches: mediumMatches, emoji: '⚡' },
            { level: 'low', matches: lowMatches, emoji: 'ℹ️' }
          ].map(
            ({ level, matches, emoji }) =>
              matches.length > 0 && (
                <div key={level}>
                  <h3
                    className={`mb-2 text-sm font-semibold ${getRiskColor(level as RiskLevel)}`}
                  >
                    {emoji} {level.charAt(0).toUpperCase() + level.slice(1)} Risk ({matches.length}
                    )
                  </h3>
                  <div className="space-y-2">
                    {matches.map((match, idx) => (
                      <div
                        key={idx}
                        className={`rounded-md p-2 ${getRiskBgColor(match.riskLevel)}`}
                      >
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-900 dark:text-white">
                            {getTypeLabel(match.type)}
                          </span>
                          <span className="font-mono text-xs text-gray-600 dark:text-gray-400">
                            {match.value}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
          )}

          {/* Warning Message */}
          {criticalMatches.length > 0 && (
            <div className="rounded-lg border-2 border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                ⚠️ Sending this data to a cloud LLM could expose sensitive information. Consider
                using a local LLM instead.
              </p>
            </div>
          )}
        </div>

        {/* Remember Choice */}
        <div className="mb-6">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Remember my choice for this {request.directoryId === 'conversation' ? 'conversation' : 'folder'}
            </span>
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={() => onUseLocalLLM(rememberChoice)}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600"
          >
            🔒 Use Local LLM
          </button>
          {criticalMatches.length === 0 && (
            <button
              onClick={() => onSendAnyway(rememberChoice)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
            >
              Send Anyway
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
