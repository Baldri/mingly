import { useState, useEffect } from 'react'

interface DirectoryPolicy {
  directoryId: string
  directoryPath: string
  policy: 'always-allow' | 'always-block' | 'ask-each-time'
  createdAt: number
  updatedAt: number
}

interface UploadStats {
  totalRequests: number
  allowed: number
  denied: number
  cloudUploads: number
  localOnly: number
  sensitiveDataDetected: number
}

export function PrivacySettingsTab() {
  const [policies, setPolicies] = useState<DirectoryPolicy[]>([])
  const [stats, setStats] = useState<UploadStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)

      // Load directory policies
      const policiesResult = await window.electronAPI.uploadPermission.getPolicies()
      if (policiesResult.success) {
        setPolicies(policiesResult.policies)
      }

      // Load statistics
      const statsResult = await window.electronAPI.uploadPermission.getStats()
      if (statsResult.success) {
        setStats(statsResult.stats)
      }
    } catch (error) {
      console.error('Failed to load privacy data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleRemovePolicy = async (directoryId: string) => {
    try {
      const result = await window.electronAPI.uploadPermission.removePolicy(directoryId)
      if (result.success) {
        setPolicies((prev) => prev.filter((p) => p.directoryId !== directoryId))
      }
    } catch (error) {
      console.error('Failed to remove policy:', error)
    }
  }

  const getPolicyLabel = (policy: string): string => {
    switch (policy) {
      case 'always-allow':
        return 'Always Allow'
      case 'always-block':
        return 'Always Block'
      case 'ask-each-time':
        return 'Ask Each Time'
      default:
        return policy
    }
  }

  const getPolicyColor = (policy: string): string => {
    switch (policy) {
      case 'always-allow':
        return 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/20'
      case 'always-block':
        return 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/20'
      case 'ask-each-time':
        return 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/20'
      default:
        return 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-900/20'
    }
  }

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
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Privacy & Security
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Manage data upload policies and view security audit logs
        </p>
      </div>

      {/* Statistics */}
      {stats && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
          <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
            Upload Statistics
          </h4>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {stats.totalRequests}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Total Requests</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                {stats.allowed}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Allowed</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                {stats.denied}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Denied</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                {stats.cloudUploads}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Cloud Uploads</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                {stats.localOnly}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Local Only</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                {stats.sensitiveDataDetected}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Sensitive Data</div>
            </div>
          </div>

          {/* Percentage */}
          {stats.totalRequests > 0 && (
            <div className="mt-4 flex items-center gap-2 text-sm">
              <span className="text-gray-600 dark:text-gray-400">
                {Math.round((stats.denied / stats.totalRequests) * 100)}% blocked
              </span>
              <span className="text-gray-400">•</span>
              <span className="text-gray-600 dark:text-gray-400">
                {Math.round((stats.sensitiveDataDetected / stats.totalRequests) * 100)}% had
                sensitive data
              </span>
            </div>
          )}
        </div>
      )}

      {/* Directory Policies */}
      <div>
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          Directory Upload Policies ({policies.length})
        </h4>

        {policies.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
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
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              No directory policies configured yet
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Policies will be created when you handle sensitive data
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {policies.map((policy) => (
              <div
                key={policy.directoryId}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <svg
                      className="h-5 w-5 flex-shrink-0 text-gray-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                      />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                        {policy.directoryPath}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getPolicyColor(policy.policy)}`}
                        >
                          {getPolicyLabel(policy.policy)}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          Updated {new Date(policy.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRemovePolicy(policy.directoryId)}
                  className="ml-4 rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800 dark:hover:text-red-400"
                  title="Remove policy"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
              How It Works
            </h5>
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-400">
              Mingly automatically scans your messages for sensitive data (API keys, SSNs, credit
              cards, etc.) before sending to cloud LLMs. You'll be prompted for consent when
              sensitive data is detected.
            </p>
            <ul className="mt-2 space-y-1 text-sm text-blue-800 dark:text-blue-400">
              <li className="flex items-center gap-2">
                <span className="font-bold text-red-600 dark:text-red-400">🚨 Critical:</span>
                Automatically blocked (API keys, SSN, credit cards)
              </li>
              <li className="flex items-center gap-2">
                <span className="font-bold text-yellow-600 dark:text-yellow-400">⚠️ Medium:</span>
                Requires your consent (phone numbers, IPs)
              </li>
              <li className="flex items-center gap-2">
                <span className="font-bold text-green-600 dark:text-green-400">✅ Low:</span>
                Allowed with warning (emails, file paths)
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
