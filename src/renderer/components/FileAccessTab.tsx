import { useState, useEffect } from 'react'
import type { AllowedDirectory, FileAccessPermission } from '../../shared/file-access-types'

export function FileAccessTab() {
  const [directories, setDirectories] = useState<AllowedDirectory[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDirectories()
  }, [])

  const loadDirectories = async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.fileAccess.listDirectories()
      if (result.success) {
        setDirectories(result.directories)
      }
    } catch (error) {
      console.error('Failed to load directories:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleRequestAccess = async () => {
    try {
      const result = await window.electronAPI.fileAccess.requestDirectory(['read', 'create'])
      if (result.success && result.directory) {
        setDirectories([...directories, result.directory])
      }
    } catch (error) {
      console.error('Failed to request directory access:', error)
    }
  }

  const handleRevokeAccess = async (directoryId: string) => {
    if (!confirm('Are you sure you want to revoke access to this directory?')) return

    try {
      const result = await window.electronAPI.fileAccess.revokeDirectory(directoryId)
      if (result.success) {
        setDirectories(directories.filter((d) => d.id !== directoryId))
      }
    } catch (error) {
      console.error('Failed to revoke directory access:', error)
    }
  }

  const getPermissionLabel = (permissions: FileAccessPermission[]): string => {
    if (permissions.includes('read-create')) return 'Read + Create'
    if (permissions.includes('read') && permissions.includes('create')) return 'Read + Create'
    if (permissions.includes('read')) return 'Read Only'
    if (permissions.includes('create')) return 'Create Only'
    return 'Unknown'
  }

  const getLocationIcon = (location: string) => {
    switch (location) {
      case 'local':
        return (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
            />
          </svg>
        )
      case 'network-smb':
      case 'network-nfs':
        return (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
            />
          </svg>
        )
      default:
        return null
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
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">File Access</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Grant Mingly access to local and network directories
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleRequestAccess}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
            />
          </svg>
          Grant Directory Access
        </button>
      </div>

      {/* Directory List */}
      <div>
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          Allowed Directories ({directories.length})
        </h4>

        {directories.length === 0 ? (
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
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              No directories granted yet
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Grant access to allow Mingly to read and create files
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {directories.map((dir) => (
              <div
                key={dir.id}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
                      <div className="text-gray-600 dark:text-gray-400">
                        {getLocationIcon(dir.location)}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                        {dir.path}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-600 dark:bg-green-900/20 dark:text-green-400">
                          {getPermissionLabel(dir.permissions)}
                        </span>
                        {dir.recursive && (
                          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-600 dark:bg-blue-900/20 dark:text-blue-400">
                            Recursive
                          </span>
                        )}
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {dir.location.replace('network-', '').toUpperCase()}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                        Granted {new Date(dir.grantedAt).toLocaleDateString()} • Accessed{' '}
                        {dir.accessCount} times
                      </div>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRevokeAccess(dir.id)}
                  className="ml-4 rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800 dark:hover:text-red-400"
                  title="Revoke access"
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

      {/* Security Info */}
      <div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-900/20">
        <div className="flex gap-3">
          <svg
            className="h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
            />
          </svg>
          <div>
            <h5 className="text-sm font-semibold text-green-900 dark:text-green-300">
              Security Guarantee
            </h5>
            <p className="mt-1 text-sm text-green-800 dark:text-green-400">
              Files accessed through Mingly are <strong>NEVER uploaded</strong> to cloud LLMs without
              your explicit permission. All file operations are secured with:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-green-800 dark:text-green-400">
              <li className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                Path traversal protection
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                Extension whitelist
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                No file overwrites (create only)
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                Sensitive data detection before upload
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
