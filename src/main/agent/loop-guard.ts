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
import type { AgentToolResult } from '../../shared/types'

/** Where a tool result came from — for the reason text and for Task 5's consent dialog. */
export interface ToolResultOrigin {
  toolName: string
  /** Only coding tools know a path; `undefined` for everything else. */
  filePath?: string
}

export type LoopGuardOutcome =
  // No provider field: a dispatch redirect is blocked rather than adopted, so
  // the run always continues on the provider it came in with. A field that can
  // only ever hold ctx.provider would invite the belief that it can hold more.
  | { kind: 'ok' }
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
 * It does not need to know the run type. Every check here runs for every agent
 * run: comparison and subagent runs push tool results to a provider just as
 * unguarded as a coding run does, and the dispatch refusal below holds for all
 * of them. File attribution travels through `origins`; a later task that
 * genuinely needs project context adds it in the commit that reads it.
 */
export interface LoopGuardContext {
  provider: string
  model: string
  conversationId?: string
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
 *
 * @param startIndex First result the INPUT phase runs over. A `consent`
 *   outcome hands the step back to the caller, which settles that one result
 *   and calls again from the next index; re-asking about a result the user has
 *   already decided would ask the same question forever. The dispatch phase
 *   below always runs over ALL results, so the content the user approved is
 *   still part of the budget and routing check. Nothing is skipped silently:
 *   the caller may only move the index past a result it has resolved, and a
 *   resolved result is either machine-written (the withheld notice) or
 *   anonymised text whose original already passed the injection scan — that
 *   scan runs before the sensitive branch in guardInput.
 */
export async function guardToolResults(
  results: readonly AgentToolResult[],
  origins: readonly ToolResultOrigin[],
  ctx: LoopGuardContext,
  deps: GuardDeps,
  startIndex = 0,
): Promise<LoopGuardOutcome> {
  // One guardInput call per result. guardInput sanitizes only the LAST element
  // of `texts` (request-guard.ts:53), so handing it three results as one array
  // would leave two of them un-scanned for injection — and injection inside a
  // file the agent read itself is the central coding threat.
  for (let i = startIndex; i < results.length; i++) {
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

  // No mid-run provider switch — for ANY run type, not just coding runs.
  // guardInput evaluated the sensitive-data scan and the upload-permission
  // branch against ctx.provider. Adopting a different provider here would send
  // content that was never checked against the provider that receives it: a run
  // on a local provider skips the whole sensitive branch (isCloudProvider
  // false), accumulates tool results, and a budget fallback to a cloud provider
  // would then ship the lot. Re-running both phases over the whole accumulated
  // stack on every switch is the opposite of incremental, so the run ends.
  //
  // The gate is "did dispatch have to fall back at all", not "is the provider
  // different". guardDispatch pushes a warning only for budget_fallback and
  // routing_fallback (request-guard.ts:105, :116), and both mean the original
  // dispatch was refused. Comparing providers would miss a budget fallback to
  // another provider that a routing suggestion then sends back: identical
  // provider in and out, yet its budget verdict was "not allowed".
  if (dispatch.warnings.length > 0) {
    const causes = dispatch.warnings
      .filter((w) => w.type === 'budget_fallback' || w.type === 'routing_fallback')
      .map((w) => (w.type === 'budget_fallback' ? 'budget' : 'routing'))
    const cause = causes.length > 0 ? `${causes.join(' and ')} fallback` : 'a dispatch fallback'
    const landing =
      dispatch.provider === ctx.provider
        ? `it came back to ${ctx.provider} only through a further fallback`
        : `the content would move to ${dispatch.provider}`
    return {
      kind: 'blocked',
      reason:
        `Dispatch refused ${ctx.provider} as-is for the collected content (${cause}): ` +
        `${landing}. The content was only ever checked against ${ctx.provider}, so the run ends ` +
        'instead of switching providers mid-run.',
    }
  }

  return { kind: 'ok' }
}
