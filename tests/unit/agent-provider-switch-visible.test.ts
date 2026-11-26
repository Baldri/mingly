/**
 * What the agent and coding path does when the preflight guard replaces the
 * provider the user chose.
 *
 * Before this change, agent-executor.ts read exactly three fields off the
 * preflight result — `ok`, `reason` and `provider` (lines 212, 214, 219) — and
 * `preflight.warnings` was never read anywhere in the file. So a budget or
 * routing fallback took effect in silence: the run continued on another
 * provider, the AgentRun carried no provider at all, and the only trace was a
 * console.log in the chat path plus an audit entry written AFTER the switch.
 *
 * Two things are pinned here:
 *   1. an on-device -> cloud switch ends the run (see guard-provider-switch
 *      .test.ts for why: the content was never scanned against the recipient),
 *   2. every other switch reaches the renderer BEFORE the first model call, and
 *      the finished run says which provider it actually ran on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentExecutor } from '../../src/main/agent/agent-executor'
import type { AgentEvent } from '../../src/main/agent/agent-executor'
import type { ToolUseResponse } from '../../src/main/llm-clients/client-manager'
import type { BudgetCheck, RoutingDecision } from '../../src/main/security/request-guard'

/** The ids this test treats as off-device. */
const CLOUD = new Set(['anthropic', 'openai'])
const ON_DEVICE = 'ollama'

/** Rewired per test, before `execute` is called. */
let budgetVerdict: BudgetCheck = { allowed: true }
let routingVerdict: RoutingDecision = { allowed: true }

vi.mock('../../src/main/security/request-guard-deps', () => ({
  getGuardDeps: () => ({
    sanitize: () => ({ safe: true, riskScore: 0, warnings: [] }),
    scanSensitive: () => ({ hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }),
    checkUploadPermission: async () => ({ decision: 'allowed', requiresUserConsent: false }),
    checkBudget: () => budgetVerdict,
    checkRouting: () => routingVerdict,
    isCloudProvider: (provider: string) => CLOUD.has(provider),
    scanOutput: () => ({ violations: [] })
  })
}))

/** Records the order of model calls against the order of emitted events. */
let llmCallCount = 0
const callLog: string[] = []

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    providerSupportsToolUse: vi.fn().mockReturnValue(true),
    sendMessageWithTools: vi.fn().mockImplementation(async (): Promise<ToolUseResponse> => {
      llmCallCount++
      callLog.push('llm')
      return {
        text: 'Final answer.',
        toolCalls: [],
        done: true,
        stopReason: 'stop' as const,
        tokens: { input: 10, output: 5 }
      }
    })
  }))
}))

vi.mock('../../src/main/agent/tool-registry', () => ({
  getToolRegistry: vi.fn(() => ({
    refreshMCPTools: vi.fn(),
    getAvailableTools: vi.fn().mockReturnValue([
      {
        name: 'search_docs',
        description: 'Search documents',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
      }
    ]),
    executeToolCalls: vi.fn().mockResolvedValue([])
  }))
}))

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => `test-${Math.random().toString(36).substring(7)}`)
}))

let executor: AgentExecutor
let events: AgentEvent[]

beforeEach(() => {
  vi.clearAllMocks()
  llmCallCount = 0
  callLog.length = 0
  budgetVerdict = { allowed: true }
  routingVerdict = { allowed: true }
  events = []
  executor = new AgentExecutor({ maxSteps: 3, maxTokensPerRun: 50000, runTimeoutMs: 10000 })
  executor.onEvent((event) => {
    events.push(event)
    if (event.type === 'guard_warning') callLog.push('guard_warning')
  })
})

