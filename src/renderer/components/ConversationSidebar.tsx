import React, { useState, useEffect, useCallback, memo } from 'react'
import { Plus, MessageSquare, Trash2, Crown } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import { useSubscriptionStore } from '../stores/subscription-store'
import { ConfirmDialog } from './ConfirmDialog'

export const ConversationSidebar = memo(function ConversationSidebar() {
  const conversations = useChatStore((state) => state.conversations)
  const currentConversation = useChatStore((state) => state.currentConversation)
  const loadConversations = useChatStore((state) => state.loadConversations)
  const selectConversation = useChatStore((state) => state.selectConversation)
  const deleteConversation = useChatStore((state) => state.deleteConversation)

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const handleDelete = useCallback((id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    setPendingDeleteId(id)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (pendingDeleteId) {
      await deleteConversation(pendingDeleteId)
      setPendingDeleteId(null)
    }
  }, [pendingDeleteId, deleteConversation])

  const handleNewChat = useCallback(() => {
    const event = new CustomEvent('open-new-conversation')
    window.dispatchEvent(event)
  }, [])

  return (
    <div className="w-64 border-r border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col">
      {/* pt-10 on macOS: push below traffic lights (titleBarStyle: hiddenInset)
          pt-4 on Windows/Linux: standard spacing (OS-native title bar handles itself) */}
      <div className={`px-4 pb-4 border-b border-gray-300 dark:border-gray-700 ${
        window.electronAPI?.platform === 'darwin' ? 'pt-10' : 'pt-4'
      }`}>
        <h2 className="text-lg font-semibold mb-3">Conversations</h2>
        <button
          onClick={handleNewChat}
          className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
        >
          <Plus size={18} />
          New Chat
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto" aria-label="Conversations">
        {conversations.length === 0 ? (
          <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
            No conversations yet
          </div>
        ) : (
          <div className="p-2 space-y-1" role="list">
            {conversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                isActive={currentConversation?.id === conversation.id}
                onSelect={selectConversation}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </nav>

      <ConfirmDialog
        isOpen={!!pendingDeleteId}
        title="Delete Conversation"
        message="Are you sure you want to delete this conversation? This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />

      <SidebarTierBadge />
    </div>
  )
})

interface ConversationItemProps {
  conversation: { id: string; title: string; provider: string; model: string }
  isActive: boolean
  onSelect: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent | React.KeyboardEvent) => void
}

const ConversationItem = memo(function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete
}: ConversationItemProps) {
  const handleClick = useCallback(() => {
    onSelect(conversation.id)
  }, [onSelect, conversation.id])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(conversation.id)
    }
  }, [onSelect, conversation.id])

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    onDelete(conversation.id, e)
  }, [onDelete, conversation.id])

  return (
    <div
      role="listitem"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-current={isActive ? 'true' : undefined}
        aria-label={`${conversation.title} — ${conversation.provider}`}
        className={`p-3 rounded-lg cursor-pointer transition-colors group relative focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          isActive
            ? 'bg-blue-100 dark:bg-blue-900'
            : 'hover:bg-gray-200 dark:hover:bg-gray-800'
        }`}
      >
        <div className="flex items-start gap-2">
          <MessageSquare
            size={16}
            className="flex-shrink-0 mt-1 text-gray-600 dark:text-gray-400"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate text-gray-900 dark:text-gray-100">
              {conversation.title}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {conversation.provider} · {conversation.model}
            </p>
          </div>
          <button
            onClick={handleDeleteClick}
            aria-label={`Delete ${conversation.title}`}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 hover:bg-red-500 hover:text-white rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
})

// ── Sidebar Tier Badge ─────────────────────────────────────

const SidebarTierBadge = memo(function SidebarTierBadge() {
  const tier = useSubscriptionStore((state) => state.tier)
  const openUpgradeDialog = useSubscriptionStore((state) => state.openUpgradeDialog)
  const loadTier = useSubscriptionStore((state) => state.loadTier)

  useEffect(() => {
    loadTier()
  }, [loadTier])

  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1)

  return (
    <div className="p-3 border-t border-gray-300 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Crown size={12} className={tier !== 'free' ? 'text-amber-500' : ''} />
          <span>{tierLabel}</span>
        </div>
        {tier === 'free' && (
          <button
            onClick={() => openUpgradeDialog()}
            className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
          >
            Upgrade
          </button>
        )}
      </div>
    </div>
  )
})
