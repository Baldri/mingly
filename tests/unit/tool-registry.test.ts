/**
 * Tests for ToolRegistry — MCP-Bridge + Built-in Tools.
 * Validates tool registration, MCP bridging, execution, timeouts, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getMCPClientManager } from '../../src/main/mcp/mcp-client-manager'
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/main/agent/tool-registry'
import { CODING_MODE_ORDER, type CodingMode } from '../../src/shared/coding-types'
import { atLeast } from '../../src/main/policy/policy-types'
import type { ToolDefinition } from '../../src/shared/types'

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

// ── Context-gated tools (coding mode) ───────────────────────

describe('Context-gated built-in tools', () => {
  const gatedDef: ToolDefinition = {
    name: 'mingly_edit_file',
    description: 'Gated test tool',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
  const proposeGate: ToolGate = (ctx) =>
    atLeast(CODING_MODE_ORDER, ctx?.coding?.mode ?? 'off', 'propose')
  const codingCtx = (mode: CodingMode): ToolContext => ({
    coding: { directoryId: 'dir-1', projectPath: '/tmp/p', mode }
  })

  it('withholds a gated tool when no context is given', () => {
    registry.registerBuiltIn(gatedDef, async () => 'edited', proposeGate)
    expect(registry.getAvailableTools().map((t) => t.name)).not.toContain('mingly_edit_file')
  })

  it('offers a gated tool when the mode reaches its threshold', () => {
    registry.registerBuiltIn(gatedDef, async () => 'edited', proposeGate)
    expect(registry.getAvailableTools(codingCtx('propose')).map((t) => t.name)).toContain('mingly_edit_file')
    expect(registry.getAvailableTools(codingCtx('propose-run')).map((t) => t.name)).toContain('mingly_edit_file')
  })

  it('withholds it again one step below the threshold', () => {
    registry.registerBuiltIn(gatedDef, async () => 'edited', proposeGate)
    expect(registry.getAvailableTools(codingCtx('read-only')).map((t) => t.name)).not.toContain('mingly_edit_file')
    expect(registry.getAvailableTools(codingCtx('off')).map((t) => t.name)).not.toContain('mingly_edit_file')
  })

  it('refuses execution of a gated tool even when it was never offered', async () => {
    const handler = vi.fn(async () => 'edited')
    registry.registerBuiltIn(gatedDef, handler, proposeGate)
    const [res] = await registry.executeToolCalls(
      [{ id: '1', name: 'mingly_edit_file', arguments: {} }],
      undefined
    )
    expect(res.isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses execution one step below the threshold, runs it at the threshold', async () => {
    const handler = vi.fn(async () => 'edited')
    registry.registerBuiltIn(gatedDef, handler, proposeGate)
    const call = [{ id: '1', name: 'mingly_edit_file', arguments: {} }]
    const [below] = await registry.executeToolCalls(call, codingCtx('read-only'))
    expect(below.isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    const [at] = await registry.executeToolCalls(call, codingCtx('propose'))
    expect(at.isError).toBe(false)
    expect(at.content).toBe('edited')
  })

  it('hands the context to the handler as its second argument', async () => {
    const handler = vi.fn(async () => 'ok')
    registry.registerBuiltIn(gatedDef, handler, proposeGate)
    const ctx = codingCtx('propose')
    await registry.executeToolCalls([{ id: '1', name: 'mingly_edit_file', arguments: { a: 1 } }], ctx)
    // The handler gets the run's context, narrowed to this call by the call id
    // (lets a handler report per-call results under a key the registry mints,
    // never one the provider supplied). Still two arguments.
    expect(handler).toHaveBeenCalledWith({ a: 1 }, { ...ctx, callKey: '0' })
  })

  it('treats a throwing gate as closed', async () => {
    const handler = vi.fn(async () => 'x')
    registry.registerBuiltIn(gatedDef, handler, () => {
      throw new Error('boom')
    })
    expect(registry.getAvailableTools(codingCtx('propose')).map((t) => t.name)).not.toContain('mingly_edit_file')
    const [res] = await registry.executeToolCalls(
      [{ id: '1', name: 'mingly_edit_file', arguments: {} }],
      codingCtx('propose')
    )
    expect(res.isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('treats a non-boolean gate result as closed', () => {
    registry.registerBuiltIn(gatedDef, async () => 'x', (() => 'yes') as unknown as ToolGate)
    expect(registry.getAvailableTools(codingCtx('propose')).map((t) => t.name)).not.toContain('mingly_edit_file')
  })

  it('does not name a gated tool in the unknown-tool listing of an ungated caller', async () => {
    registry.registerBuiltIn(gatedDef, async () => 'x', proposeGate)
    const [res] = await registry.executeToolCalls(
      [{ id: '1', name: 'mingly_edit_file', arguments: {} }],
      undefined
    )
    expect(res.isError).toBe(true)
    expect(res.content).not.toMatch(/Available tools:.*mingly_edit_file/)
  })

  describe('a closed built-in gate versus an MCP tool of the same name', () => {
    // The mocked MCP manager serves an MCP tool called `search_docs`.
    const shadowDef: ToolDefinition = {
      name: 'search_docs',
      description: 'Gated built-in shadowing an MCP tool',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }
    /** Every executeTool call any manager instance the mock handed out received. */
    const mcpExecuteCalls = (): unknown[] =>
      vi
        .mocked(getMCPClientManager)
        .mock.results.flatMap((r) =>
          r.type === 'return'
            ? (r.value as unknown as { executeTool: { mock: { calls: unknown[] } } })
                .executeTool.mock.calls
            : []
        )

    it('does not offer the MCP tool name while the built-in gate is closed', () => {
      registry.registerBuiltIn(shadowDef, async () => 'builtin', proposeGate)
      expect(registry.getAvailableTools().map((t) => t.name)).not.toContain('search_docs')
      expect(registry.getAvailableTools(codingCtx('read-only')).map((t) => t.name)).not.toContain('search_docs')
    })

    it('offers the built-in, and only it, once the gate is open', () => {
      registry.registerBuiltIn(shadowDef, async () => 'builtin', proposeGate)
      const offered = registry.getAvailableTools(codingCtx('propose')).filter((t) => t.name === 'search_docs')
      expect(offered).toEqual([shadowDef])
    })

    it('does not reach the MCP handler for that name while the gate is closed', async () => {
      registry.registerBuiltIn(shadowDef, async () => 'builtin', proposeGate)
      registry.refreshMCPTools()
      const before = mcpExecuteCalls().length
      const [res] = await registry.executeToolCalls(
        [{ id: '1', name: 'search_docs', arguments: { query: 'q' } }],
        codingCtx('read-only')
      )
      expect(res.isError).toBe(true)
      expect(mcpExecuteCalls().length).toBe(before)
    })

    it('does not list the refused name as available in its own refusal, but lists unshadowed MCP names', async () => {
      registry.registerBuiltIn(shadowDef, async () => 'builtin', proposeGate)
      registry.refreshMCPTools()
      const [res] = await registry.executeToolCalls(
        [{ id: '1', name: 'search_docs', arguments: {} }],
        codingCtx('read-only')
      )
      expect(res.isError).toBe(true)
      const listed = /Available tools: (.*)$/.exec(res.content)?.[1] ?? ''
      expect(listed.split(', ')).not.toContain('search_docs')
      expect(listed.split(', ')).toContain('get_weather')
    })

    it('still offers an MCP tool whose name no built-in claims', () => {
      registry.registerBuiltIn(shadowDef, async () => 'builtin', proposeGate)
      expect(registry.getAvailableTools().map((t) => t.name)).toContain('get_weather')
    })
  })

  it('leaves ungated tools unaffected', async () => {
    registry.registerBuiltIn(
      { name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {}, required: [] } },
      async () => 'pong'
    )
    expect(registry.getAvailableTools().map((t) => t.name)).toContain('echo')
    expect(registry.getAvailableTools(codingCtx('off')).map((t) => t.name)).toContain('echo')
    const [res] = await registry.executeToolCalls([{ id: '1', name: 'echo', arguments: {} }])
    expect(res.content).toBe('pong')
  })
})
