/**
 * AgentStepIndicator — shows agent progress as a compact step chain.
 *
 * Renders each step with an icon and status:
 * - ⚡ Running (current step, animated pulse)
 * - 🔧 Tool call (completed step with tool use)
 * - ✅ Completed (final answer step)
 * - ❌ Error
 *
 * Expandable: click to see step details (thinking, tool calls, results).
 */

import React, { useState } from 'react'
import type { AgentStep, AgentRun } from '../../shared/types'

interface AgentStepIndicatorProps {
  steps: AgentStep[]
  run?: AgentRun | null
  isRunning: boolean
}

export const AgentStepIndicator: React.FC<AgentStepIndicatorProps> = ({
  steps,
  run,
  isRunning
}) => {
  const [expandedStep, setExpandedStep] = useState<number | null>(null)

  if (steps.length === 0 && !isRunning) return null

  const statusLabel = run
    ? run.status === 'completed'
      ? 'Abgeschlossen'
      : run.status === 'failed'
        ? 'Fehlgeschlagen'
        : run.status === 'cancelled'
          ? 'Abgebrochen'
          : run.status === 'max_steps_reached'
            ? 'Max. Schritte erreicht'
            : 'Läuft...'
    : isRunning
      ? 'Läuft...'
      : ''

  return (
    <div className="flex flex-col gap-1 my-2">
      {/* Step chain */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs text-zinc-500 mr-1">Agent:</span>

        {steps.map((step, index) => {
          const isLast = index === steps.length - 1
          const icon = step.isFinal
            ? '✅'
            : step.toolResults?.some((r) => r.isError)
              ? '⚠️'
              : '🔧'

          return (
            <React.Fragment key={step.stepNumber}>
              <button
                onClick={() =>
                  setExpandedStep(expandedStep === step.stepNumber ? null : step.stepNumber)
                }
                className={`
                  inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs
                  transition-colors cursor-pointer
                  ${
                    expandedStep === step.stepNumber
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }
                `}
                title={`Schritt ${step.stepNumber}: ${step.toolCalls.map((tc) => tc.name).join(', ') || 'Antwort'}`}
              >
                <span>{icon}</span>
                <span>{step.stepNumber}</span>
              </button>

              {!isLast && (
                <span className="text-zinc-300 dark:text-zinc-600 text-xs">→</span>
              )}
            </React.Fragment>
          )
        })}

        {/* Running indicator */}
        {isRunning && (
          <>
            {steps.length > 0 && (
              <span className="text-zinc-300 dark:text-zinc-600 text-xs">→</span>
            )}
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 animate-pulse">
              ⚡ {steps.length + 1}
            </span>
          </>
        )}

        {/* Status badge */}
        {statusLabel && (
          <span
            className={`text-xs ml-1 ${
              run?.status === 'completed'
                ? 'text-green-600 dark:text-green-400'
                : run?.status === 'failed'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-zinc-500'
            }`}
          >
            {statusLabel}
          </span>
        )}
      </div>

      {/* Expanded step detail */}
      {expandedStep !== null && (
        <StepDetail
          step={steps.find((s) => s.stepNumber === expandedStep)}
          onClose={() => setExpandedStep(null)}
        />
      )}
    </div>
  )
}

// ── Step detail panel ───────────────────────────────────────

interface StepDetailProps {
  step?: AgentStep
  onClose: () => void
}

const StepDetail: React.FC<StepDetailProps> = ({ step, onClose: _onClose }) => {
  if (!step) return null

  return (
    <div className="ml-2 p-2 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 text-xs space-y-1.5">
      {/* Thinking */}
      {step.thinking && (
        <div>
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Überlegung: </span>
          <span className="text-zinc-700 dark:text-zinc-300">
            {step.thinking.length > 200 ? step.thinking.substring(0, 200) + '...' : step.thinking}
          </span>
        </div>
      )}

      {/* Tool calls */}
      {step.toolCalls.length > 0 && (
        <div className="space-y-1">
          {step.toolCalls.map((tc) => (
            <div key={tc.id} className="flex items-start gap-1">
              <span className="text-blue-500">🔧</span>
              <div>
                <span className="font-mono font-medium text-blue-600 dark:text-blue-400">
                  {tc.name}
                </span>
                <span className="text-zinc-400 ml-1">
                  ({Object.keys(tc.arguments).join(', ')})
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tool results */}
      {step.toolResults.length > 0 && (
        <div className="space-y-1">
          {step.toolResults.map((tr) => (
            <div
              key={tr.toolCallId}
              className={`pl-4 border-l-2 ${
                tr.isError
                  ? 'border-red-300 dark:border-red-700'
                  : 'border-green-300 dark:border-green-700'
              }`}
            >
              <pre className="whitespace-pre-wrap break-all text-zinc-600 dark:text-zinc-400 max-h-20 overflow-y-auto">
                {tr.content.length > 300 ? tr.content.substring(0, 300) + '...' : tr.content}
              </pre>
            </div>
          ))}
        </div>
      )}

      {/* Tokens */}
      {step.tokens && (
        <div className="text-zinc-400">
          Tokens: {step.tokens.input} in / {step.tokens.output} out
        </div>
      )}
    </div>
  )
}

export default AgentStepIndicator
