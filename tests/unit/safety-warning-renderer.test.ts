/**
 * The renderer end of the two warning channels.
 *
 * A bridged channel nobody listens on is just as silent as an unbridged one:
 * the string `safety-warning` did not appear anywhere in src/renderer, and the
 * agent store handled only `step_start`, `step_complete` and `run_complete`
 * (agent-store.ts:209-232). Both halves are asserted against STATE, not
 * against a rendered DOM — the banner reads this state, and a store that never
 * holds the warning cannot show it however the component is written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mingly-safety-warning-test' }
}))

/** Callbacks the store registered, so the test can fire the channel. */
let safetyWarningCallbacks: ((warning: unknown) => void)[] = []

const mockElectronAPI = {
  llm: {
    sendMessage: vi.fn(async () => ({ success: true, metadata: { totalTokens: 10 } }))
  },
  conversations: {
    list: vi.fn().mockResolvedValue({ success: true, conversations: [] }),
    get: vi.fn().mockResolvedValue({ success: true, messages: [] })
  },
  privacy: {
    anonymize: vi.fn().mockResolvedValue({ anonymizedText: '', stats: { anonymized: 0 } }),
    rehydrate: vi.fn().mockResolvedValue({ rehydratedText: '', replacementCount: 0, attempted: false })
  },
  onMessageChunk: vi.fn().mockReturnValue(() => {}),
  onMessageComplete: vi.fn().mockReturnValue(() => {}),
  onMessageError: vi.fn().mockReturnValue(() => {}),
  onMessagePermissionRequired: vi.fn().mockReturnValue(() => {}),
  onMessageSafetyWarning: vi.fn((callback: (warning: unknown) => void) => {
    safetyWarningCallbacks.push(callback)
    return () => {
      safetyWarningCallbacks = safetyWarningCallbacks.filter((c) => c !== callback)
    }
  })
}

vi.stubGlobal('window', { electronAPI: mockElectronAPI })

const { useChatStore } = await import('../../src/renderer/stores/chat-store')
const { useAgentStore } = await import('../../src/renderer/stores/agent-store')

const FALLBACK_WARNING = {
  type: 'fallback_triggered',
  level: 'warning' as const,
  message: 'Content classified as "internal" — routed to openai.',
  details: { requestedProvider: 'anthropic', provider: 'openai', reasons: ['residency'] }
}

describe('chat store collects the safety warnings the main process sends', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    safetyWarningCallbacks = []
    useChatStore.setState({
      currentConversation: {
        id: 'conv-1',
        title: 'Test',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        createdAt: Date.now(),
        updatedAt: Date.now()
      } as never,
      messages: [],
      isStreaming: false,
      streamingContent: '',
      error: null,
      safetyWarnings: []
    })
  })

  it('starts empty', () => {
    expect(useChatStore.getState().safetyWarnings).toEqual([])
  })

  it('subscribes to the channel when a message is sent', async () => {
    await useChatStore.getState().sendMessage('Hallo')

    expect(mockElectronAPI.onMessageSafetyWarning).toHaveBeenCalled()
  })

  it('keeps a warning that arrives on the channel', async () => {
    await useChatStore.getState().sendMessage('Hallo')

    safetyWarningCallbacks.forEach((cb) => cb(FALLBACK_WARNING))

    expect(useChatStore.getState().safetyWarnings).toEqual([FALLBACK_WARNING])
  })

  it('drops the warnings of the previous turn when a new message is sent', async () => {
    await useChatStore.getState().sendMessage('Hallo')
    safetyWarningCallbacks.forEach((cb) => cb(FALLBACK_WARNING))
    expect(useChatStore.getState().safetyWarnings).toHaveLength(1)

    await useChatStore.getState().sendMessage('Und nochmal')

    expect(useChatStore.getState().safetyWarnings).toEqual([])
  })

  it('does not show the same warning once per message already sent', async () => {
    // The store's four existing stream listeners are re-registered on every
    // send and never removed, so they accumulate — measured: on the second
    // send, ONE chunk event appended its text twice. This channel drops its
    // predecessor, so a warning arriving after three sends is stored once.
    await useChatStore.getState().sendMessage('eins')
    await useChatStore.getState().sendMessage('zwei')
    await useChatStore.getState().sendMessage('drei')

    safetyWarningCallbacks.forEach((cb) => cb(FALLBACK_WARNING))

    expect(useChatStore.getState().safetyWarnings).toEqual([FALLBACK_WARNING])
  })

  it('lets the user dismiss one without losing the others', async () => {
    await useChatStore.getState().sendMessage('Hallo')
    const second = { ...FALLBACK_WARNING, type: 'output_violations' }
    safetyWarningCallbacks.forEach((cb) => {
      cb(FALLBACK_WARNING)
      cb(second)
    })
    expect(useChatStore.getState().safetyWarnings).toHaveLength(2)

    useChatStore.getState().dismissSafetyWarning(0)

    expect(useChatStore.getState().safetyWarnings).toEqual([second])
  })
})

describe('agent store surfaces the guard warning of a run', () => {
  beforeEach(() => {
    useAgentStore.setState({
      isRunning: false,
      currentRun: null,
      currentSteps: [],
      guardWarnings: [],
      error: null
    })
  })

  it('positive control: it still handles a run_complete event', () => {
    useAgentStore.getState().handleAgentEvent({
      type: 'run_complete',
      runId: 'run-1',
      run: {
        id: 'run-1',
        conversationId: 'conv-1',
        task: 'x',
        steps: [],
        status: 'completed',
        provider: 'openai',
        totalTokens: { input: 1, output: 1 },
        totalCost: 0,
        durationMs: 1,
        createdAt: Date.now()
      }
    })

    expect(useAgentStore.getState().currentRun?.id).toBe('run-1')
    expect(useAgentStore.getState().isRunning).toBe(false)
  })

  it('keeps the warnings of a guard_warning event', () => {
    useAgentStore.getState().handleAgentEvent({
      type: 'guard_warning',
      runId: 'run-2',
      warnings: [
        {
          type: 'routing_fallback',
          message: 'routed to openai',
          requestedProvider: 'anthropic',
          provider: 'openai',
          reasons: ['residency']
        }
      ]
    })

    expect(useAgentStore.getState().guardWarnings).toHaveLength(1)
    expect(useAgentStore.getState().guardWarnings[0]).toMatchObject({
      requestedProvider: 'anthropic',
      provider: 'openai'
    })
  })

  it('clears them with the run, so the next run does not inherit them', () => {
    useAgentStore.getState().handleAgentEvent({
      type: 'guard_warning',
      runId: 'run-3',
      warnings: [{ type: 'budget_fallback', message: 'anthropic -> openai' }]
    })
    expect(useAgentStore.getState().guardWarnings).toHaveLength(1)

    useAgentStore.getState().clearCurrentRun()

    expect(useAgentStore.getState().guardWarnings).toEqual([])
  })
})
