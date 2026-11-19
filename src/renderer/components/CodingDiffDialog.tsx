import { useState } from 'react'
import { useCodingStore } from '../stores/coding-store'
import { diffLines, displayText } from '../lib/coding-display'

const LINE_CLASS = {
  add: 'bg-green-50 text-green-900 dark:bg-green-900/20 dark:text-green-200',
  remove: 'bg-red-50 text-red-900 dark:bg-red-900/20 dark:text-red-200',
  context: 'text-gray-700 dark:text-gray-300',
  meta: 'text-gray-500 dark:text-gray-400'
} as const

/**
 * The approval surface for a run's proposed package.
 *
 * It must not be able to show the human something other than what is written:
 * every model-supplied string (path, diff text) goes through coding-display,
 * which renders hidden characters visibly. Accept writes the WHOLE package the
 * human was shown (the digest travels with it); a package that changed in the
 * meantime is refused by the main process.
 */
export function CodingDiffDialog() {
  const pending = useCodingStore((s) => s.pending)
  const error = useCodingStore((s) => s.error)
  const acceptPending = useCodingStore((s) => s.acceptPending)
  const rejectPending = useCodingStore((s) => s.rejectPending)
  const [selected, setSelected] = useState(0)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  if (!pending || pending.edits.length === 0) return null

  const edit = pending.edits[Math.min(selected, pending.edits.length - 1)]
  const added = pending.edits.reduce((n, e) => n + e.addedLines, 0)
  const removed = pending.edits.reduce((n, e) => n + e.removedLines, 0)
  const hidden = pending.edits.filter((e) => e.introducesHiddenCharacters)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="coding-diff-title"
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white p-6 shadow-2xl dark:bg-gray-800"
      >
        <h2 id="coding-diff-title" className="text-xl font-semibold text-gray-900 dark:text-white">
          Vorgeschlagene Änderungen prüfen
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          {pending.edits.length} {pending.edits.length === 1 ? 'Datei' : 'Dateien'}, +{added} −{removed} Zeilen.
          «Annehmen» schreibt alle Dateien dieser Liste; es wird nichts geschrieben, was hier nicht steht.
        </p>

        {hidden.length > 0 && (
          <div role="alert" className="mt-3 rounded border-2 border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            Achtung: {hidden.length === 1 ? 'Ein Vorschlag fügt' : `${hidden.length} Vorschläge fügen`} unsichtbare oder
            richtungsändernde Zeichen ein ({hidden.map((e) => displayText(e.path)).join(', ')}). Sie sind unten
            als &lt;U+XXXX&gt; sichtbar gemacht und werden unverändert geschrieben.
          </div>
        )}

        <div className="mt-3 flex min-h-0 flex-1 gap-3">
          <ul className="w-64 shrink-0 space-y-1 overflow-y-auto" aria-label="Dateien">
            {pending.edits.map((e, index) => (
              <li key={`${e.path}-${index}`}>
                <button
                  onClick={() => setSelected(index)}
                  className={`w-full rounded border px-2 py-1 text-left text-xs ${
                    index === selected
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700'
                  }`}
                >
                  <span className="block break-all font-mono text-gray-900 dark:text-gray-100">{displayText(e.path)}</span>
                  <span className="text-green-700 dark:text-green-400">+{e.addedLines}</span>{' '}
                  <span className="text-red-700 dark:text-red-400">−{e.removedLines}</span>
                  {e.introducesHiddenCharacters && (
                    <span className="ml-1 font-medium text-red-700 dark:text-red-400">unsichtbare Zeichen</span>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <pre
            className="min-w-0 flex-1 overflow-auto rounded border border-gray-200 bg-white p-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
            aria-label={`Diff von ${displayText(edit.path)}`}
          >
            {diffLines(edit.diff).map((line, index) => (
              <div key={index} className={`whitespace-pre-wrap break-all ${LINE_CLASS[line.kind]}`}>
                {line.text === '' ? ' ' : line.text}
              </div>
            ))}
          </pre>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
            {displayText(error)}
          </p>
        )}

        <div className="mt-4">
          <label htmlFor="coding-reject-reason" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Grund bei Ablehnung (optional, wird im Audit-Protokoll festgehalten)
          </label>
          <input
            id="coding-reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>

        <div className="mt-4 flex justify-end gap-3">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await rejectPending(reason)
                setReason('')
              })
            }
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Ablehnen
          </button>
          <button
            disabled={busy}
            onClick={() => void run(acceptPending)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Annehmen ({pending.edits.length} {pending.edits.length === 1 ? 'Datei' : 'Dateien'} schreiben)
          </button>
        </div>
      </div>
    </div>
  )
}
