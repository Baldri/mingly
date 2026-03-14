/**
 * Chat Store — Privacy Integration Tests
 * Tests the anonymization/rehydration flow in sendMessage/completeStreaming.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mingly-ci-test' }
}))

// Track what was sent to the LLM
let lastSentMessages: any[] = []

const mockElectronAPI = {
  llm: {
    sendMessage: vi.fn(async (_convId: string, messages: any[]) => {
      lastSentMessages = messages
      return { success: true, metadata: { totalTokens: 100 } }
    })
  },
  conversations: {
    list: vi.fn().mockResolvedValue({ success: true, conversations: [] }),
    get: vi.fn().mockResolvedValue({ success: true, messages: [] })
  },
  privacy: {
    anonymize: vi.fn().mockResolvedValue({
      anonymizedText: 'Mail: thomas.mueller@gmail.com',
      replacements: [{ entity: { category: 'EMAIL', original: 'hans@test.ch' }, replacement: 'thomas.mueller@gmail.com' }],
      mode: 'shield',
      stats: { detected: 1, anonymized: 1, kept: 0 }
    }),
    rehydrate: vi.fn().mockResolvedValue({
      rehydratedText: 'Antwort fuer hans@test.ch',
      replacementCount: 1,
      attempted: true
    }),
    getMode: vi.fn().mockResolvedValue({ mode: 'shield' }),
    setMode: vi.fn().mockResolvedValue({ success: true }),
    detectPII: vi.fn().mockResolvedValue({ entities: [] }),
    clearSession: vi.fn().mockResolvedValue({ success: true }),
    getSessionMappings: vi.fn().mockResolvedValue({ mappings: [] })
  },
  onMessageChunk: vi.fn().mockReturnValue(() => {}),
  onMessageComplete: vi.fn().mockReturnValue(() => {}),
  onMessageError: vi.fn().mockReturnValue(() => {}),
  onMessagePermissionRequired: vi.fn().mockReturnValue(() => {})
}

vi.stubGlobal('window', { electronAPI: mockElectronAPI })

// Import stores AFTER mocking
const { usePrivacyStore } = await import('../../src/renderer/stores/privacy-store')
const { useChatStore } = await import('../../src/renderer/stores/chat-store')

describe('Chat Store — Privacy Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastSentMessages = []

    // Reset privacy store
    usePrivacyStore.setState({
      mode: 'shield',
      sessionId: null,
      preview: null,
      enabled: true,
      sessionAnonymizedCount: 0,
      loading: false
    })

    // Set up a conversation in chat store
    useChatStore.setState({
      currentConversation: {
        id: 'conv-1',
        title: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        createdAt: Date.now(),
        updatedAt: Date.now()
      } as any,
      messages: [],
      isStreaming: false,
      streamingContent: '',
      error: null,
      pendingMetadata: null
    })
  })

  describe('sendMessage anonymization', () => {
    it('should anonymize user message before sending to LLM', async () => {
      await useChatStore.getState().sendMessage('Mail: hans@test.ch')

      // Privacy API should have been called
      expect(mockElectronAPI.privacy.anonymize).toHaveBeenCalledWith('conv-1', 'Mail: hans@test.ch')

      // LLM should receive anonymized content
      const sentUserMsg = lastSentMessages[lastSentMessages.length - 1]
      expect(sentUserMsg.content).toBe('Mail: thomas.mueller@gmail.com')

      // Privacy store should be updated
      expect(usePrivacyStore.getState().sessionAnonymizedCount).toBe(1)
    })

    it('should show original message to user (not anonymized)', async () => {
      await useChatStore.getState().sendMessage('Mail: hans@test.ch')

      // User-facing messages should contain the original
      const messages = useChatStore.getState().messages
      const userMsg = messages.find(m => m.role === 'user')
      expect(userMsg?.content).toBe('Mail: hans@test.ch')
    })

    it('should skip anonymization when privacy is disabled', async () => {
      usePrivacyStore.setState({ enabled: false })
      await useChatStore.getState().sendMessage('Mail: hans@test.ch')

      expect(mockElectronAPI.privacy.anonymize).not.toHaveBeenCalled()
    })

    it('should skip anonymization in transparent mode', async () => {
      usePrivacyStore.setState({ mode: 'transparent' })
      await useChatStore.getState().sendMessage('Mail: hans@test.ch')

      expect(mockElectronAPI.privacy.anonymize).not.toHaveBeenCalled()
    })

    it('should fall back to original on anonymization error', async () => {
      mockElectronAPI.privacy.anonymize.mockRejectedValueOnce(new Error('fail'))
      await useChatStore.getState().sendMessage('Mail: hans@test.ch')

      // LLM should receive original content
      const sentUserMsg = lastSentMessages[lastSentMessages.length - 1]
      expect(sentUserMsg.content).toBe('Mail: hans@test.ch')
    })
  })

  describe('completeStreaming rehydration', () => {
    it('should rehydrate assistant response', async () => {
      // Simulate streaming completion
      useChatStore.setState({ streamingContent: 'Antwort fuer thomas.mueller@gmail.com', isStreaming: true })

      await useChatStore.getState().completeStreaming()

      // Privacy API should have been called
      expect(mockElectronAPI.privacy.rehydrate).toHaveBeenCalledWith(
        'conv-1',
        'Antwort fuer thomas.mueller@gmail.com'
      )

      // Assistant message should contain rehydrated content
      const messages = useChatStore.getState().messages
      const assistantMsg = messages.find(m => m.role === 'assistant')
      expect(assistantMsg?.content).toBe('Antwort fuer hans@test.ch')
    })

    it('should skip rehydration when privacy is disabled', async () => {
      usePrivacyStore.setState({ enabled: false })
      useChatStore.setState({ streamingContent: 'Some response', isStreaming: true })

      await useChatStore.getState().completeStreaming()

      expect(mockElectronAPI.privacy.rehydrate).not.toHaveBeenCalled()
    })

    it('should fall back to original on rehydration error', async () => {
      mockElectronAPI.privacy.rehydrate.mockRejectedValueOnce(new Error('fail'))
      useChatStore.setState({ streamingContent: 'Original response', isStreaming: true })

      await useChatStore.getState().completeStreaming()

      const messages = useChatStore.getState().messages
      const assistantMsg = messages.find(m => m.role === 'assistant')
      expect(assistantMsg?.content).toBe('Original response')
    })
  })
})
