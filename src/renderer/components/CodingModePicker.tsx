import { useEffect } from 'react'
import { useCodingStore } from '../stores/coding-store'
import { CODING_MODE_CHOICES } from '../../shared/coding-types'
import { displayText, getPermissionLabel, isCodingFeatureAllowed } from '../lib/coding-display'
import { useSubscriptionStore } from '../stores/subscription-store'

/** Offers a CSV string as a file download. */
function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * Project and mode for a coding run, plus the result of the last run (undo and
 * audit export). The levels are built from CODING_MODE_CHOICES: `auto` is not in
 * that list. Each level carries its scope note itself (R36): the grade covers
 * Mingly's own tools, not the user's MCP servers.
 */
export function CodingModePicker() {
  const grants = useCodingStore((s) => s.grants)
  const selectedDirectoryId = useCodingStore((s) => s.selectedDirectoryId)
  const modes = useCodingStore((s) => s.modes)
  const runInFlight = useCodingStore((s) => s.runInFlight)
  const applied = useCodingStore((s) => s.applied)
  const undo = useCodingStore((s) => s.undo)
  const error = useCodingStore((s) => s.error)
  const loadProjects = useCodingStore((s) => s.loadProjects)
  const addProject = useCodingStore((s) => s.addProject)
  const selectProject = useCodingStore((s) => s.selectProject)
  const setMode = useCodingStore((s) => s.setMode)
  const undoLast = useCodingStore((s) => s.undoLast)
  const exportAudit = useCodingStore((s) => s.exportAudit)
  const clearError = useCodingStore((s) => s.clearError)

  const features = useSubscriptionStore((s) => s.features)
  const loadAllFeatures = useSubscriptionStore((s) => s.loadAllFeatures)
  const openUpgradeDialog = useSubscriptionStore((s) => s.openUpgradeDialog)
  const allowed = isCodingFeatureAllowed(features)

  // The feature map is empty until loaded; unknown reads as not allowed.
  useEffect(() => {
    void loadAllFeatures()
  }, [loadAllFeatures])

  // Projects are only fetched for a tier that may use them: every coding channel is gated.
  useEffect(() => {
    if (allowed) void loadProjects()
  }, [allowed, loadProjects])

  const selected = grants.find((g) => g.id === selectedDirectoryId) ?? null
  const currentMode = selected ? (modes[selected.id] ?? 'off') : 'off'

  const handleExport = async (): Promise<void> => {
    const csv = await exportAudit()
    if (csv !== null) downloadCsv(`mingly-coding-audit-${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  if (!allowed) {
    return (
      <div className="mb-3 text-sm" data-testid="coding-mode-locked">
        <button
          onClick={() => openUpgradeDialog('agentic_mode')}
          className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          Coding-Projekt (Pro) – Upgrade ansehen
        </button>
      </div>
    )
  }

  return (
    <div
      className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/40"
      data-testid="coding-mode-picker"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="coding-project" className="font-medium text-gray-700 dark:text-gray-300">
          Coding-Projekt
        </label>
        <select
          id="coding-project"
          value={selectedDirectoryId ?? ''}
          onChange={(e) => selectProject(e.target.value === '' ? null : e.target.value)}
          disabled={runInFlight}
          className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="">Kein Projekt (normaler Chat)</option>
          {grants.map((grant) => (
            <option key={grant.id} value={grant.id}>
              {displayText(grant.name)} · {displayText(grant.path)}
            </option>
          ))}
        </select>
        <button
          onClick={() => void addProject()}
          disabled={runInFlight}
          className="rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          Verzeichnis wählen…
        </button>
      </div>

      {selected && (
        <>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Berechtigung des Verzeichnisses: <span className="font-medium">{getPermissionLabel(selected.permissions)}</span>
          </p>
          <fieldset className="mt-2 space-y-1.5" disabled={runInFlight}>
            <legend className="sr-only">Coding-Modus</legend>
            {CODING_MODE_CHOICES.map((choice) => (
              <label
                key={choice.mode}
                className={`flex cursor-pointer items-start gap-2 rounded border p-2 ${
                  currentMode === choice.mode
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <input
                  type="radio"
                  name="coding-mode"
                  value={choice.mode}
                  checked={currentMode === choice.mode}
                  onChange={() => void setMode(selected.id, choice.mode)}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block font-medium text-gray-900 dark:text-gray-100">{choice.label}</span>
                  <span className="block text-gray-600 dark:text-gray-300">{choice.description}</span>
                  {/* R36: the scope sits with the level, not in a help text. */}
                  <span className="block text-xs font-medium text-amber-700 dark:text-amber-400">
                    {choice.scopeNote}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      )}

      {error && (
        <div role="alert" className="mt-2 flex items-start gap-2 rounded bg-red-50 p-2 text-red-700 dark:bg-red-900/20 dark:text-red-300">
          <span className="flex-1">{displayText(error)}</span>
          <button onClick={clearError} aria-label="Meldung schliessen" className="text-red-500">
            ×
          </button>
        </div>
      )}

      {applied && (
        <div className="mt-2 rounded border border-green-200 bg-green-50 p-2 dark:border-green-900 dark:bg-green-900/20">
          <p className="font-medium text-green-800 dark:text-green-300">
            {applied.paths.length} {applied.paths.length === 1 ? 'Datei' : 'Dateien'} geschrieben
          </p>
          <ul className="mt-1 list-inside list-disc font-mono text-xs text-green-900 dark:text-green-200">
            {applied.paths.map((p) => (
              <li key={p}>{displayText(p)}</li>
            ))}
          </ul>
          <button
            onClick={() => void undoLast()}
            className="mt-2 rounded border border-green-700 px-2 py-1 text-green-800 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-900/40"
          >
            Rückgängig machen
          </button>
        </div>
      )}

      {undo && (
        <div
          role="status"
          className={`mt-2 rounded border p-2 ${
            undo.complete
              ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-900/20'
              : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
          }`}
        >
          <p className="font-medium text-gray-900 dark:text-gray-100">{undo.headline}</p>
          {undo.restored.length > 0 && (
            <>
              <p className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-300">Wiederhergestellt</p>
              <ul className="list-inside list-disc font-mono text-xs">
                {undo.restored.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          )}
          {undo.skipped.length > 0 && (
            <>
              <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-300">Nicht wiederhergestellt</p>
              <ul className="space-y-1 text-xs">
                {undo.skipped.map((file) => (
                  <li key={file.path}>
                    <span className="font-mono">{file.path}</span>
                    <span className="block text-gray-700 dark:text-gray-300">{file.reasonText}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="mt-2">
        <button
          onClick={() => void handleExport()}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          Audit-Protokoll exportieren (CSV)
        </button>
      </div>
    </div>
  )
}
