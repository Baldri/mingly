/**
 * The guard inside the agent loop.
 *
 * The pre-flight guard sees the conversation history and the task — content a
 * human typed. In a ReAct loop the *machine* reads too: every tool result is
 * pushed into `messages`, and every later sendMessageWithTools call ships the
 * grown stack to the provider. None of that passed a guard before this file.
 *
 * No new guard logic lives here. This is orchestration over request-guard:
 * `guardInput` once per result, `guardDispatch` once for the step. Dependencies
 * arrive as GuardDeps, so the file stays unit-testable without the Electron /
 * model module graph — same arrangement as request-guard.ts itself.
 */
import {
  guardDispatch,
  guardInput,
  type GuardDeps,
  type SensitiveScan,
} from '../security/request-guard'
import type { CodingRunOptions } from '../../shared/coding-types'
import type { AgentToolResult } from '../../shared/types'

/** Where a tool result came from — for the reason text and for Task 5's consent dialog. */
export interface ToolResultOrigin {
  toolName: string
  /** Only coding tools know a path; `undefined` for everything else. */
  filePath?: string
}

export type LoopGuardOutcome =
  | { kind: 'ok'; provider: string }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'consent'
      index: number
      origin: ToolResultOrigin
      scanResult: SensitiveScan
      request: unknown
    }

/**
 * What the guard needs to know about the step it is guarding.
 *
 * `coding` decides one thing only: a coding run must not be re-routed to
 * another provider mid-run, so a routing/budget redirect ends the run instead
 * of switching. Every other check runs for every agent run — comparison and
 * subagent runs push tool results to a provider just as unguarded.
 */
export interface LoopGuardContext {
  provider: string
  model: string
  conversationId?: string
  coding?: CodingRunOptions
}

function describeOrigin(origin: ToolResultOrigin | undefined): string {
  if (!origin) return 'a tool result'
  return origin.filePath ? `${origin.toolName} (${origin.filePath})` : origin.toolName
}

/**
 * Guard the tool results of ONE loop step before they reach the provider.
 *
 * Call this after executeToolCalls and BEFORE compaction: compaction replaces a
 * large result with a reference plus a raw 200-character preview, and that
 * preview is the part that travels. Guarding afterwards would check the part
 * that no longer goes out and pass the part that does.
 */
export async function guardToolResults(
  results: readonly AgentToolResult[],
  origins: readonly ToolResultOrigin[],
  ctx: LoopGuardContext,
  deps: GuardDeps,
): Promise<LoopGuardOutcome> {
  // One guardInput call per result. guardInput sanitizes only the LAST element
  // of `texts` (request-guard.ts:53), so handing it three results as one array
  // would leave two of them un-scanned for injection — and injection inside a
  // file the agent read itself is the central coding threat.
  for (let i = 0; i < results.length; i++) {
    const origin = origins[i]
    const outcome = await guardInput(
      {
        texts: [results[i].content],
        provider: ctx.provider,
        model: ctx.model,
        conversationId: ctx.conversationId,
      },
      deps,
    )

    if (outcome.kind === 'injection') {
      return {
        kind: 'blocked',
        reason: `Prompt injection detected in the result of ${describeOrigin(origin)} (risk ${outcome.riskScore}).`,
      }
    }
    if (outcome.kind === 'sensitive-denied') {
      return {
        kind: 'blocked',
        reason: `${outcome.reason} Source: ${describeOrigin(origin)}.`,
      }
    }
    if (outcome.kind === 'consent') {
      return {
        kind: 'consent',
        index: i,
        origin: origin ?? { toolName: 'unknown' },
        scanResult: outcome.scanResult,
        request: outcome.request,
      }
    }
  }

  // One guardDispatch call for the whole new content of this step. The progress
  // recitation the executor appends afterwards is built from step numbers and
  // tool names only (buildProgressRecitation never reads result content), so
  // the tool names are included here to cover it.
  const dispatch = guardDispatch(
    {
      texts: [...results.map((r) => r.content), origins.map((o) => o.toolName).join(', ')],
      provider: ctx.provider,
      model: ctx.model,
      conversationId: ctx.conversationId,
    },
    deps,
  )

  if (!dispatch.ok) {
    return { kind: 'blocked', reason: dispatch.reason ?? 'Blocked by the dispatch guard.' }
  }

  if (dispatch.provider !== ctx.provider && ctx.coding) {
    return {
      kind: 'blocked',
      reason:
        `Collected content would be re-routed from ${ctx.provider} to ${dispatch.provider}; ` +
        'a coding run does not switch providers mid-run.',
    }
  }

  return { kind: 'ok', provider: dispatch.provider }
}