describe('an on-device run is not quietly moved to the cloud', () => {
  it('ends the run on a routing fallback to a cloud provider, before any model call', async () => {
    routingVerdict = {
      allowed: false,
      suggestedProvider: 'anthropic',
      classification: { sensitivity: 'internal', reasons: ['forced for the test'] }
    }

    const run = await executor.execute('Wie ist das Wetter?', ON_DEVICE, 'qwen2.5')

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
    expect(run.error).toContain(ON_DEVICE)
    expect(run.error).toContain('anthropic')
  })

  it('ends the run on a budget fallback to a cloud provider too', async () => {
    budgetVerdict = { allowed: false, fallbackProvider: 'anthropic' }

    const run = await executor.execute('Wie ist das Wetter?', ON_DEVICE, 'qwen2.5')

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })

  it('does not report the cloud provider as the one the run used', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'anthropic' }

    const run = await executor.execute('Wie ist das Wetter?', ON_DEVICE, 'qwen2.5')

    expect(run.provider).toBe(ON_DEVICE)
  })
})

describe('a switch that stays off-device is reported, not swallowed', () => {
  it('emits a guard_warning before the first model call', async () => {
    routingVerdict = {
      allowed: false,
      suggestedProvider: 'openai',
      classification: { sensitivity: 'internal', reasons: ['residency'] }
    }

    await executor.execute('Wie ist das Wetter?', 'anthropic', 'claude-3-5-sonnet')

    expect(callLog[0]).toBe('guard_warning')
    expect(llmCallCount).toBe(1)
  })

  it('names the provider the user asked for and the one the guard chose', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'openai' }

    await executor.execute('Wie ist das Wetter?', 'anthropic', 'claude-3-5-sonnet')

    const warned = events.find((e) => e.type === 'guard_warning')
    expect(warned?.warnings?.[0]).toMatchObject({
      type: 'routing_fallback',
      requestedProvider: 'anthropic',
      provider: 'openai'
    })
  })

  it('the finished run says which provider it actually ran on', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'openai' }

    const run = await executor.execute('Wie ist das Wetter?', 'anthropic', 'claude-3-5-sonnet')

    expect(run.status).toBe('completed')
    expect(run.provider).toBe('openai')
    expect(run.requestedProvider).toBe('anthropic')
  })
})

describe('the ordinary case stays quiet', () => {
  it('a run nobody rerouted emits no guard_warning and reports its own provider', async () => {
    const run = await executor.execute('Wie ist das Wetter?', ON_DEVICE, 'qwen2.5')

    expect(run.status).toBe('completed')
    expect(events.some((e) => e.type === 'guard_warning')).toBe(false)
    expect(run.provider).toBe(ON_DEVICE)
    expect(run.requestedProvider).toBeUndefined()
  })
})

describe('a blocked run gives its concurrency slot back', () => {
  /**
   * Found by this file's own test ORDER, not by reading the code: the three
   * blocked runs above left the later ones failing with the breaker's
   * "Max concurrent agent runs reached", and each test passed on its own.
   *
   * `canStartAgentRun` adds the run to the breaker's set (circuit-breaker.ts
   * :320) and the `finally` that calls `endAgentRun` sits inside the try block
   * AFTER the preflight guard, so a guard block skipped it. The breaker is a
   * process-wide singleton, so the slots were gone until restart — and with
   * this change the block path is reachable in a new situation.
   */
  it('a run that follows blocked ones still starts', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'anthropic' }
    const limit = 8
    for (let i = 0; i < limit; i++) {
      const blocked = await executor.execute('Wie ist das Wetter?', ON_DEVICE, 'qwen2.5')
      expect(blocked.status).toBe('failed')
    }

    routingVerdict = { allowed: true }
    const run = await executor.execute('Wie ist das Wetter?', ON_DEVICE, 'qwen2.5')

    expect(run.error).toBeUndefined()
    expect(run.status).toBe('completed')
  })

  it('and it is not left behind as an active run', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'anthropic' }

    const run = await executor.execute('Wie ist das Wetter?', ON_DEVICE, 'qwen2.5')

    // The breaker is a process-wide singleton with a limit of 3, so this has to
    // say WHICH early return it measured. Without it, a run refused by a full
    // breaker takes the other early return — which also clears `activeRuns` —
    // and the assertion below would pass without the fix under test.
    expect(run.error).toContain('on-device')
    expect(executor.getActiveRunIds()).toEqual([])
  })
})
