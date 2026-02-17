/**
 * Tests for tool-use extensions in LLM clients.
 * Validates the ToolUseResponse interface, LLMClient interface extensions,
 * and LLMClientManager convenience methods.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, ToolDefinition, AgentToolCall } from '../../src/shared/types'
import type { ToolUseResponse, LLMClient } from '../../src/main/llm-clients/client-manager'
import type { StreamChunk } from '../../src/main/llm-clients/anthropic-client'

// ── Mock data ────────────────────────────────────────────────

const sampleTools: ToolDefinition[] = [
  {
    name: 'search_documents',
    description: 'Search for documents by query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_weather',
    description: 'Get current weather for a location',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' }
      },
      required: ['location']
    }
  }
]

const sampleMessages: Message[] = [
  { id: 'msg-1', role: 'user', content: 'Search for documents about TypeScript' }
]

// ── ToolUseResponse Interface ────────────────────────────────

describe('ToolUseResponse', () => {
  it('should allow a text-only response (no tool calls)', () => {
    const response: ToolUseResponse = {
      text: 'Here is the answer.',
      toolCalls: [],
      done: true,
      stopReason: 'stop',
      tokens: { input: 100, output: 50 }
    }

    expect(response.text).toBe('Here is the answer.')
    expect(response.toolCalls).toHaveLength(0)
    expect(response.done).toBe(true)
    expect(response.stopReason).toBe('stop')
    expect(response.tokens?.input).toBe(100)
  })

  it('should allow a tool_use response with tool calls', () => {
    const response: ToolUseResponse = {
      text: '',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'search_documents',
          arguments: { query: 'TypeScript', limit: 5 }
        }
      ],
      done: false,
      stopReason: 'tool_use',
      tokens: { input: 80, output: 30 }
    }

    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0].name).toBe('search_documents')
    expect(response.toolCalls[0].arguments).toEqual({ query: 'TypeScript', limit: 5 })
    expect(response.done).toBe(false)
    expect(response.stopReason).toBe('tool_use')
  })

  it('should allow mixed response (text + tool calls)', () => {
    const response: ToolUseResponse = {
      text: 'Let me search for that.',
      toolCalls: [
        {
          id: 'tc-2',
          name: 'search_documents',
          arguments: { query: 'React hooks' }
        }
      ],
      done: false,
      stopReason: 'tool_use'
    }

    expect(response.text).toBe('Let me search for that.')
    expect(response.toolCalls).toHaveLength(1)
    expect(response.tokens).toBeUndefined()
  })

  it('should allow response without optional tokens', () => {
    const response: ToolUseResponse = {
      text: 'Done.',
      toolCalls: [],
      done: true,
      stopReason: 'stop'
    }

    expect(response.tokens).toBeUndefined()
  })
})

// ── LLMClient Interface Extensions ──────────────────────────

describe('LLMClient interface extensions', () => {
  it('should work with clients that do NOT support tool use', () => {
    const basicClient: LLMClient = {
      setApiKey: vi.fn(),
      validateApiKey: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn() as unknown as (
        messages: Message[],
        model: string,
        temperature: number
      ) => AsyncGenerator<StreamChunk>,
      sendMessageNonStreaming: vi.fn().mockResolvedValue('response'),
      getModels: vi.fn().mockReturnValue(['model-a'])
    }

    // Optional methods should be undefined
    expect(basicClient.sendMessageWithTools).toBeUndefined()
    expect(basicClient.supportsToolUse).toBeUndefined()

    // Fallback check
    const supports = basicClient.supportsToolUse?.() ?? false
    expect(supports).toBe(false)
  })

  it('should work with clients that DO support tool use', () => {
    const toolClient: LLMClient = {
      setApiKey: vi.fn(),
      validateApiKey: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn() as unknown as (
        messages: Message[],
        model: string,
        temperature: number
      ) => AsyncGenerator<StreamChunk>,
      sendMessageNonStreaming: vi.fn().mockResolvedValue('response'),
      getModels: vi.fn().mockReturnValue(['model-a']),
      supportsToolUse: () => true,
      sendMessageWithTools: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [{ id: 'tc-1', name: 'search', arguments: { query: 'test' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 50, output: 20 }
      })
    }

    expect(toolClient.supportsToolUse?.()).toBe(true)
    expect(toolClient.sendMessageWithTools).toBeDefined()
  })
})

// ── Message type extensions ──────────────────────────────────

describe('Message type with tool fields', () => {
  it('should support tool role messages', () => {
    const toolResult: Message = {
      id: 'msg-tool-1',
      role: 'tool',
      content: '{"results": [{"title": "TS Guide"}]}',
      toolCallId: 'tc-1'
    }

    expect(toolResult.role).toBe('tool')
    expect(toolResult.toolCallId).toBe('tc-1')
  })

  it('should support assistant messages with tool calls', () => {
    const assistantWithTools: Message = {
      id: 'msg-asst-1',
      role: 'assistant',
      content: 'Let me search for that.',
      toolCalls: [
        { id: 'tc-1', name: 'search_documents', arguments: { query: 'TS' } }
      ]
    }

    expect(assistantWithTools.toolCalls).toHaveLength(1)
    expect(assistantWithTools.toolCalls?.[0].name).toBe('search_documents')
  })

  it('should be backward compatible with regular messages', () => {
    const regular: Message = {
      id: 'msg-reg-1',
      role: 'user',
      content: 'Hello!'
    }

    expect(regular.toolCallId).toBeUndefined()
    expect(regular.toolCalls).toBeUndefined()
  })
})

// ── ToolDefinition structure ──────────────────────────────────

describe('ToolDefinition', () => {
  it('should have valid structure for Anthropic/OpenAI conversion', () => {
    const tool = sampleTools[0]

    expect(tool.name).toBe('search_documents')
    expect(tool.description).toContain('Search')
    expect(tool.inputSchema.type).toBe('object')
    expect(tool.inputSchema.properties).toHaveProperty('query')
    expect(tool.inputSchema.required).toContain('query')
  })

  it('should allow tools without required fields', () => {
    const tool: ToolDefinition = {
      name: 'list_all',
      description: 'List all items',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }

    expect(tool.inputSchema.required).toBeUndefined()
  })
})

// ── AgentToolCall structure ──────────────────────────────────

describe('AgentToolCall', () => {
  it('should contain id, name, and arguments', () => {
    const call: AgentToolCall = {
      id: 'toolu_abc123',
      name: 'get_weather',
      arguments: { location: 'Zurich' }
    }

    expect(call.id).toBe('toolu_abc123')
    expect(call.name).toBe('get_weather')
    expect(call.arguments.location).toBe('Zurich')
  })

  it('should handle empty arguments', () => {
    const call: AgentToolCall = {
      id: 'toolu_xyz',
      name: 'list_all',
      arguments: {}
    }

    expect(Object.keys(call.arguments)).toHaveLength(0)
  })
})

// ── Multi-turn tool conversation flow ────────────────────────

describe('Multi-turn tool conversation', () => {
  it('should construct a valid tool-use conversation history', () => {
    const conversation: Message[] = [
      // 1. User asks a question
      {
        id: 'msg-1',
        role: 'user',
        content: 'What is the weather in Zurich?'
      },
      // 2. Assistant decides to use a tool
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'Let me check the weather for you.',
        toolCalls: [
          { id: 'tc-1', name: 'get_weather', arguments: { location: 'Zurich' } }
        ]
      },
      // 3. Tool result
      {
        id: 'msg-3',
        role: 'tool',
        content: '{"temperature": 8, "condition": "cloudy"}',
        toolCallId: 'tc-1'
      },
      // 4. Assistant gives final answer
      {
        id: 'msg-4',
        role: 'assistant',
        content: 'The weather in Zurich is 8°C and cloudy.'
      }
    ]

    expect(conversation).toHaveLength(4)
    expect(conversation[0].role).toBe('user')
    expect(conversation[1].role).toBe('assistant')
    expect(conversation[1].toolCalls).toHaveLength(1)
    expect(conversation[2].role).toBe('tool')
    expect(conversation[2].toolCallId).toBe('tc-1')
    expect(conversation[3].role).toBe('assistant')
    expect(conversation[3].toolCalls).toBeUndefined()
  })

  it('should handle parallel tool calls (multiple tools in one turn)', () => {
    const assistantMsg: Message = {
      id: 'msg-multi',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc-a', name: 'get_weather', arguments: { location: 'Zurich' } },
        { id: 'tc-b', name: 'search_documents', arguments: { query: 'Zurich travel' } }
      ]
    }

    expect(assistantMsg.toolCalls).toHaveLength(2)
    expect(assistantMsg.toolCalls?.[0].id).not.toBe(assistantMsg.toolCalls?.[1].id)
  })
})
