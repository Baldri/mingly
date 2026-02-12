import React, { useState, useRef, useEffect, useCallback, memo } from 'react'
import { Send, Paperclip, X, Image as ImageIcon } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import type { MessageAttachment } from '../../shared/types'

export const MessageInput = memo(function MessageInput() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
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

    await sendMessage(input.trim(), attachments.length > 0 ? attachments : undefined)
    setInput('')
    setAttachments([])
  }, [input, attachments, isStreaming, currentConversation, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }, [])

  const handleImageSelect = useCallback(async () => {
    try {
      const result = await window.electronAPI.image.select()
      if (result.success && result.attachments?.length) {
        setAttachments((prev) => {
          const combined = [...prev, ...result.attachments]
          return combined.slice(0, 4) // Max 4 images
        })
      }
    } catch (error) {
      console.error('Failed to select images:', error)
    }
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((att) => att.id !== id))
  }, [])

  // Handle paste (Cmd+V / Ctrl+V with image)
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue

        const buffer = await file.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        )

        const mimeType = file.type as MessageAttachment['mimeType']
        if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) continue

        const attachment: MessageAttachment = {
          id: crypto.randomUUID(),
          type: 'image',
          mimeType,
          data: base64,
          filename: file.name || 'pasted-image',
          originalSize: file.size
        }

        setAttachments((prev) => {
          if (prev.length >= 4) return prev
          return [...prev, attachment]
        })
        break // Only handle first image
      }
    }
  }, [])

  // Drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    )

    for (const file of files.slice(0, 4 - attachments.length)) {
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )

      const mimeType = file.type as MessageAttachment['mimeType']
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) continue

      const attachment: MessageAttachment = {
        id: crypto.randomUUID(),
        type: 'image',
        mimeType,
        data: base64,
        filename: file.name,
        originalSize: file.size
      }

      setAttachments((prev) => {
        if (prev.length >= 4) return prev
        return [...prev, attachment]
      })
    }
  }, [attachments.length])

  const isDisabled = isStreaming || !currentConversation

  return (
    <div
      className={`border-t border-gray-300 dark:border-gray-700 p-4 bg-white dark:bg-gray-800 ${
        isDragOver ? 'ring-2 ring-blue-500 ring-inset bg-blue-50 dark:bg-blue-900/20' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600 group"
            >
              <img
                src={`data:${att.mimeType};base64,${att.data}`}
                alt={att.filename || 'attachment'}
                className="w-full h-full object-cover"
              />
              <button
                onClick={() => handleRemoveAttachment(att.id)}
                className="absolute top-0 right-0 p-0.5 bg-black/60 text-white rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {attachments.length < 4 && (
            <button
              onClick={handleImageSelect}
              disabled={isDisabled}
              className="w-16 h-16 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 transition-colors disabled:opacity-50"
            >
              <ImageIcon size={20} />
            </button>
          )}
        </div>
      )}

      {/* Drag overlay hint */}
      {isDragOver && (
        <div className="mb-2 text-center text-sm text-blue-600 dark:text-blue-400">
          Drop images here
        </div>
      )}

      <div className="flex gap-2 items-end">
        <button
          onClick={handleImageSelect}
          disabled={isDisabled || attachments.length >= 4}
          className="px-2 py-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0 h-10"
          title="Attach images (max 4)"
        >
          <Paperclip size={20} />
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
          {attachments.length > 0 && ` · ${attachments.length} image${attachments.length !== 1 ? 's' : ''}`}
        </div>
      )}
    </div>
  )
})
