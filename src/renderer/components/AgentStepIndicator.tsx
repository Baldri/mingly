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
 *
 * Everything shown here comes from outside the renderer — a model wrote the
 * thinking and the tool names, a file or a command produced the results — so it
 * all goes through `displayText`, the SAME escaping the diff dialog uses.
 * Without it a zero-width space or a right-to-left override was invisible
 * exactly where the human is trying to judge what the agent read. Where the
 * sanitizer rewrote a result that was forwarded as it was, the panel says so.
 */

import React, { useState } from 'react'
import { AGENT_RESULT_SANITIZED_NOTICE, displayText } from '../lib/coding-display'
import type { AgentGuardWarning, AgentStep, AgentRun } from '../../shared/types'

interface AgentStepIndicatorProps {
  steps: AgentStep[]
  run?: AgentRun | null
  isRunning: boolean
  /**
   * What the preflight guard changed about this run. Shown while it runs, not
   * only at the end: the guard emits it before the first model call.
   */
  guardWarnings?: AgentGuardWarning[]
}

export const AgentStepIndicator: React.FC<AgentStepIndicatorProps> = ({
  steps,
  run,
  isRunning,
  guardWarnings
}) => {
  const [expandedStep, setExpandedStep] = useState<number | null>(null)

  const warnings = guardWarnings ?? []
  // A run the guard ended before its first step has no steps and is not
  // running. Its error is the only thing it has to say, so it still renders.
  if (steps.length === 0 && !isRunning && warnings.length === 0 && !run?.error) return null

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
                title={`Schritt ${step.stepNumber}: ${displayText(step.toolCalls.map((tc) => tc.name).join(', ')) || 'Antwort'}`}
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

        {/* Which provider the run ACTUALLY used. Named only where the guard
            replaced the chosen one — otherwise it repeats the conversation
            header and adds noise to every single run. */}
        {run?.requestedProvider && (
          <span
            className="text-xs ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
            title={`Der Guard hat den gewählten Provider ersetzt: ${displayText(run.requestedProvider)} → ${displayText(run.provider)}`}
          >
            {displayText(run.requestedProvider)} → {displayText(run.provider)}
          </span>
        )}
      </div>

      {/* Why the run ended. "Fehlgeschlagen" alone does not tell a user that a
          guard refused to move their on-device run to a cloud provider, and the
          chat path had nowhere else to put it. */}
      {run?.error && (
        <div role="alert" className="ml-2 text-xs text-red-600 dark:text-red-400">
          {displayText(run.error)}
        </div>
      )}

      {/* Guard warnings. Rendered as their own line, because the badge above
          only exists once the run has a result and this arrives before the
          first model call. */}
      {warnings.map((warning, index) => (
        <div
          key={`${warning.type}-${index}`}
          role="status"
          className="ml-2 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300"
        >
          <span aria-hidden="true">⚠️</span>
          <span>
            {displayText(warning.message ?? warning.type)}
            {warning.reasons && warning.reasons.length > 0 && (
              <span className="text-amber-600/80 dark:text-amber-400/80">
                {' '}
                ({displayText(warning.reasons.join(', '))})
              </span>
            )}
          </span>
        </div>
      ))}

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
      {/* Thinking. Cut first, THEN escaped: cutting after the escape could end
          the text inside a `<U+` sequence and show half an escape. */}
      {step.thinking && (
        <div>
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Überlegung: </span>
          <span className="text-zinc-700 dark:text-zinc-300">
            {displayText(
              step.thinking.length > 200 ? step.thinking.substring(0, 200) + '...' : step.thinking
            )}
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
                  {displayText(tc.name)}
                </span>
                <span className="text-zinc-400 ml-1">
                  ({displayText(Object.keys(tc.arguments).join(', '))})
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
              {tr.sanitizerCleaned && (
                <div className="text-amber-700 dark:text-amber-400">
                  {AGENT_RESULT_SANITIZED_NOTICE}
                </div>
              )}
              <pre className="whitespace-pre-wrap break-all text-zinc-600 dark:text-zinc-400 max-h-20 overflow-y-auto">
                {displayText(
                  tr.content.length > 300 ? tr.content.substring(0, 300) + '...' : tr.content
                )}
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
