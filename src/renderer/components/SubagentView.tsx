/**
 * SubagentView — 4-phase UI for parallel subagent orchestration.
 *
 * Phase 1: Task input + decomposition (master LLM splits task)
 * Phase 2: Configuration (SubagentConfigDialog for per-task model choice)
 * Phase 3: Execution (N columns with live AgentStepIndicator)
 * Phase 4: Synthesis (final merged answer + collapsible subtask details)
 */

import { memo, useState, useCallback, lazy, Suspense } from 'react'
import { useSubagentStore } from '../stores/subagent-store'
import { AgentStepIndicator } from './AgentStepIndicator'
import type { AgentModelSlot } from '../../shared/types'

const SubagentConfigDialog = lazy(() => import('./SubagentConfigDialog'))

const PROVIDER_BADGE: Record<string, string> = {
  anthropic: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  openai: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  google: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  ollama: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  'generic-openai': 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300'
}

export const SubagentView = memo(function SubagentView({
  onClose
}: {
  onClose: () => void
}) {
  const [task, setTask] = useState('')
  const [masterProvider, setMasterProvider] = useState('anthropic')
  const [masterModel, setMasterModel] = useState('claude-sonnet-4-20250514')
  const [showConfig, setShowConfig] = useState(false)
  const [showSubtaskDetails, setShowSubtaskDetails] = useState<string | null>(null)

  const session = useSubagentStore((s) => s.session)
  const decomposition = useSubagentStore((s) => s.decomposition)
  const perTaskSteps = useSubagentStore((s) => s.perTaskSteps)
  const isDecomposing = useSubagentStore((s) => s.isDecomposing)
  const isRunning = useSubagentStore((s) => s.isRunning)
  const isSynthesizing = useSubagentStore((s) => s.isSynthesizing)
  const error = useSubagentStore((s) => s.error)

  const decompose = useSubagentStore((s) => s.decompose)
  const updateSubtaskSlot = useSubagentStore((s) => s.updateSubtaskSlot)
  const startSubtasks = useSubagentStore((s) => s.startSubtasks)
  const cancelSession = useSubagentStore((s) => s.cancelSession)
  const clearSession = useSubagentStore((s) => s.clearSession)
  const clearError = useSubagentStore((s) => s.clearError)

  const masterSlot: AgentModelSlot = {
    provider: masterProvider,
    model: masterModel,
    label: 'Master'
  }

  const handleDecompose = useCallback(async () => {
    if (!task.trim()) return
    const result = await decompose(task.trim(), masterSlot)
    if (result) {
      setShowConfig(true)
    }
  }, [task, decompose, masterSlot])

  const handleStartSubtasks = useCallback(async () => {
    setShowConfig(false)
    await startSubtasks()
  }, [startSubtasks])

  const handleReset = useCallback(() => {
    clearSession()
    setTask('')
    setShowConfig(false)
    setShowSubtaskDetails(null)
  }, [clearSession])

  // Determine current phase
  const phase = session?.status === 'completed' || session?.status === 'failed'
    ? 'done'
    : isSynthesizing
      ? 'synthesizing'
      : isRunning
        ? 'executing'
        : showConfig && decomposition
          ? 'config'
          : isDecomposing
            ? 'decomposing'
            : 'input'

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-3 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Parallel Subagents
          </h2>
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
            Master → N Tasks → Merge
          </span>
          {/* Phase indicator */}
          <PhaseIndicator phase={phase} />
        </div>
        <div className="flex items-center gap-2">
          {(isRunning || isDecomposing || isSynthesizing) && (
            <button
              onClick={cancelSession}
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              Abbrechen
            </button>
          )}
          {phase === 'done' && (
            <button
              onClick={handleReset}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              Neuer Task
            </button>
          )}
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

      {/* Phase: Input */}
      {phase === 'input' && (
        <div className="flex-1 flex flex-col">
          <div className="px-6 py-4 space-y-4">
            {/* Master model selection */}
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Master-Modell (zerlegt Task + synthetisiert Ergebnis)
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={masterProvider}
                  onChange={(e) => setMasterProvider(e.target.value)}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                  <option value="ollama">Ollama</option>
                </select>
                <input
                  type="text"
                  value={masterModel}
                  onChange={(e) => setMasterModel(e.target.value)}
                  placeholder="Modellname..."
                  className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                />
              </div>
            </div>

            {/* Task input */}
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Task (wird in 1-3 parallele Subtasks zerlegt)
              </label>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Beschreibe einen komplexen Task, der in parallele Teilaufgaben zerlegt werden kann..."
                rows={5}
                className="w-full resize-none rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>

            <button
              onClick={handleDecompose}
              disabled={!task.trim() || !masterModel.trim()}
              className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              🧠 Task zerlegen
            </button>
          </div>

          {/* How it works */}
          <div className="flex-1 flex items-center justify-center px-6">
            <div className="max-w-md text-center space-y-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                <strong>So funktioniert es:</strong>
              </p>
              <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
                <span className="rounded bg-violet-100 px-2 py-1 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                  1. Zerlegen
                </span>
                <span>→</span>
                <span className="rounded bg-blue-100 px-2 py-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                  2. Konfigurieren
                </span>
                <span>→</span>
                <span className="rounded bg-amber-100 px-2 py-1 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                  3. Parallel ausführen
                </span>
                <span>→</span>
                <span className="rounded bg-green-100 px-2 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                  4. Synthetisieren
                </span>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Pro Subtask wählst du: lokal bleiben oder in die Cloud auslagern
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Phase: Decomposing */}
      {phase === 'decomposing' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="animate-pulse text-4xl">🧠</div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Master-Modell zerlegt Task...
            </p>
            <p className="text-xs text-gray-400">{masterProvider}/{masterModel}</p>
          </div>
        </div>
      )}

      {/* Phase: Executing — parallel columns */}
      {(phase === 'executing' || phase === 'synthesizing') && decomposition && (
        <div className="flex flex-1 overflow-hidden">
          {decomposition.subtasks.map((subtask) => {
            const steps = perTaskSteps[subtask.id] || []
            const result = session?.subtaskResults.find((r) => r.taskId === subtask.id)

            return (
              <div
                key={subtask.id}
                className="flex flex-1 flex-col border-r border-gray-200 last:border-r-0 dark:border-gray-700"
              >
                {/* Subtask header */}
                <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-900 dark:text-white truncate">
                      {subtask.title}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      PROVIDER_BADGE[subtask.slot.provider] || 'bg-gray-100 text-gray-800'
                    }`}>
                      {subtask.slot.label || subtask.slot.provider}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-400 truncate">{subtask.description}</p>
                </div>

                {/* Steps */}
                <div className="px-2 py-1 border-b border-gray-100 dark:border-gray-800">
                  <AgentStepIndicator
                    steps={steps}
                    run={result ? {
                      id: result.run.id,
                      conversationId: '',
                      task: subtask.description,
                      steps: result.run.steps,
                      status: result.run.status as 'completed' | 'failed' | 'cancelled' | 'max_steps_reached' | 'running',
                      totalTokens: result.run.totalTokens,
                      totalCost: 0,
                      durationMs: result.run.durationMs,
                      error: result.run.error,
                      createdAt: 0
                    } : null}
                    isRunning={!result && phase === 'executing'}
                  />
                </div>

                {/* Result */}
                <div className="flex-1 overflow-y-auto p-3">
                  {result ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300">
                      {result.run.steps.find((s) => s.isFinal)?.response ?? result.error ?? 'Kein Ergebnis'}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="animate-pulse">⚡</span>
                      Subtask läuft...
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Synthesizing overlay */}
      {phase === 'synthesizing' && (
        <div className="border-t border-gray-200 px-6 py-3 bg-green-50 dark:border-gray-700 dark:bg-green-900/10">
          <div className="flex items-center gap-2">
            <span className="animate-pulse">🔄</span>
            <span className="text-sm font-medium text-green-700 dark:text-green-300">
              Master-Modell synthetisiert Ergebnisse...
            </span>
          </div>
        </div>
      )}

      {/* Phase: Done — synthesis result */}
      {phase === 'done' && session && (
        <div className="flex-1 overflow-y-auto">
          {/* Synthesis result */}
          {session.synthesis && (
            <div className="px-6 py-4">
              <div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/10">
                <h4 className="text-sm font-semibold text-green-800 dark:text-green-300 mb-2">
                  Synthese-Ergebnis
                </h4>
                <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">
                  {session.synthesis}
                </div>
              </div>
            </div>
          )}

          {/* Session metadata */}
          <div className="px-6 py-2 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span>⏱ {(session.durationMs / 1000).toFixed(1)}s</span>
              <span>🎯 {session.subtaskResults.length} Subtasks</span>
              <span>
                📊 {session.totalTokens.input + session.totalTokens.output} Tokens
              </span>
              <span className={
                session.status === 'completed'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }>
                {session.status === 'completed' ? '✅ Abgeschlossen' : '❌ Fehlgeschlagen'}
              </span>
            </div>
          </div>

          {/* Collapsible subtask details */}
          <div className="px-6 py-4 space-y-2">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
              Subtask-Details
            </h4>
            {session.subtaskResults.map((result) => {
              const subtask = decomposition?.subtasks.find((s) => s.id === result.taskId)
              const isExpanded = showSubtaskDetails === result.taskId
              const finalStep = result.run.steps.find((s) => s.isFinal)

              return (
                <div
                  key={result.taskId}
                  className="rounded-lg border border-gray-200 dark:border-gray-700"
                >
                  <button
                    onClick={() => setShowSubtaskDetails(isExpanded ? null : result.taskId)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <div className="flex items-center gap-2">
                      <span className={result.run.status === 'completed' ? 'text-green-500' : 'text-red-500'}>
                        {result.run.status === 'completed' ? '✅' : '❌'}
                      </span>
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {subtask?.title ?? result.taskId}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        PROVIDER_BADGE[subtask?.slot.provider ?? ''] || 'bg-gray-100 text-gray-800'
                      }`}>
                        {subtask?.slot.label || subtask?.slot.provider}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                      <span>{(result.run.durationMs / 1000).toFixed(1)}s</span>
                      <span>{result.run.steps.length} Schritte</span>
                      <svg
                        className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
                      <div className="mb-2">
                        <AgentStepIndicator
                          steps={result.run.steps}
                          run={{
                            id: result.run.id,
                            conversationId: '',
                            task: subtask?.description ?? '',
                            steps: result.run.steps,
                            status: result.run.status as 'completed' | 'failed' | 'cancelled' | 'max_steps_reached',
                            totalTokens: result.run.totalTokens,
                            totalCost: 0,
                            durationMs: result.run.durationMs,
                            error: result.run.error,
                            createdAt: 0
                          }}
                          isRunning={false}
                        />
                      </div>
                      {finalStep?.response && (
                        <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400 max-h-40 overflow-y-auto">
                          {finalStep.response}
                        </div>
                      )}
                      {result.error && (
                        <div className="text-xs text-red-600 dark:text-red-400">
                          Fehler: {result.error}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Config Dialog (Phase 2) */}
      {showConfig && decomposition && (
        <Suspense fallback={null}>
          <SubagentConfigDialog
            subtasks={decomposition.subtasks}
            masterSlot={masterSlot}
            masterSummary={decomposition.masterSummary}
            onUpdateSlot={updateSubtaskSlot}
            onStart={handleStartSubtasks}
            onCancel={() => {
              setShowConfig(false)
              clearSession()
            }}
          />
        </Suspense>
      )}
    </div>
  )
})

// ── Phase Indicator ─────────────────────────────────────────

function PhaseIndicator({ phase }: { phase: string }) {
  const phases = [
    { key: 'input', label: 'Eingabe', color: 'gray' },
    { key: 'decomposing', label: 'Zerlegen', color: 'violet' },
    { key: 'config', label: 'Konfigurieren', color: 'blue' },
    { key: 'executing', label: 'Ausführen', color: 'amber' },
    { key: 'synthesizing', label: 'Synthetisieren', color: 'green' },
    { key: 'done', label: 'Fertig', color: 'green' }
  ]

  const currentIndex = phases.findIndex((p) => p.key === phase)

  return (
    <div className="flex items-center gap-1">
      {phases.slice(0, -1).map((p, i) => {
        const isActive = i === currentIndex
        const isCompleted = i < currentIndex

        return (
          <span
            key={p.key}
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              isActive
                ? 'bg-indigo-500 animate-pulse'
                : isCompleted
                  ? 'bg-indigo-400'
                  : 'bg-gray-200 dark:bg-gray-700'
            }`}
            title={p.label}
          />
        )
      })}
    </div>
  )
}

export default SubagentView
