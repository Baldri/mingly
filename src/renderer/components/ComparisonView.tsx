import { memo, useState, useCallback, useMemo } from 'react'
import { useComparisonStore } from '../stores/comparison-store'
import type { ComparisonResult } from '../../shared/types'

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'border-orange-500 bg-orange-50 dark:bg-orange-900/10',
  openai: 'border-green-500 bg-green-50 dark:bg-green-900/10',
  google: 'border-blue-500 bg-blue-50 dark:bg-blue-900/10',
  ollama: 'border-purple-500 bg-purple-50 dark:bg-purple-900/10'
}

const PROVIDER_BADGE: Record<string, string> = {
  anthropic: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  openai: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  google: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  ollama: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
}

export const ComparisonView = memo(function ComparisonView({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [newProvider, setNewProvider] = useState('anthropic')
  const [newModel, setNewModel] = useState('')

  const selectedModels = useComparisonStore((s) => s.selectedModels)
  const results = useComparisonStore((s) => s.results)
  const isRunning = useComparisonStore((s) => s.isRunning)
  const error = useComparisonStore((s) => s.error)
  const addModel = useComparisonStore((s) => s.addModel)
  const removeModel = useComparisonStore((s) => s.removeModel)
  const runComparison = useComparisonStore((s) => s.runComparison)
  const markWinner = useComparisonStore((s) => s.markWinner)
  const clearError = useComparisonStore((s) => s.clearError)

  const handleAddModel = useCallback(() => {
    if (newModel.trim()) {
      addModel({ provider: newProvider, model: newModel.trim() })
      setNewModel('')
    }
  }, [addModel, newProvider, newModel])

  const handleRun = useCallback(() => {
    if (prompt.trim()) {
      runComparison(prompt.trim())
    }
  }, [runComparison, prompt])

  const columnWidth = useMemo(() => {
    if (results.length === 0) return 'w-full'
    if (results.length === 2) return 'w-1/2'
    return 'w-1/3'
  }, [results.length])

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-3 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Model Comparison</h2>
        <button
          onClick={onClose}
          className="rounded-lg p-2 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Model Selection */}
      <div className="border-b border-gray-200 px-6 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          {selectedModels.map((m, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${PROVIDER_BADGE[m.provider] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'}`}
            >
              {m.provider}/{m.model}
              <button onClick={() => removeModel(i)} className="ml-1 hover:opacity-70">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>

        {selectedModels.length < 3 && (
          <div className="flex items-center gap-2">
            <select
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
              <option value="ollama">Ollama</option>
            </select>
            <input
              type="text"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
              placeholder="Model name..."
              className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <button
              onClick={handleAddModel}
              disabled={!newModel.trim()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
      </div>

      {/* Prompt Input */}
      <div className="border-b border-gray-200 px-6 py-3 dark:border-gray-700">
        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter your prompt to compare across models..."
            rows={3}
            className="flex-1 resize-none rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
          <button
            onClick={handleRun}
            disabled={isRunning || selectedModels.length < 2 || !prompt.trim()}
            className="self-end rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isRunning ? 'Running...' : 'Compare'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-2 dark:border-red-900 dark:bg-red-900/20">
          <span className="flex-1 text-sm text-red-700 dark:text-red-300">{error}</span>
          <button onClick={clearError} className="text-red-500 hover:text-red-700">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Results */}
      <div className="flex flex-1 overflow-hidden">
        {results.length > 0 ? (
          results.map((result) => (
            <ResultColumn
              key={result.id}
              result={result}
              width={columnWidth}
              onMarkWinner={() => markWinner(result.id)}
            />
          ))
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            <p className="text-sm">
              {selectedModels.length < 2
                ? 'Add at least 2 models to compare'
                : 'Enter a prompt and click Compare'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
})

const ResultColumn = memo(function ResultColumn({
  result,
  width,
  onMarkWinner
}: {
  result: ComparisonResult
  width: string
  onMarkWinner: () => void
}) {
  return (
    <div className={`${width} flex flex-col border-r border-gray-200 last:border-r-0 dark:border-gray-700`}>
      {/* Column header */}
      <div className={`border-b border-l-4 px-4 py-2 ${PROVIDER_COLORS[result.provider] || 'border-gray-500 bg-gray-50 dark:bg-gray-800'}`}>
        <div className="flex items-center justify-between">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PROVIDER_BADGE[result.provider] || 'bg-gray-100 text-gray-800'}`}>
            {result.provider}/{result.model}
          </span>
          {result.isWinner && (
            <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
              Winner
            </span>
          )}
        </div>
        {/* Metadata bar */}
        <div className="mt-1 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          {result.latencyMs > 0 && <span>{(result.latencyMs / 1000).toFixed(1)}s</span>}
          {result.tokens && <span>{result.tokens} tokens</span>}
          {result.cost && <span>${result.cost.toFixed(4)}</span>}
        </div>
      </div>

      {/* Response content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">
          {result.response}
        </div>
      </div>

      {/* Mark winner button */}
      {!result.isWinner && (
        <div className="border-t border-gray-200 px-4 py-2 dark:border-gray-700">
          <button
            onClick={onMarkWinner}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Mark as Winner
          </button>
        </div>
      )}
    </div>
  )
})
