import { create } from 'zustand'
import type { Conversation, Message, MessageAttachment, SafetyWarning } from '../../shared/types'
import { generateId } from '../utils/id-generator'
import type { UploadPermissionRequest } from '../../shared/privacy-types'
import type { RiskLevel } from '../../shared/privacy-types'
import { usePrivacyStore } from './privacy-store'

interface SensitiveDataConsentState {
  isOpen: boolean
  request: UploadPermissionRequest | null
  matches: Array<{
    type: string
    value: string
    riskLevel: RiskLevel
  }>
  /** Message content to retry after consent is granted */
  pendingMessage: string | null
  pendingAttachments: MessageAttachment[] | null
}

interface ChatState {
  conversations: Conversation[]
  currentConversation: Conversation | null
  messages: Message[]
  isStreaming: boolean
  streamingContent: string
  error: string | null

  /**
   * What the guards said about THIS turn — a provider fallback, a
   * circuit-breaker limit, an output violation, a canary leak.
   *
   * Per turn, not cumulative: a warning about the turn before it would read as
   * a warning about the answer on screen. Cleared when the next message is sent.
   */
  safetyWarnings: SafetyWarning[]

  // Sensitive Data Consent
  sensitiveDataConsent: SensitiveDataConsentState

  // Actions
  loadConversations: () => Promise<void>
  createConversation: (
    title: string,
    provider: string,
    model: string,
    templateId?: string,
    projectId?: string,
    ragCollectionName?: string
  ) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  sendMessage: (content: string, attachments?: MessageAttachment[]) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  pendingMetadata: any | null
  appendStreamChunk: (chunk: string) => void
  completeStreaming: () => Promise<void> | void
  setPendingMetadata: (metadata: any) => void
  setError: (error: string | null) => void
  dismissSafetyWarning: (index: number) => void

  // Sensitive Data Consent Actions
  showSensitiveDataConsent: (request: UploadPermissionRequest, matches: any[]) => void
  hideSensitiveDataConsent: () => void
  handleConsentGranted: (rememberChoice: boolean) => Promise<void>
  handleConsentDenied: (rememberChoice: boolean) => Promise<void>
  handleUseLocalLLM: (rememberChoice: boolean) => Promise<void>
}

/**
 * The live `message:safety-warning` subscription, so a new turn replaces it
 * instead of adding to it. One per store, not per send.
 */
