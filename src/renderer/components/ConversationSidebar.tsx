import React, { useEffect, useCallback, memo } from 'react'
import { Plus, MessageSquare, Trash2 } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'

export const ConversationSidebar = memo(function ConversationSidebar() {
  const conversations = useChatStore((state) => state.conversations)
  const currentConversation = useChatStore((state) => state.currentConversation)
  const loadConversations = useChatStore((state) => state.loadConversations)
  const selectConversation = useChatStore((state) => state.selectConversation)
  const deleteConversation = useChatStore((state) => state.deleteConversation)

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('Delete this conversation?')) {
      await deleteConversation(id)
    }
  }, [deleteConversation])

  const handleNewChat = useCallback(() => {
    const event = new CustomEvent('open-new-conversation')
    window.dispatchEvent(event)
  }, [])

  return (
    <div className="w-64 border-r border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col">
      <div className="p-4 border-b border-gray-300 dark:border-gray-700">
        <h2 className="text-lg font-semibold mb-3">Conversations</h2>
        <button
          onClick={handleNewChat}
          className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
        >
          <Plus size={18} />
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
            No conversations yet
          </div>
        ) : (
          <div className="p-2 space-y-1">
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
      </div>
    </div>
  )
})

interface ConversationItemProps {
  conversation: { id: string; title: string; provider: string; model: string }
  isActive: boolean
  onSelect: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
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

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    onDelete(conversation.id, e)
  }, [onDelete, conversation.id])

  return (
    <div
      onClick={handleClick}
      className={`p-3 rounded-lg cursor-pointer transition-colors group relative ${
        isActive
          ? 'bg-blue-100 dark:bg-blue-900'
          : 'hover:bg-gray-200 dark:hover:bg-gray-800'
      }`}
    >
      <div className="flex items-start gap-2">
        <MessageSquare
          size={16}
          className="flex-shrink-0 mt-1 text-gray-600 dark:text-gray-400"
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
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-500 hover:text-white rounded"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
})
