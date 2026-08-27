/**
 * The delegation path must pass the same guard as every other path that
 * sends content to an LLM.
 *
 * Measured 2026-08-27: executeDelegation handed subTask.content — the user's
 * own text — straight to clientManager.sendMessageNonStreaming, and neither
 * the orchestrator nor its IPC handler called any guard. `requireFeature`
 * gates the licence, not the content. That bypassed the injection scan, the
 * sensitive-data consent, the budget check, the trust routing, the residency
 * policy and the audit trail at once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock factories are hoisted above the file body, so anything they close
// over has to be hoisted too — otherwise the factory runs before the const is
// initialised.
const { sendMessageNonStreaming, routeCalls, preflightGuard } = vi.hoisted(() => ({
  sendMessageNonStreaming: vi.fn(async () => 'Delegated response content'),
  routeCalls: [] as Array<{ content: string; providers: string[] }>,
  preflightGuard: vi.fn(async () => ({ ok: true, provider: 'anthropic', warnings: [] }))
}))

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    getProvidersWithApiKeys: vi.fn(() => ['anthropic', 'openai', 'google', 'ollama', 'local']),
    sendMessageNonStreaming
  }))
}))

vi.mock('../../src/main/routing/intelligent-router', () => ({
  getRouter: vi.fn(() => ({
    route: vi.fn(async (content: string, providers: string[]) => {
      routeCalls.push({ content, providers })
      return { suggestedProvider: 'anthropic', confidence: 0.9, category: 'code', reasoning: 'Code task' }
    })
  }))
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn(() => `test-${Math.random().toString(36).slice(2, 10)}`)
}))

vi.mock('../../src/main/security/request-guard', () => ({ preflightGuard }))
vi.mock('../../src/main/security/request-guard-deps', () => ({ getGuardDeps: vi.fn(() => ({})) }))

import { HybridOrchestrator } from '../../src/main/routing/hybrid-orchestrator'

const MESSAGE = '1. Schreibe eine Funktion zum Sortieren.\n2. Erklaere den Algorithmus dahinter.'

async function approvedProposal(orchestrator: HybridOrchestrator) {
  const proposal = await orchestrator.analyzeForDelegation(MESSAGE, 'openai', 'gpt-4')
  expect(proposal).not.toBeNull()
  orchestrator.approveProposal(proposal!.id)
  return proposal!
}

describe('delegation runs the shared guard', () => {
  let orchestrator: HybridOrchestrator

  beforeEach(() => {
    orchestrator = new HybridOrchestrator()
    routeCalls.length = 0
    sendMessageNonStreaming.mockClear()
    preflightGuard.mockClear()
    preflightGuard.mockResolvedValue({ ok: true, provider: 'anthropic', warnings: [] })
  })

  it('sends nothing when the guard refuses', async () => {
    const proposal = await approvedProposal(orchestrator)
    preflightGuard.mockResolvedValue({
      ok: false, provider: 'anthropic', blockedKind: 'routing',
      reason: 'Content at protection level "high" may not go to "anthropic".', warnings: []
    } as never)

    const result = await orchestrator.executeDelegation(proposal.id)

    // The whole point: refused means NOT SENT, not "sent and flagged".
    expect(sendMessageNonStreaming).not.toHaveBeenCalled()
    expect(result?.subTaskResults.every((r) => /may not go to/.test(r.response))).toBe(true)
  })

  it('sends to the provider the guard settled on, not the one proposed', async () => {
    const proposal = await approvedProposal(orchestrator)
    preflightGuard.mockResolvedValue({ ok: true, provider: 'ollama', warnings: [] } as never)

    await orchestrator.executeDelegation(proposal.id)

    expect(sendMessageNonStreaming).toHaveBeenCalled()
    for (const call of sendMessageNonStreaming.mock.calls) {
      expect((call as unknown[])[0]).toBe('ollama')
    }
  })

  it('records the provider that actually received the sub-task', async () => {
    const proposal = await approvedProposal(orchestrator)
    preflightGuard.mockResolvedValue({ ok: true, provider: 'ollama', warnings: [] } as never)

    const result = await orchestrator.executeDelegation(proposal.id)

    // An audit or cost trail naming the proposed provider instead of the one
    // that was used would be wrong in exactly the way that matters.
    expect(result?.subTaskResults.every((r) => r.provider === 'ollama')).toBe(true)
  })

  it('guards every sub-task, not just the first', async () => {
    const proposal = await approvedProposal(orchestrator)
    expect(proposal.subTasks.length).toBeGreaterThan(1)

    await orchestrator.executeDelegation(proposal.id)

    expect(preflightGuard).toHaveBeenCalledTimes(proposal.subTasks.length)
  })

  it('still sends when the guard allows', async () => {
    const proposal = await approvedProposal(orchestrator)

    const result = await orchestrator.executeDelegation(proposal.id)

    expect(sendMessageNonStreaming).toHaveBeenCalled()
    expect(result?.subTaskResults.every((r) => r.response === 'Delegated response content')).toBe(true)
  })
})

describe('delegation candidates', () => {
  it('no longer excludes local providers from the candidate set', async () => {
    // They were filtered out before routing, so a sub-task the policy would
    // only permit on-device had nowhere to go and delegation simply refused.
    routeCalls.length = 0
    const orchestrator = new HybridOrchestrator()

    await orchestrator.analyzeForDelegation(MESSAGE, 'openai', 'gpt-4')

    expect(routeCalls.length).toBeGreaterThan(0)
    expect(routeCalls[0].providers).toContain('ollama')
    // The provider the user is already talking to stays excluded — there is
    // nothing to delegate to yourself.
    expect(routeCalls[0].providers).not.toContain('openai')
  })
})
