/**
 * Tests for tool-use via OpenAI-compatible endpoint (Ollama + GenericOpenAI).
 *
 * Tests the shared helper (openai-tool-use-helper.ts) which both
 * OllamaClient and GenericOpenAIClient use for tool-use calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Message, ToolDefinition } from '../../src/shared/types'
import {
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  parseOpenAIToolResponse,
  fetchWithTools
} from '../../src/main/llm-clients/openai-tool-use-helper'

// ── Test data ─────────────────────────────────────────────────

const sampleTools: ToolDefinition[] = [
  {
    name: 'search_docs',
    description: 'Search documents',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_weather',
    description: 'Get weather',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string' }
      },
      required: ['location']
    }
  }
]

const sampleMessages: Message[] = [
  { id: 'msg-1', role: 'system', content: 'You are a helpful assistant.' },
  { id: 'msg-2', role: 'user', content: 'Search for TypeScript docs' }
]

// ── convertMessagesToOpenAI ───────────────────────────────────

describe('convertMessagesToOpenAI', () => {
  it('should convert regular user/system/assistant messages', () => {
    const result = convertMessagesToOpenAI(sampleMessages)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(result[1]).toEqual({ role: 'user', content: 'Search for TypeScript docs' })
  })

  it('should convert tool result messages', () => {
    const messages: Message[] = [
      {
        id: 'msg-tool',
        role: 'tool',
        content: '{"results": ["doc1"]}',
        toolCallId: 'tc-123'
      }
    ]

    const result = convertMessagesToOpenAI(messages)

    expect(result[0]).toEqual({
      role: 'tool',
      tool_call_id: 'tc-123',
      content: '{"results": ["doc1"]}'
    })
  })

  it('should convert assistant messages with tool calls', () => {
    const messages: Message[] = [
      {
        id: 'msg-asst',
        role: 'assistant',
        content: 'Let me search.',
        toolCalls: [
          { id: 'tc-1', name: 'search_docs', arguments: { query: 'TS' } }
        ]
      }
    ]

    const result = convertMessagesToOpenAI(messages)

    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'Let me search.',
      tool_calls: [
        {
          id: 'tc-1',
          type: 'function',
          function: {
            name: 'search_docs',
            arguments: '{"query":"TS"}'
          }
        }
      ]
    })
  })

  it('should handle missing toolCallId gracefully', () => {
    const messages: Message[] = [
      { id: 'msg-tool', role: 'tool', content: 'result' }
    ]

    const result = convertMessagesToOpenAI(messages)
    expect(result[0]).toEqual({
      role: 'tool',
      tool_call_id: '',
      content: 'result'
    })
  })
})

// ── convertToolsToOpenAI ─────────────────────────────────────

describe('convertToolsToOpenAI', () => {
  it('should convert ToolDefinition[] to OpenAI format', () => {
    const result = convertToolsToOpenAI(sampleTools)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'search_docs',
        description: 'Search documents',
        parameters: sampleTools[0].inputSchema
      }
    })
  })
})

// ── parseOpenAIToolResponse ──────────────────────────────────

describe('parseOpenAIToolResponse', () => {
  it('should parse a tool_calls response', () => {
    const apiResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function' as const,
                function: {
                  name: 'search_docs',
                  arguments: '{"query":"TypeScript"}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }
    }

    const result = parseOpenAIToolResponse(apiResponse)

    expect(result.text).toBe('')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].id).toBe('call_abc')
    expect(result.toolCalls[0].name).toBe('search_docs')
    expect(result.toolCalls[0].arguments).toEqual({ query: 'TypeScript' })
    expect(result.stopReason).toBe('tool_use')
    expect(result.done).toBe(false)
    expect(result.tokens).toEqual({ input: 100, output: 30 })
  })

  it('should parse a final answer response (no tool calls)', () => {
    const apiResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Here is the answer.',
            tool_calls: undefined
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
    }

    const result = parseOpenAIToolResponse(apiResponse)

    expect(result.text).toBe('Here is the answer.')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.stopReason).toBe('stop')
    expect(result.done).toBe(true)
    expect(result.tokens).toEqual({ input: 50, output: 20 })
  })

  it('should parse multiple tool calls in one response', () => {
    const apiResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Let me check both.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function' as const,
                function: { name: 'search_docs', arguments: '{"query":"TS"}' }
              },
              {
                id: 'call_2',
                type: 'function' as const,
                function: { name: 'get_weather', arguments: '{"location":"Zurich"}' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    }

    const result = parseOpenAIToolResponse(apiResponse)

    expect(result.text).toBe('Let me check both.')
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].name).toBe('search_docs')
    expect(result.toolCalls[1].name).toBe('get_weather')
    expect(result.tokens).toBeUndefined() // No usage in response
  })

  it('should handle malformed tool call arguments gracefully', () => {
    const apiResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function' as const,
                function: { name: 'search_docs', arguments: 'not valid json{' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    }

    const result = parseOpenAIToolResponse(apiResponse)

    // Malformed arguments should cause the tool call to be skipped entirely
    expect(result.toolCalls).toHaveLength(0)
  })

  it('should throw if no choices returned', () => {
    const apiResponse = { choices: [] }

    expect(() => parseOpenAIToolResponse(apiResponse)).toThrow('No response choice returned')
  })

  it('should handle null content as empty string', () => {
    const apiResponse = {
      choices: [
        {
          message: { role: 'assistant', content: null },
          finish_reason: 'stop'
        }
      ]
    }

    const result = parseOpenAIToolResponse(apiResponse)
    expect(result.text).toBe('')
  })
})

// ── fetchWithTools (integration via mock fetch) ──────────────

describe('fetchWithTools', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    // Mock global fetch
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('should call the correct URL and parse response', async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Done.',
            tool_calls: undefined
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }

    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    })

    const result = await fetchWithTools(
      'http://localhost:11434/v1',
      'llama3.1:8b',
      sampleMessages,
      sampleTools,
      0.7,
      {},
      'Ollama'
    )

    // Check that fetch was called with correct URL
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    )

    // Check parsed body contains model and tools
    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(callArgs[1].body)
    expect(body.model).toBe('llama3.1:8b')
    expect(body.tools).toHaveLength(2)
    expect(body.stream).toBe(false)
    expect(body.temperature).toBe(0.7)

    // Check result
    expect(result.text).toBe('Done.')
    expect(result.stopReason).toBe('stop')
    expect(result.tokens).toEqual({ input: 10, output: 5 })
  })

  it('should include auth headers when provided', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      })
    })

    await fetchWithTools(
      'https://api.openrouter.ai/v1',
      'meta/llama-3.1',
      sampleMessages,
      sampleTools,
      1.0,
      { Authorization: 'Bearer sk-test-123' },
      'GenericOpenAI'
    )

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[1].headers).toHaveProperty('Authorization', 'Bearer sk-test-123')
  })

  it('should throw on non-ok HTTP response', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'model not found'
    })

    await expect(
      fetchWithTools(
        'http://localhost:11434/v1',
        'nonexistent-model',
        sampleMessages,
        sampleTools,
        1.0,
        {},
        'Ollama'
      )
    ).rejects.toThrow('Ollama tool-use API error (500)')
  })

  it('should handle trailing slash in baseURL', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
      })
    })

    await fetchWithTools(
      'http://localhost:11434/v1/',
      'model',
      sampleMessages,
      sampleTools,
      1.0,
      {},
      'Test'
    )

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('should handle tool_calls response from Ollama', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_ollama_1',
                  type: 'function',
                  function: { name: 'search_docs', arguments: '{"query":"test"}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 80, completion_tokens: 25, total_tokens: 105 }
      })
    })

    const result = await fetchWithTools(
      'http://localhost:11434/v1',
      'llama3.1:8b',
      sampleMessages,
      sampleTools,
      0.7,
      {},
      'Ollama'
    )

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('search_docs')
    expect(result.toolCalls[0].arguments).toEqual({ query: 'test' })
    expect(result.stopReason).toBe('tool_use')
    expect(result.done).toBe(false)
  })
})

// ── OllamaClient / GenericOpenAIClient integration ──────────

describe('Client supportsToolUse()', () => {
  it('OllamaClient should report tool-use support', async () => {
    // Dynamic import to avoid electron dependencies
    const { OllamaClient } = await import('../../src/main/llm-clients/ollama-client')
    const client = new OllamaClient()
    expect(client.supportsToolUse()).toBe(true)
  })

  it('GenericOpenAIClient should report tool-use support', async () => {
    const { GenericOpenAIClient } = await import('../../src/main/llm-clients/generic-openai-client')
    const client = new GenericOpenAIClient('http://localhost:8080/v1')
    expect(client.supportsToolUse()).toBe(true)
  })
})
