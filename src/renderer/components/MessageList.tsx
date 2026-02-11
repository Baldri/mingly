import { useRef, useState, useCallback, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, User, Bot, ChevronDown, ChevronUp } from 'lucide-react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { useChatStore } from '../stores/chat-store'
import type { Message } from '../../shared/types'

export const MessageList = memo(function MessageList() {
  const messages = useChatStore((state) => state.messages)
  const isStreaming = useChatStore((state) => state.isStreaming)
  const streamingContent = useChatStore((state) => state.streamingContent)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const displayMessages = useMemo(() => {
    const list = [...messages]
    if (isStreaming && streamingContent) {
      list.push({
        id: 'streaming',
        role: 'assistant' as const,
        content: streamingContent
      })
    }
    return list
  }, [messages, isStreaming, streamingContent])

  if (displayMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400 p-8">
        <div className="text-center">
          <Bot size={48} className="mx-auto mb-4 opacity-50" />
          <p className="text-lg">Start a conversation</p>
          <p className="text-sm mt-2">Type a message below to begin</p>
        </div>
      </div>
    )
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="flex-1"
      data={displayMessages}
      followOutput="smooth"
      initialTopMostItemIndex={displayMessages.length - 1}
      itemContent={(_index, message) => (
        <div className="px-4 py-2">
          <MessageBubble
            message={message}
            isStreaming={message.id === 'streaming'}
          />
        </div>
      )}
    />
  )
})

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
}

const MessageBubble = memo(function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content)
  }, [message.content])

  const hasMetadata = !isUser && !isStreaming && (message.provider || message.tokens || message.cost)
  const hasRagSources = !isUser && !isStreaming && message.ragSources && message.ragSources.length > 0

  const markdownComponents = useMemo(() => ({
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '')
      return !inline && match ? (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          {...props}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
  }), [])

  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center">
          <Bot size={20} className="text-white" />
        </div>
      )}

      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-500 text-white'
            : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
        }`}
      >
        <div className="prose prose-sm dark:prose-invert max-w-none">
          {isUser ? (
            <p className="whitespace-pre-wrap m-0">{message.content}</p>
          ) : (
            <ReactMarkdown components={markdownComponents}>
              {message.content}
            </ReactMarkdown>
          )}
          {isStreaming && (
            <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
          )}
        </div>

        {/* RAG Sources */}
        {hasRagSources && <RAGSourcesSection sources={message.ragSources!} />}

        {/* Metadata + Copy row */}
        {!isUser && !isStreaming && (
          <div className="mt-2 flex items-center justify-between gap-2">
            {hasMetadata ? (
              <MessageMetadata message={message} />
            ) : (
              <div />
            )}
            <button
              onClick={handleCopy}
              className="text-xs opacity-50 hover:opacity-100 transition-opacity flex items-center gap-1 flex-shrink-0"
            >
              <Copy size={12} />
              Copy
            </button>
          </div>
        )}
      </div>

      {isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-500 flex items-center justify-center">
          <User size={20} className="text-white" />
        </div>
      )}
    </div>
  )
})

const MessageMetadata = memo(function MessageMetadata({ message }: { message: Message }) {
  const getProviderLabel = (provider: string): string => {
    switch (provider) {
      case 'anthropic': return 'Claude'
      case 'openai': return 'GPT'
      case 'google': return 'Gemini'
      case 'local': case 'ollama': return 'Local'
      default: return provider
    }
  }

  const getProviderColor = (provider: string): string => {
    switch (provider) {
      case 'anthropic': return 'text-orange-500 dark:text-orange-400'
      case 'openai': return 'text-green-500 dark:text-green-400'
      case 'google': return 'text-blue-500 dark:text-blue-400'
      default: return 'text-purple-500 dark:text-purple-400'
    }
  }

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
    return String(tokens)
  }

  const formatCost = (cost: number): string => {
    if (cost < 0.001) return cost > 0 ? '<$0.001' : ''
    if (cost < 0.01) return `$${cost.toFixed(3)}`
    return `$${cost.toFixed(2)}`
  }

  const formatLatency = (ms: number): string => {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.round(ms)}ms`
  }

  return (
    <div className="flex items-center gap-1.5 text-[10px] opacity-60 flex-wrap">
      {message.provider && (
        <span className={`font-medium ${getProviderColor(message.provider)}`}>
          {getProviderLabel(message.provider)}
        </span>
      )}
      {message.model && (
        <>
          <span className="opacity-40">·</span>
          <span>{message.model}</span>
        </>
      )}
      {message.tokens != null && message.tokens > 0 && (
        <>
          <span className="opacity-40">·</span>
          <span>{formatTokens(message.tokens)} tok</span>
        </>
      )}
      {message.cost != null && message.cost > 0 && (
        <>
          <span className="opacity-40">·</span>
          <span>{formatCost(message.cost)}</span>
        </>
      )}
      {message.latencyMs != null && message.latencyMs > 0 && (
        <>
          <span className="opacity-40">·</span>
          <span>{formatLatency(message.latencyMs)}</span>
        </>
      )}
    </div>
  )
})

const RAGSourcesSection = memo(function RAGSourcesSection({ sources }: { sources: Array<{ filename: string; score: number }> }) {
  const [expanded, setExpanded] = useState(false)

  const toggleExpanded = useCallback(() => setExpanded(prev => !prev), [])

  return (
    <div className="mt-2 pt-2 border-t border-gray-300/30 dark:border-gray-600/30">
      <button
        onClick={toggleExpanded}
        className="flex items-center gap-1 text-[11px] font-medium opacity-70 hover:opacity-100 transition-opacity"
      >
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {sources.length} source{sources.length !== 1 ? 's' : ''} from knowledge base
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {sources.map((source, i) => (
            <div
              key={i}
              className="flex items-center justify-between text-[10px] px-2 py-1 rounded bg-black/5 dark:bg-white/5"
            >
              <span className="truncate mr-2">{source.filename}</span>
              <span className="flex-shrink-0 opacity-60">
                {(source.score * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
