/**
 * AgentComparisonView — parallel model comparison with full tool-use.
 *
 * Unlike ComparisonView (simple text comparison), this runs N AgentExecutor
 * instances in parallel, each with its own ReAct loop and tool access.
 * Shows live step indicators, tool calls, and final answers side-by-side.
 */

import { memo, useState, useCallback, useMemo } from 'react'
import { useAgentComparisonStore } from '../stores/agent-comparison-store'
import { AgentStepIndicator } from './AgentStepIndicator'
import type { AgentModelSlot, AgentStep } from '../../shared/types'

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'border-orange-500 bg-orange-50 dark:bg-orange-900/10',
  openai: 'border-green-500 bg-green-50 dark:bg-green-900/10',
  google: 'border-blue-500 bg-blue-50 dark:bg-blue-900/10',
  ollama: 'border-purple-500 bg-purple-50 dark:bg-purple-900/10',
  'generic-openai': 'border-teal-500 bg-teal-50 dark:bg-teal-900/10'
}

const PROVIDER_BADGE: Record<string, string> = {
  anthropic: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  openai: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  google: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  ollama: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  'generic-openai': 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300'
}

export const AgentComparisonView = memo(function AgentComparisonView({
  onClose
}: {
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState('')
  const [newProvider, setNewProvider] = useState('anthropic')
  const [newModel, setNewModel] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const slots = useAgentComparisonStore((s) => s.slots)
  const session = useAgentComparisonStore((s) => s.session)
  const perSlotSteps = useAgentComparisonStore((s) => s.perSlotSteps)
  const isRunning = useAgentComparisonStore((s) => s.isRunning)
  const error = useAgentComparisonStore((s) => s.error)
  const addSlot = useAgentComparisonStore((s) => s.addSlot)
  const removeSlot = useAgentComparisonStore((s) => s.removeSlot)
  const runComparison = useAgentComparisonStore((s) => s.runComparison)
  const cancelComparison = useAgentComparisonStore((s) => s.cancelComparison)
  const clearError = useAgentComparisonStore((s) => s.clearError)

  const handleAddSlot = useCallback(() => {
    if (newModel.trim()) {
      addSlot({
        provider: newProvider,
        model: newModel.trim(),
        label: newLabel.trim() || undefined
      })
      setNewModel('')
      setNewLabel('')
    }
  }, [addSlot, newProvider, newModel, newLabel])

  const handleRun = useCallback(() => {
    if (prompt.trim()) {
      runComparison(prompt.trim())
    }
  }, [runComparison, prompt])

  const columnWidth = useMemo(() => {
    const count = session ? session.slots.length : slots.length
    if (count <= 1) return 'w-full'
    if (count === 2) return 'w-1/2'
    return 'w-1/3'
  }, [session, slots.length])

  // Warn if multiple slots use same local provider
  const ollamaSlotCount = slots.filter((s) => s.provider === 'ollama').length
  const showOllamaWarning = ollamaSlotCount > 1

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-3 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Agent Comparison
          </h2>
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
            Tool-Use
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-2 hover:bg-gray-200 dark:hover:bg-gray-700"
          aria-label="Schliessen"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Slot Selection */}
      <div className="border-b border-gray-200 px-6 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          {slots.map((slot, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${
                PROVIDER_BADGE[slot.provider] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {slot.label || `${slot.provider}/${slot.model}`}
              <button onClick={() => removeSlot(i)} className="ml-1 hover:opacity-70">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>

        {slots.length < 3 && (
          <div className="flex items-center gap-2">
            <select
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
              <option value="ollama">Ollama (Lokal)</option>
              <option value="generic-openai">OpenAI-Kompatibel</option>
            </select>
            <input
              type="text"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddSlot()}
              placeholder="Modellname..."
              className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label (optional)"
              className="w-32 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <button
              onClick={handleAddSlot}
              disabled={!newModel.trim()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Hinzufügen
            </button>
          </div>
        )}

        {showOllamaWarning && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            ⚠️ Mehrere Ollama-Slots: Parallele lokale Inference kann GPU stark belasten.
          </p>
        )}
      </div>

      {/* Prompt Input */}
      <div className="border-b border-gray-200 px-6 py-3 dark:border-gray-700">
        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Task eingeben — jedes Modell bearbeitet es mit eigenem ReAct-Loop und Tools..."
            rows={3}
            className="flex-1 resize-none rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
          <div className="flex flex-col gap-1 self-end">
            <button
              onClick={handleRun}
              disabled={isRunning || slots.length < 2 || !prompt.trim()}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {isRunning ? 'Läuft...' : 'Vergleichen'}
            </button>
            {isRunning && (
              <button
                onClick={cancelComparison}
                className="rounded-md border border-red-300 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                Abbrechen
              </button>
            )}
          </div>
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

      {/* Results — columns with live steps */}
      <div className="flex flex-1 overflow-hidden">
        {session ? (
          session.slots.map((slot, index) => (
            <SlotColumn
              key={index}
              slot={slot}
              steps={perSlotSteps[index] || []}
              result={session.results[index]}
              isRunning={isRunning}
              width={columnWidth}
            />
          ))
        ) : slots.length > 0 && isRunning ? (
          // Show running columns before session result arrives
          slots.map((slot, index) => (
            <SlotColumn
              key={index}
              slot={slot}
              steps={perSlotSteps[index] || []}
              result={undefined}
              isRunning={true}
              width={columnWidth}
            />
          ))
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">Agent Comparison</p>
              <p className="text-xs">
                {slots.length < 2
                  ? 'Mindestens 2 Modell-Slots hinzufügen'
                  : 'Task eingeben und „Vergleichen" klicken'}
              </p>
              <p className="text-xs text-gray-300 dark:text-gray-600">
                Jedes Modell bekommt eigenen ReAct-Loop mit Tool-Zugriff
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

// ── Slot Result Column ──────────────────────────────────────

const SlotColumn = memo(function SlotColumn({
  slot,
  steps,
  result,
  isRunning,
  width
}: {
  slot: AgentModelSlot
  steps: AgentStep[]
  result?: { slot: AgentModelSlot; run: { id: string; status: string; steps: AgentStep[]; totalTokens: { input: number; output: number }; durationMs: number; error?: string }; error?: string }
  isRunning: boolean
  width: string
}) {
  const finalStep = result?.run.steps.find((s) => s.isFinal)
  const finalAnswer = finalStep?.response ?? result?.run.error ?? null
  const providerKey = slot.provider.toLowerCase()

  return (
    <div className={`${width} flex flex-col border-r border-gray-200 last:border-r-0 dark:border-gray-700`}>
      {/* Column header */}
      <div className={`border-b border-l-4 px-4 py-2 ${PROVIDER_COLORS[providerKey] || 'border-gray-500 bg-gray-50 dark:bg-gray-800'}`}>
        <div className="flex items-center justify-between">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            PROVIDER_BADGE[providerKey] || 'bg-gray-100 text-gray-800'
          }`}>
            {slot.label || `${slot.provider}/${slot.model}`}
          </span>
          {result?.run.status === 'completed' && (
            <span className="text-xs text-green-600 dark:text-green-400">✅</span>
          )}
          {result?.run.status === 'failed' && (
            <span className="text-xs text-red-600 dark:text-red-400">❌</span>
          )}
        </div>

        {/* Metadata */}
        {result && (
          <div className="mt-1 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
            <span>{(result.run.durationMs / 1000).toFixed(1)}s</span>
            <span>{result.run.totalTokens.input + result.run.totalTokens.output} Tokens</span>
            <span>{result.run.steps.length} Schritte</span>
          </div>
        )}
      </div>

      {/* Step indicator */}
      <div className="px-3 py-1.5 border-b border-gray-100 dark:border-gray-800">
        <AgentStepIndicator
          steps={steps.length > 0 ? steps : (result?.run.steps ?? [])}
          run={result ? {
            id: result.run.id,
            conversationId: '',
            task: '',
            steps: result.run.steps,
            status: result.run.status as 'completed' | 'failed' | 'cancelled' | 'max_steps_reached' | 'running',
            totalTokens: result.run.totalTokens,
            totalCost: 0,
            durationMs: result.run.durationMs,
            error: result.run.error,
            createdAt: 0
          } : null}
          isRunning={isRunning && !result}
        />
      </div>

      {/* Response content */}
      <div className="flex-1 overflow-y-auto p-4">
        {finalAnswer ? (
          <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">
            {finalAnswer}
          </div>
        ) : result?.error ? (
          <div className="text-sm text-red-600 dark:text-red-400">
            Fehler: {result.error}
          </div>
        ) : isRunning ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span className="animate-pulse">⚡</span>
            Agent arbeitet...
          </div>
        ) : null}
      </div>
    </div>
  )
})

export default AgentComparisonView
