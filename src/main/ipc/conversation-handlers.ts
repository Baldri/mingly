/**
 * IPC Handlers — Conversation & Settings Management
 */

import { IPC_CHANNELS } from '../../shared/types'
import type { AppSettings } from '../../shared/types'
import { ConversationModel } from '../database/models/conversation'
import { MessageModel } from '../database/models/message'
import { SimpleStore } from '../utils/simple-store'
import { getFeatureGateManager } from '../services/feature-gate-manager'
import { wrapHandler, requirePermission, requireFeature } from './ipc-utils'

export function registerConversationHandlers(): void {
  const store = SimpleStore.create()

  // ========================================
  // Conversation Management
  // ========================================

  wrapHandler(IPC_CHANNELS.CREATE_CONVERSATION, (title: string, provider: string, model: string) => {
    // Enforce daily conversation limit for Free tier
    const gate = getFeatureGateManager()
    const convLimit = gate.checkConversationLimit()
    if (!convLimit.allowed) {
      throw new Error(convLimit.reason || 'Daily conversation limit reached')
    }
    gate.recordConversation()

    // Gate cloud APIs for Free tier (only local/ollama allowed)
    if (provider !== 'local') {
      requireFeature('cloud_apis')
    }

    const conversation = ConversationModel.create(title, provider, model)
    return { success: true, conversation }
  })

  wrapHandler(IPC_CHANNELS.GET_CONVERSATIONS, () => {
    return { success: true, conversations: ConversationModel.findAll() }
  })

  wrapHandler(IPC_CHANNELS.GET_CONVERSATION, (conversationId: string) => {
    const conversation = ConversationModel.findById(conversationId)
    if (!conversation) return { success: false, error: 'Conversation not found' }
    return { success: true, conversation, messages: MessageModel.findByConversation(conversationId) }
  })

  wrapHandler(IPC_CHANNELS.DELETE_CONVERSATION, (conversationId: string) => {
    requirePermission('chat.delete')
    MessageModel.deleteByConversation(conversationId)
    ConversationModel.delete(conversationId)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.UPDATE_CONVERSATION, (conversationId: string, updates: { title?: string }) => {
    ConversationModel.update(conversationId, updates)
    return { success: true }
  })

  // ========================================
  // Settings Management
  // ========================================

  wrapHandler(IPC_CHANNELS.GET_SETTINGS, () => {
    const settings = (store.get('settings') || {
      theme: 'system',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-3-5-sonnet-20241022',
      enableParallelMode: false,
      enableCostTracking: true,
      enableAuditLog: true
    }) as AppSettings
    return { success: true, settings }
  })

  wrapHandler(IPC_CHANNELS.UPDATE_SETTINGS, (settings: Partial<AppSettings>) => {
    requirePermission('settings.general')
    const currentSettings = (store.get('settings') || {}) as AppSettings
    const merged = { ...currentSettings, ...settings }
    store.set('settings', merged)
    return { success: true, settings: merged }
  })
}
