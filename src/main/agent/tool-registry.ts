/**
 * ToolRegistry — Unified tool management for the Agent system.
 *
 * Bridges MCP tools and built-in tools into a single interface.
 * The AgentExecutor only interacts with this registry, never with
 * MCPClientManager or individual tool implementations directly.
 *
 * Responsibilities:
 * 1. Convert MCP tools → ToolDefinition format (for LLM tool_use)
 * 2. Register built-in tools (e.g., echo for testing)
 * 3. Execute tool calls and return structured results
 * 4. Handle tool timeouts and errors gracefully
 */

import { getMCPClientManager } from '../mcp/mcp-client-manager'
import type {
  ToolDefinition,
  AgentToolCall,
  AgentToolResult,
  MCPTool
} from '../../shared/types'

// ── Built-in tool handler type ─────────────────────────────────

type BuiltInToolHandler = (args: Record<string, unknown>) => Promise<string>

interface BuiltInToolEntry {
  definition: ToolDefinition
  handler: BuiltInToolHandler
}

// ── MCP tool mapping ───────────────────────────────────────────

interface MCPToolMapping {
  serverId: string
  toolName: string
}

// ── Configuration ──────────────────────────────────────────────

export interface ToolRegistryConfig {
  /** Timeout per tool execution in ms (default: 15000) */
  toolTimeoutMs: number
  /** Maximum result size in chars before truncation (default: 4000) */
  maxResultChars: number
}

const DEFAULT_CONFIG: ToolRegistryConfig = {
  toolTimeoutMs: 15000,
  maxResultChars: 4000
}

// ── ToolRegistry ───────────────────────────────────────────────

export class ToolRegistry {
  private builtInTools: Map<string, BuiltInToolEntry> = new Map()
  private mcpToolMap: Map<string, MCPToolMapping> = new Map()
  private config: ToolRegistryConfig

  constructor(config?: Partial<ToolRegistryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── Registration ────────────────────────────────────────────

  /**
   * Register a built-in tool with its handler function.
   * Built-in tools are always available, regardless of MCP server state.
   */
  registerBuiltIn(
    definition: ToolDefinition,
    handler: BuiltInToolHandler
  ): void {
    this.builtInTools.set(definition.name, { definition, handler })
  }

  /**
   * Refresh MCP tool definitions from connected MCP servers.
   * Call this before each agent run to get the latest available tools.
   */
  refreshMCPTools(): void {
    this.mcpToolMap.clear()

    const mcpManager = getMCPClientManager()
    const allTools = mcpManager.listAllTools()

    for (const mcpTool of allTools) {
      // Extract serverId from the tool's id (format: "serverId:toolName")
      const serverId = mcpTool.id.split(':')[0]

      this.mcpToolMap.set(mcpTool.toolName, {
        serverId,
        toolName: mcpTool.toolName
      })
    }
  }

  // ── Tool listing ────────────────────────────────────────────

  /**
   * Get all available tools as ToolDefinition[] (for LLM tool_use parameter).
   * Combines built-in tools + MCP tools.
   * MCP tools are converted from MCPTool format to ToolDefinition.
   */
  getAvailableTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = []

    // Built-in tools
    for (const entry of this.builtInTools.values()) {
      tools.push(entry.definition)
    }

    // MCP tools (converted from MCPTool → ToolDefinition)
    const mcpManager = getMCPClientManager()
    const allMCPTools = mcpManager.listAllTools()

    for (const mcpTool of allMCPTools) {
      tools.push(this.mcpToolToDefinition(mcpTool))
    }

    return tools
  }

  /**
   * Get a specific tool definition by name.
   */
  getToolByName(name: string): ToolDefinition | undefined {
    // Check built-in first
    const builtIn = this.builtInTools.get(name)
    if (builtIn) return builtIn.definition

    // Check MCP tools
    const mcpManager = getMCPClientManager()
    const allMCPTools = mcpManager.listAllTools()
    const mcpTool = allMCPTools.find((t) => t.toolName === name)
    if (mcpTool) return this.mcpToolToDefinition(mcpTool)

    return undefined
  }

  /**
   * Check if a tool is registered (built-in or MCP).
   */
  hasTool(name: string): boolean {
    if (this.builtInTools.has(name)) return true
    return this.mcpToolMap.has(name)
  }

  // ── Tool execution ──────────────────────────────────────────

