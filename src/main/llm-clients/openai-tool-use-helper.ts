/**
 * Shared tool-use helper for OpenAI-compatible APIs using raw fetch().
 *
 * Used by OllamaClient (localhost:11434/v1/) and GenericOpenAIClient.
 * Both endpoints speak the OpenAI /chat/completions format with tool_calls.
 */

import type { Message, ToolDefinition, AgentToolCall } from '../../shared/types'
import type { ToolUseResponse } from './client-manager'

/** OpenAI-compatible message format for tool-use conversations */
type OpenAIToolMessage =
  | { role: 'user' | 'assistant' | 'system'; content: string | null }
  | { role: 'assistant'; content: string | null; tool_calls: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAIToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Response shape from /chat/completions (non-streaming) */
interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Convert app Message[] to OpenAI-compatible message format.
 * Handles: tool role, assistant tool_calls, regular user/system/assistant.
 */
export function convertMessagesToOpenAI(messages: Message[]): OpenAIToolMessage[] {
  return messages.map((msg) => {
    // Tool result messages
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: msg.toolCallId ?? '',
        content: msg.content
      }
    }

    // Assistant messages with tool calls from previous turns
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }))
      }
    }

    // Regular user/assistant/system messages
    return {
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content
    }
  })
}

/**
 * Convert ToolDefinition[] to OpenAI tool format.
 */
export function convertToolsToOpenAI(tools: ToolDefinition[]): OpenAIToolDef[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }))
}

/**
 * Parse an OpenAI-compatible /chat/completions response into ToolUseResponse.
 */
export function parseOpenAIToolResponse(data: OpenAIChatResponse): ToolUseResponse {
  const choice = data.choices[0]
  if (!choice) {
    throw new Error('No response choice returned from API')
  }

  const assistantMsg = choice.message
  const text = assistantMsg.content ?? ''
  const toolCalls: AgentToolCall[] = []

  // Parse tool_calls from the response
  if (assistantMsg.tool_calls?.length) {
    for (const tc of assistantMsg.tool_calls) {
      if (tc.type !== 'function') continue

      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(tc.function.arguments)
      } catch {
        console.warn(
          `Failed to parse tool call arguments for ${tc.function.name}: ` +
          `${tc.function.arguments?.substring(0, 200)}`
        )
        // Skip tool calls with unparseable arguments instead of executing with empty args
        continue
      }

      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs
      })
    }
  }

  const finishReason = choice.finish_reason

  return {
    text,
    toolCalls,
    done: finishReason !== 'tool_calls',
    stopReason: finishReason === 'tool_calls' ? 'tool_use' : 'stop',
    tokens: data.usage
      ? {
          input: data.usage.prompt_tokens,
          output: data.usage.completion_tokens
        }
      : undefined
  }
}

/**
 * Execute a tool-use request against an OpenAI-compatible endpoint.
 *
 * @param baseURL - API base URL (e.g., "http://localhost:11434/v1" or "https://api.openai.com/v1")
 * @param model - Model name
 * @param messages - Conversation messages
 * @param tools - Tool definitions
 * @param temperature - Sampling temperature
 * @param headers - HTTP headers (including Authorization if needed)
 * @param clientLabel - Label for error messages (e.g., "Ollama", "GenericOpenAI")
 */
export async function fetchWithTools(
  baseURL: string,
  model: string,
  messages: Message[],
  tools: ToolDefinition[],
  temperature: number,
  headers: Record<string, string>,
  clientLabel: string
): Promise<ToolUseResponse> {
  const openaiMessages = convertMessagesToOpenAI(messages)
  const openaiTools = convertToolsToOpenAI(tools)

  const url = baseURL.endsWith('/')
    ? `${baseURL}chat/completions`
    : `${baseURL}/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      temperature,
      stream: false
    })
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText)
    throw new Error(`${clientLabel} tool-use API error (${response.status}): ${errorText}`)
  }

  const data = (await response.json()) as OpenAIChatResponse
  return parseOpenAIToolResponse(data)
}
