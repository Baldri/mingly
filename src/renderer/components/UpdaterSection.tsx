/**
 * UpdaterSection — displayed in Settings > General.
 * Shows current app version, check for updates button, download/install actions.
 */

import { useEffect } from 'react'
import { RefreshCw, Download, ExternalLink, CheckCircle, AlertCircle } from 'lucide-react'
import { useUpdaterStore } from '../stores/updater-store'

export function UpdaterSection() {
  const { status, loadStatus, checkForUpdates, downloadUpdate, installUpdate, openReleasePage, subscribeToStatus } = useUpdaterStore()

  useEffect(() => {
    loadStatus()
    const unsubscribe = subscribeToStatus()
    return unsubscribe
  }, [loadStatus, subscribeToStatus])

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3">Updates</h3>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        {/* Status display */}
        {status.checking && (
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <RefreshCw size={14} className="animate-spin" />
            Checking for updates...
          </div>
        )}

        {status.error && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={14} />
            {status.error}
          </div>
        )}

        {status.available && status.info && !status.downloading && !status.downloaded && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400">
              <Download size={14} />
              Update available: v{status.info.version}
            </div>
            {status.info.releaseDate && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Released: {new Date(status.info.releaseDate).toLocaleDateString()}
              </p>
            )}
          </div>
        )}

        {status.downloading && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <Download size={14} className="animate-pulse" />
              Downloading update... {status.progress != null ? `${status.progress}%` : ''}
            </div>
            {status.progress != null && (
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${status.progress}%` }}
                />
              </div>
            )}
          </div>
        )}

        {status.downloaded && (
          <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400">
            <CheckCircle size={14} />
            Update ready — will install on next restart
          </div>
        )}

        {!status.checking && !status.available && !status.downloading && !status.downloaded && !status.error && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You're up to date.
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2 flex-wrap pt-1">
          <button
            onClick={checkForUpdates}
            disabled={status.checking}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={status.checking ? 'animate-spin' : ''} />
            Check for Updates
          </button>

          {status.available && !status.downloaded && !status.downloading && (
            status.autoUpdateEnabled ? (
              <button
                onClick={downloadUpdate}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                <Download size={14} />
                Download Update
              </button>
            ) : (
              <button
                onClick={openReleasePage}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                <ExternalLink size={14} />
                Download Manually
              </button>
            )
          )}

          {status.downloaded && (
            <button
              onClick={installUpdate}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors"
            >
              Restart & Install
            </button>
          )}
        </div>

        {/* Auto-update info */}
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {status.autoUpdateEnabled
            ? 'Auto-update enabled (Pro+). Updates download automatically.'
            : 'Free plan — manual download from GitHub Releases.'}
        </p>
      </div>
    </div>
  )
}
