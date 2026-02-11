import React, { useState, useRef, useEffect, useCallback, memo } from 'react'
import { Send } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'

export const MessageInput = memo(function MessageInput() {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const currentConversation = useChatStore((state) => state.currentConversation)
  const isStreaming = useChatStore((state) => state.isStreaming)
  const sendMessage = useChatStore((state) => state.sendMessage)

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [input])

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming || !currentConversation) return

    await sendMessage(input.trim())
    setInput('')
  }, [input, isStreaming, currentConversation, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }, [])

  const isDisabled = isStreaming || !currentConversation

  return (
    <div className="border-t border-gray-300 dark:border-gray-700 p-4 bg-white dark:bg-gray-800">
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            currentConversation
              ? 'Type a message... (Cmd+Enter to send)'
              : 'Select or create a conversation to start'
          }
          disabled={isDisabled}
          rows={1}
          className="flex-1 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed resize-none max-h-32"
        />
        <button
          onClick={handleSend}
          disabled={isDisabled || !input.trim()}
          className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0 h-10"
        >
          <Send size={20} />
        </button>
      </div>
      {currentConversation && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {currentConversation.provider} · {currentConversation.model}
        </div>
      )}
    </div>
  )
})
