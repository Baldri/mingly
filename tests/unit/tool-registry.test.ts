/**
 * Tests for ToolRegistry — MCP-Bridge + Built-in Tools.
 * Validates tool registration, MCP bridging, execution, timeouts, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRegistry } from '../../src/main/agent/tool-registry'
import type { ToolDefinition, AgentToolCall, AgentToolResult } from '../../src/shared/types'

// Mock MCPClientManager
vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({
    listAllTools: vi.fn().mockReturnValue([
      {
        id: 'rag-server:search_docs',
        serverName: 'rag-server',
        toolName: 'search_docs',
        description: 'Search documents in the knowledge base',
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
        id: 'weather-server:get_weather',
        serverName: 'weather-server',
        toolName: 'get_weather',
        description: 'Get current weather',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          },
          required: ['location']
        }
      }
    ]),
    executeTool: vi.fn().mockResolvedValue({
      toolName: 'search_docs',
      result: JSON.stringify([{ title: 'TypeScript Guide', score: 0.95 }])
    })
  }))
}))

// ── Setup ────────────────────────────────────────────────────

let registry: ToolRegistry

beforeEach(() => {
  vi.clearAllMocks()
  registry = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: 1000 })
})

// ── Built-in tool registration ──────────────────────────────

describe('Built-in tools', () => {
  it('should register a built-in tool', () => {
    const def: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input']
      }
    }

    registry.registerBuiltIn(def, async (args) => `Result: ${args.input}`)

    expect(registry.hasTool('test_tool')).toBe(true)
    expect(registry.getToolByName('test_tool')).toEqual(def)
  })

  it('should execute a built-in tool', async () => {
    registry.registerBuiltIn(
      {
        name: 'greet',
        description: 'Greet a person',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      },
      async (args) => `Hello, ${args.name}!`
    )

    const result = await registry.executeTool({
      id: 'tc-1',
      name: 'greet',
      arguments: { name: 'Holger' }
    })

    expect(result.toolCallId).toBe('tc-1')
    expect(result.content).toBe('Hello, Holger!')
    expect(result.isError).toBe(false)
  })

  it('should handle built-in tool errors gracefully', async () => {
    registry.registerBuiltIn(
      {
        name: 'failing_tool',
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} }
      },
      async () => {
        throw new Error('Something went wrong')
      }
    )

    const result = await registry.executeTool({
      id: 'tc-err',
      name: 'failing_tool',
      arguments: {}
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Something went wrong')
  })
})

// ── MCP tool bridging ───────────────────────────────────────

describe('MCP tool bridging', () => {
  it('should discover MCP tools via refreshMCPTools()', () => {
    registry.refreshMCPTools()

    expect(registry.hasTool('search_docs')).toBe(true)
    expect(registry.hasTool('get_weather')).toBe(true)
  })

  it('should convert MCP tools to ToolDefinition format', () => {
    registry.refreshMCPTools()

    const tools = registry.getAvailableTools()
    const searchTool = tools.find((t) => t.name === 'search_docs')

    expect(searchTool).toBeDefined()
    expect(searchTool?.description).toBe('Search documents in the knowledge base')
    expect(searchTool?.inputSchema.type).toBe('object')
    expect(searchTool?.inputSchema.properties).toHaveProperty('query')
    expect(searchTool?.inputSchema.required).toContain('query')
  })

  it('should execute MCP tools through the bridge', async () => {
    registry.refreshMCPTools()

    const result = await registry.executeTool({
      id: 'tc-mcp-1',
      name: 'search_docs',
      arguments: { query: 'TypeScript patterns' }
    })

    expect(result.toolCallId).toBe('tc-mcp-1')
    expect(result.isError).toBe(false)
    expect(result.content).toContain('TypeScript Guide')
  })

  it('should combine built-in and MCP tools in getAvailableTools()', () => {
    registry.registerBuiltIn(
      {
        name: 'my_tool',
        description: 'Custom tool',
        inputSchema: { type: 'object', properties: {} }
      },
      async () => 'ok'
    )
    registry.refreshMCPTools()

    const tools = registry.getAvailableTools()
    const names = tools.map((t) => t.name)

    expect(names).toContain('my_tool')
    expect(names).toContain('search_docs')
    expect(names).toContain('get_weather')
  })
})

// ── Parallel execution ──────────────────────────────────────

describe('Parallel tool execution', () => {
  it('should execute multiple tool calls in parallel', async () => {
    registry.registerBuiltIn(
      {
        name: 'fast_tool',
        description: 'Fast tool',
        inputSchema: { type: 'object', properties: { val: { type: 'string' } } }
      },
      async (args) => `fast: ${args.val}`
    )
    registry.registerBuiltIn(
      {
        name: 'slow_tool',
        description: 'Slow tool',
        inputSchema: { type: 'object', properties: { val: { type: 'string' } } }
      },
      async (args) => {
        await new Promise((r) => setTimeout(r, 50))
        return `slow: ${args.val}`
      }
    )

    const results = await registry.executeToolCalls([
      { id: 'tc-a', name: 'fast_tool', arguments: { val: 'A' } },
      { id: 'tc-b', name: 'slow_tool', arguments: { val: 'B' } }
    ])

    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('fast: A')
    expect(results[1].content).toBe('slow: B')
    expect(results.every((r) => !r.isError)).toBe(true)
  })
})

// ── Unknown tool handling ───────────────────────────────────

describe('Unknown tools', () => {
  it('should return error for unknown tool', async () => {
    const result = await registry.executeTool({
      id: 'tc-unknown',
      name: 'nonexistent_tool',
      arguments: {}
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unknown tool')
    expect(result.content).toContain('nonexistent_tool')
  })
})

// ── Result truncation ───────────────────────────────────────

describe('Result truncation', () => {
  it('should truncate results exceeding maxResultChars', async () => {
    const longResult = 'x'.repeat(2000)

    registry.registerBuiltIn(
      {
        name: 'long_result_tool',
        description: 'Returns long result',
        inputSchema: { type: 'object', properties: {} }
      },
      async () => longResult
    )

    const result = await registry.executeTool({
      id: 'tc-long',
      name: 'long_result_tool',
      arguments: {}
    })

    // Config maxResultChars is 1000
    expect(result.content.length).toBeLessThan(2000)
    expect(result.content).toContain('[truncated]')
    expect(result.isError).toBe(false)
  })

  it('should not truncate results within limit', async () => {
    registry.registerBuiltIn(
      {
        name: 'short_result_tool',
        description: 'Returns short result',
        inputSchema: { type: 'object', properties: {} }
      },
      async () => 'Short result'
    )

    const result = await registry.executeTool({
      id: 'tc-short',
      name: 'short_result_tool',
      arguments: {}
    })

    expect(result.content).toBe('Short result')
    expect(result.content).not.toContain('[truncated]')
  })
})

// ── Tool lookup ─────────────────────────────────────────────

describe('Tool lookup', () => {
  it('should find built-in tool by name', () => {
    registry.registerBuiltIn(
      {
        name: 'finder_test',
        description: 'Test finder',
        inputSchema: { type: 'object', properties: {} }
      },
      async () => 'found'
    )

    const tool = registry.getToolByName('finder_test')
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('finder_test')
  })

  it('should find MCP tool by name', () => {
    registry.refreshMCPTools()

    const tool = registry.getToolByName('search_docs')
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('search_docs')
  })

  it('should return undefined for unknown tool', () => {
    const tool = registry.getToolByName('nonexistent')
    expect(tool).toBeUndefined()
  })
})