  /**
   * Execute a tool call and return structured result.
   * Handles both built-in and MCP tools.
   * Enforces timeout and truncates large results.
   */
  async executeTool(toolCall: AgentToolCall): Promise<AgentToolResult> {
    try {
      const result = await Promise.race([
        this.executeToolInner(toolCall),
        this.timeoutPromise(toolCall.id)
      ])
      return result
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        content: `Error executing tool "${toolCall.name}": ${(error as Error).message}`,
        isError: true
      }
    }
  }

  /**
   * Execute multiple tool calls in parallel.
   * Returns results in the same order as the input calls.
   */
  async executeToolCalls(toolCalls: AgentToolCall[]): Promise<AgentToolResult[]> {
    const results = await Promise.allSettled(
      toolCalls.map((tc) => this.executeTool(tc))
    )

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value
      }
      return {
        toolCallId: toolCalls[index].id,
        content: `Tool execution failed: ${result.reason?.message ?? 'Unknown error'}`,
        isError: true
      }
    })
  }

  // ── Private helpers ─────────────────────────────────────────

  private async executeToolInner(toolCall: AgentToolCall): Promise<AgentToolResult> {
    // 1. Check built-in tools first
    const builtIn = this.builtInTools.get(toolCall.name)
    if (builtIn) {
      const result = await builtIn.handler(toolCall.arguments)
      return {
        toolCallId: toolCall.id,
        content: this.truncateResult(result),
        isError: false
      }
    }

    // 2. Check MCP tools
    const mapping = this.mcpToolMap.get(toolCall.name)
    if (mapping) {
      const mcpManager = getMCPClientManager()
      const mcpResult = await mcpManager.executeTool(
        mapping.serverId,
        mapping.toolName,
        toolCall.arguments as Record<string, unknown>
      )

      if (mcpResult.error) {
        return {
          toolCallId: toolCall.id,
          content: `MCP tool error: ${mcpResult.error}`,
          isError: true
        }
      }

      const resultStr = typeof mcpResult.result === 'string'
        ? mcpResult.result
        : JSON.stringify(mcpResult.result, null, 2)

      return {
        toolCallId: toolCall.id,
        content: this.truncateResult(resultStr),
        isError: false
      }
    }

    // 3. Unknown tool
    return {
      toolCallId: toolCall.id,
      content: `Unknown tool: "${toolCall.name}". Available tools: ${this.getToolNames().join(', ')}`,
      isError: true
    }
  }

  /**
   * Convert MCPTool format to ToolDefinition format for LLM APIs.
   */
  private mcpToolToDefinition(mcpTool: MCPTool): ToolDefinition {
    // Ensure inputSchema has the expected structure
    const schema = mcpTool.inputSchema || {}

    return {
      name: mcpTool.toolName,
      description: mcpTool.description || `MCP tool: ${mcpTool.toolName}`,
      inputSchema: {
        type: 'object' as const,
        properties: schema.properties ?? {},
        required: schema.required
      }
    }
  }

  /**
   * Truncate large tool results to prevent excessive token usage.
   */
  private truncateResult(result: string): string {
    if (result.length <= this.config.maxResultChars) return result
    return result.substring(0, this.config.maxResultChars) + '\n... [truncated]'
  }

  /**
   * Create a timeout promise for tool execution.
   */
  private timeoutPromise(toolCallId: string): Promise<AgentToolResult> {
    return new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Tool execution timed out after ${this.config.toolTimeoutMs}ms`)),
        this.config.toolTimeoutMs
      )
    )
  }

  /**
   * Get names of all available tools (for error messages).
   */
  private getToolNames(): string[] {
    const names: string[] = []
    for (const name of this.builtInTools.keys()) names.push(name)
    for (const name of this.mcpToolMap.keys()) names.push(name)
    return names
  }
}

// ── Singleton ──────────────────────────────────────────────────

let registryInstance: ToolRegistry | null = null

export function getToolRegistry(): ToolRegistry {
  if (!registryInstance) {
    registryInstance = new ToolRegistry()

    // Register default built-in tools
    registerDefaultBuiltIns(registryInstance)
  }
  return registryInstance
}

/**
 * Register default built-in tools.
 * These are always available regardless of MCP server state.
 */
function registerDefaultBuiltIns(registry: ToolRegistry): void {
  // Echo tool — useful for testing and debugging the agent loop
  registry.registerBuiltIn(
    {
      name: 'echo',
      description: 'Echo back the input text. Useful for testing and debugging.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo back' }
        },
        required: ['text']
      }
    },
    async (args) => {
      return String(args.text ?? '')
    }
  )

  // decompose_task — structural tool for subagent orchestration.
  // Forces the master LLM to output a structured JSON decomposition.
  registry.registerBuiltIn(
    {
      name: 'decompose_task',
      description:
        'Decompose a complex task into 1-3 independent subtasks that can be executed in parallel. ' +
        'Each subtask should be self-contained and produce a clear result. ' +
        'Use this when a task can be split into parallel workstreams.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Brief summary of the overall task and decomposition strategy'
          },
          subtasks: {
            type: 'array',
            description: 'Array of 1-3 independent subtasks',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short title for the subtask' },
                description: {
                  type: 'string',
                  description: 'Detailed description of what this subtask should accomplish'
                }
              },
              required: ['title', 'description']
            }
          }
        },
        required: ['summary', 'subtasks']
      }
    },
    async (args) => {
      const subtasks = args.subtasks as Array<{ title: string; description: string }> | undefined

      if (!subtasks || !Array.isArray(subtasks) || subtasks.length === 0) {
        return JSON.stringify({ error: 'At least 1 subtask is required' })
      }

      if (subtasks.length > 3) {
        return JSON.stringify({
          error: 'Maximum 3 subtasks allowed. Please consolidate into fewer subtasks.',
          received: subtasks.length
        })
      }

      // Validate each subtask has title and description
      for (let i = 0; i < subtasks.length; i++) {
        if (!subtasks[i].title || !subtasks[i].description) {
          return JSON.stringify({
            error: `Subtask ${i + 1} is missing title or description`
          })
        }
      }

      // Return the validated decomposition
      return JSON.stringify({
        summary: String(args.summary ?? ''),
        subtasks: subtasks.slice(0, 3).map((st, idx) => ({
          title: st.title,
          description: st.description,
          order: idx + 1
        }))
      })
    }
  )
}