let unsubscribeSafetyWarning: (() => void) | null = null

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversation: null,
  messages: [],
  isStreaming: false,
  streamingContent: '',
  error: null,
  pendingMetadata: null,
  safetyWarnings: [],

  // Sensitive Data Consent State
  sensitiveDataConsent: {
    isOpen: false,
    request: null,
    matches: [],
    pendingMessage: null,
    pendingAttachments: null
  },

  loadConversations: async () => {
    try {
      const result = await window.electronAPI.conversations.list()
      if (result.success) {
        set({ conversations: result.conversations })
      }
    } catch (error) {
      console.error('Failed to load conversations:', error)
      set({ error: 'Failed to load conversations' })
    }
  },

  createConversation: async (
    title: string, provider: string, model: string,
    templateId?: string, projectId?: string, ragCollectionName?: string
  ) => {
    try {
      const result = await window.electronAPI.conversations.create(
        title,
        provider,
        model,
        templateId,
        projectId,
        ragCollectionName
      )
      if (result.success && result.conversation) {
        set((state) => ({
          conversations: [result.conversation, ...state.conversations],
          currentConversation: result.conversation,
          messages: []
        }))
      }
    } catch (error) {
      console.error('Failed to create conversation:', error)
      set({ error: 'Failed to create conversation' })
    }
  },

  selectConversation: async (id: string) => {
    try {
      const result = await window.electronAPI.conversations.get(id)
      if (result.success && result.conversation) {
        set({
          currentConversation: result.conversation,
          messages: result.conversation.messages || []
        })
      }
    } catch (error) {
      console.error('Failed to load conversation:', error)
      set({ error: 'Failed to load conversation' })
    }
  },

  sendMessage: async (content: string, attachments?: MessageAttachment[]) => {
    console.log('[ChatStore] sendMessage called with:', content, attachments?.length ? `(${attachments.length} attachments)` : '')
    const { currentConversation, messages } = get()

    if (!currentConversation) {
      console.error('[ChatStore] No conversation selected!')
      set({ error: 'No conversation selected' })
      return
    }

    console.log('[ChatStore] Current conversation:', {
      id: currentConversation.id,
      provider: currentConversation.provider,
      model: currentConversation.model
    })

    // Add user message optimistically
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content,
      tokensUsed: 0,
      ...(attachments?.length ? { attachments } : {})
    }

    set({
      messages: [...messages, userMessage],
      isStreaming: true,
      streamingContent: '',
      error: null,
      // The previous turn's warnings do not describe this one.
      safetyWarnings: []
    })

    try {
      // Setup stream chunk listeners
      console.log('[ChatStore] Setting up stream listeners...')
      window.electronAPI.onMessageChunk((chunk: string) => {
        console.log('[ChatStore] Received chunk:', chunk.substring(0, 50))
        get().appendStreamChunk(chunk)
      })

      window.electronAPI.onMessageComplete(() => {
        console.log('[ChatStore] Message complete!')
        void get().completeStreaming()
      })

      window.electronAPI.onMessageError((errorMsg: string) => {
        console.error('[ChatStore] Message error:', errorMsg)
        set({ error: errorMsg, isStreaming: false })
      })

      // Guard warnings for this turn. The main process sends these before the
      // LLM call (provider fallback, circuit breaker) and after it (output
      // violations, canary leak); until the preload bridged the channel they
      // went nowhere.
      //
      // Unlike the four listeners above, this one drops its predecessor. They
      // are re-registered on every send and nothing ever removes them, so they
      // accumulate: measured on the second send, ONE chunk event appended its
      // text twice. Keeping that pattern here would show every warning once per
      // message already sent in the conversation.
      unsubscribeSafetyWarning?.()
      unsubscribeSafetyWarning =
        window.electronAPI.onMessageSafetyWarning?.((warning: SafetyWarning) => {
          console.warn('[ChatStore] Safety warning:', warning.type)
          set({ safetyWarnings: [...get().safetyWarnings, warning] })
        }) ?? null

      // Listen for permission required
      window.electronAPI.onMessagePermissionRequired?.((data: any) => {
        console.log('[ChatStore] Permission required:', data)
        get().showSensitiveDataConsent(data.request, data.matches)
        set({ isStreaming: false })
      })

      // Privacy: Anonymize user message content before sending to LLM
      const privacyState = usePrivacyStore.getState()
      let messagesForLLM = [...messages, userMessage]
      if (privacyState.enabled && privacyState.mode !== 'transparent') {
        try {
          const anonResult = await window.electronAPI.privacy.anonymize(
            currentConversation.id,
            content
          )
          if (anonResult?.anonymizedText && anonResult.stats?.anonymized > 0) {
            // Replace user message content with anonymized version for the LLM
            const anonUserMessage = { ...userMessage, content: anonResult.anonymizedText }
            messagesForLLM = [...messages, anonUserMessage]
            privacyState.incrementAnonymized(anonResult.stats.anonymized)
            console.log(`[Privacy] Anonymized ${anonResult.stats.anonymized} PII entities (mode: ${anonResult.mode})`)
          }
        } catch (err) {
          console.warn('[Privacy] Anonymization failed, sending original:', err)
        }
      }

      // Send message
      console.log('[ChatStore] Calling electronAPI.llm.sendMessage...')
      const result = await window.electronAPI.llm.sendMessage(
        currentConversation.id,
        messagesForLLM,
        currentConversation.provider,
        currentConversation.model
      )

      console.log('[ChatStore] Send result:', result)

      if (result.success) {
        // Store metadata so completeStreaming can attach it to the assistant message
        get().setPendingMetadata(result)
      } else {
        console.error('[ChatStore] Send failed:', result.error)
        set({ error: result.error || 'Failed to send message', isStreaming: false })
      }
    } catch (error) {
      console.error('[ChatStore] Failed to send message:', error)
      set({ error: 'Failed to send message', isStreaming: false })
    }
  },

  deleteConversation: async (id: string) => {
    try {
      const result = await window.electronAPI.conversations.delete(id)
      if (result.success) {
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          currentConversation:
            state.currentConversation?.id === id
              ? null
              : state.currentConversation,
          messages: state.currentConversation?.id === id ? [] : state.messages
        }))
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error)
      set({ error: 'Failed to delete conversation' })
    }
  },

  appendStreamChunk: (chunk: string) => {
    set((state) => ({
      streamingContent: state.streamingContent + chunk
    }))
  },

  setPendingMetadata: (metadata: any) => {
    set({ pendingMetadata: metadata })
  },

  completeStreaming: async () => {
    const { streamingContent, messages, pendingMetadata, currentConversation } = get()

    // Privacy: Rehydrate assistant response (replace fake data back with originals)
    let finalContent = streamingContent
    const privacyState = usePrivacyStore.getState()
    if (privacyState.enabled && currentConversation) {
      try {
        const rehydResult = await window.electronAPI.privacy.rehydrate(
          currentConversation.id,
          streamingContent
        )
        if (rehydResult?.rehydratedText && rehydResult.replacementCount > 0) {
          finalContent = rehydResult.rehydratedText
          console.log(`[Privacy] Rehydrated ${rehydResult.replacementCount} PII replacements`)
        }
      } catch (err) {
        console.warn('[Privacy] Rehydration failed, showing original:', err)
      }
    }

    // Add assistant message with metadata if available
    const assistantMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: finalContent,
      tokens: pendingMetadata?.metadata?.totalTokens,
      cost: pendingMetadata?.metadata?.cost,
      provider: pendingMetadata?.metadata?.provider,
      model: pendingMetadata?.metadata?.model,
      latencyMs: pendingMetadata?.metadata?.latencyMs,
      ragSources: pendingMetadata?.ragSources
    }

    set({
      messages: [...messages, assistantMessage],
      isStreaming: false,
      streamingContent: '',
      pendingMetadata: null
    })
  },

  setError: (error: string | null) => {
    set({ error })
  },

  dismissSafetyWarning: (index: number) => {
    set({ safetyWarnings: get().safetyWarnings.filter((_, i) => i !== index) })
  },

  // Sensitive Data Consent Actions
  showSensitiveDataConsent: (request: UploadPermissionRequest, matches: any[]) => {
    // Capture the last user message so we can retry after consent
    const { messages } = get()
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    set({
      sensitiveDataConsent: {
        isOpen: true,
        request,
        matches,
        pendingMessage: lastUserMsg?.content ?? null,
        pendingAttachments: (lastUserMsg as any)?.attachments ?? null
      }
    })
  },

  hideSensitiveDataConsent: () => {
    set({
      sensitiveDataConsent: {
        isOpen: false,
        request: null,
        matches: [],
        pendingMessage: null,
        pendingAttachments: null
      }
    })
  },

  handleConsentGranted: async (rememberChoice: boolean) => {
    const { sensitiveDataConsent } = get()
    if (!sensitiveDataConsent.request) return

    try {
      // Grant permission via IPC
      await window.electronAPI.uploadPermission.grant(
        sensitiveDataConsent.request,
        rememberChoice
      )

      // Capture pending message before hiding (which clears it)
      const pendingMsg = get().sensitiveDataConsent.pendingMessage
      const pendingAtt = get().sensitiveDataConsent.pendingAttachments

      // Hide dialog
      get().hideSensitiveDataConsent()

      // Retry sending the original message now that permission is granted
      if (pendingMsg) {
        await get().sendMessage(pendingMsg, pendingAtt ?? undefined)
      }
    } catch (error) {
      console.error('Failed to grant permission:', error)
      set({ error: 'Failed to grant permission' })
    }
  },

  handleConsentDenied: async (rememberChoice: boolean) => {
    const { sensitiveDataConsent } = get()
    if (!sensitiveDataConsent.request) return

    try {
      // Deny permission via IPC
      await window.electronAPI.uploadPermission.deny(
        sensitiveDataConsent.request,
        rememberChoice
      )

      // Hide dialog
      get().hideSensitiveDataConsent()

      // Show error
      set({ error: 'Message cancelled - sensitive data detected' })
    } catch (error) {
      console.error('Failed to deny permission:', error)
      set({ error: 'Failed to deny permission' })
    }
  },

  handleUseLocalLLM: async (rememberChoice: boolean) => {
    const { sensitiveDataConsent, currentConversation } = get()
    if (!sensitiveDataConsent.request || !currentConversation) return

    try {
      // Deny cloud upload
      await window.electronAPI.uploadPermission.deny(
        sensitiveDataConsent.request,
        rememberChoice
      )

      // Capture pending message before hiding (which clears it)
      const pendingMsg = get().sensitiveDataConsent.pendingMessage
      const pendingAtt = get().sensitiveDataConsent.pendingAttachments
      const { currentConversation } = get()

      // Hide dialog
      get().hideSensitiveDataConsent()

      // Switch conversation to local Ollama provider and retry
      if (currentConversation && pendingMsg) {
        try {
          await window.electronAPI.conversations.update(currentConversation.id, {
            provider: 'ollama',
            model: 'llama3.2'
          })
          set({
            currentConversation: {
              ...currentConversation,
              provider: 'ollama',
              model: 'llama3.2'
            }
          })
          await get().sendMessage(pendingMsg, pendingAtt ?? undefined)
        } catch {
          set({ error: 'Failed to switch to local LLM. Make sure Ollama is running.' })
        }
      } else {
        set({ error: 'Please switch to a local LLM provider and try again' })
      }
    } catch (error) {
      console.error('Failed to switch to local LLM:', error)
      set({ error: 'Failed to switch to local LLM' })
    }
  }
}))
