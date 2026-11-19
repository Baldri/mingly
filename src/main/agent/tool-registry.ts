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
import type { CodingRunOptions } from '../../shared/coding-types'
import type { ProjectWorkspace } from '../coding/project-workspace'
import type { StepPaths } from './step-paths'
import { registerReadTools } from '../coding/read-tools'
import { registerEditTools } from '../coding/edit-proposals'

// ── Built-in tool handler type ─────────────────────────────────

/**
 * What a run tells the registry about itself. `coding` is exactly the
 * CodingRunOptions type, not a second structure with the same fields.
 * Comparison and subagent runs pass no context at all.
 */
export interface ToolContext {
  coding?: CodingRunOptions
  /**
   * The run's project workspace: the ONE instance the executor created. A
   * handler reads it from here and never calls ensureProjectWorkspace itself
   * (two instances per run would mean duplicate filesystem work and a race on
   * the same directories). Absent for non-coding runs.
   */
  workspace?: ProjectWorkspace
  /**
   * Where coding tools report the path they ACTUALLY read (resolved real path,
   * display form), keyed by `callKey`. One sink per loop step; the executor
   * reads it when it builds the guard's origin, so a consent dialog names the
   * file that was read and not the spelling the model used.
   */
  resolvedPaths?: StepPaths
  /**
   * Minted by the registry, per call, on the context a handler receives (the
   * index of the call in its step). Never derived from the provider's call id:
   * that arrives from outside, may repeat and may be empty.
   */
  callKey?: string
  /**
   * The run this call belongs to and the 1-based loop step it runs in. Set by
   * the executor from its own counters (never from the model or the provider).
   * Proposals are keyed on them; a tool that needs them and finds them missing
   * must refuse.
   */
  runId?: string
  stepNumber?: number
}

/**
 * Decides whether a built-in tool exists for a run. Absent context means the
 * strictest caller, so a coding gate must answer `false` for `undefined`.
 */
export type ToolGate = (ctx: ToolContext | undefined) => boolean

export type BuiltInToolHandler = (
  args: Record<string, unknown>,
  ctx?: ToolContext
) => Promise<string>

interface BuiltInToolEntry {
  definition: ToolDefinition
  handler: BuiltInToolHandler
  gate?: ToolGate
}

/**
 * Evaluate a gate fail-closed: no gate means always available; anything other
 * than a literal `true` (false, a truthy non-boolean, a throw) means closed.
 */
function gateAllows(entry: BuiltInToolEntry, ctx: ToolContext | undefined): boolean {
  if (!entry.gate) return true
  try {
    return entry.gate(ctx) === true
  } catch {
    return false
  }
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

  /**
   * The result budget in chars. Tools that page their own output size the
   * whole result (hint included) to this, so the single cut in truncateResult
   * never removes the part that tells the model how to continue.
   */
  getMaxResultChars(): number {
    return this.config.maxResultChars
  }

  // ── Registration ────────────────────────────────────────────

  /**
   * Register a built-in tool with its handler function.
   * Built-in tools are independent of MCP server state. Without a `gate` the
   * tool is always available; with one it is offered (and run) only for a
   * context the gate accepts.
   */
  registerBuiltIn(
    definition: ToolDefinition,
    handler: BuiltInToolHandler,
    gate?: ToolGate
  ): void {
    this.builtInTools.set(definition.name, { definition, handler, gate })
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
  getAvailableTools(ctx?: ToolContext): ToolDefinition[] {
    const tools: ToolDefinition[] = []

    // Built-in tools — a tool whose gate says no is not offered at all
    for (const entry of this.builtInTools.values()) {
      if (gateAllows(entry, ctx)) tools.push(entry.definition)
    }

    // MCP tools (converted from MCPTool → ToolDefinition)
    const mcpManager = getMCPClientManager()
    const allMCPTools = mcpManager.listAllTools()

    for (const mcpTool of allMCPTools) {
      // A built-in of the same name owns that name, whatever its gate says:
      // open, it is already listed above (and wins at execution); closed, the
      // name must not be offered through the MCP tool either, or the model
      // would see a name it may not use.
      if (this.builtInTools.has(mcpTool.toolName)) continue
      tools.push(this.mcpToolToDefinition(mcpTool))
    }

    // KV-Cache optimization: sort tools alphabetically for deterministic ordering.
    // This ensures the tool definitions portion of the prompt is identical across
    // turns, maximizing prefix cache hits (90% cost reduction on Anthropic).
    tools.sort((a, b) => a.name.localeCompare(b.name))

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
  async executeTool(toolCall: AgentToolCall, ctx?: ToolContext): Promise<AgentToolResult> {
    try {
      const result = await this.executeWithTimeout(toolCall, ctx)
      return result
    } catch (error) {
      const err = error as Error
      // Error Preservation: include tool name and args for LLM learning
      // Note: Stack traces logged locally only — not sent to cloud LLMs (prevents path leakage)
      const argsPreview = JSON.stringify(toolCall.arguments).substring(0, 300)
      if (err.stack) {
        console.debug(`[ToolRegistry] Tool "${toolCall.name}" error stack:`, err.stack)
      }
      return {
        toolCallId: toolCall.id,
        content: `Error executing tool "${toolCall.name}" with args ${argsPreview}: [${err.name ?? 'Error'}] ${err.message}`,
        isError: true
      }
    }
  }

  /**
   * Execute multiple tool calls in parallel.
   * Returns results in the same order as the input calls.
   */
  async executeToolCalls(
    toolCalls: AgentToolCall[],
    ctx?: ToolContext
  ): Promise<AgentToolResult[]> {
    // The key a handler reports under is the call's index in THIS step, minted
    // here: nothing security-relevant may hang off the provider's call id.
    const results = await Promise.allSettled(
      toolCalls.map((tc, index) =>
        this.executeTool(tc, ctx ? { ...ctx, callKey: String(index) } : ctx)
      )
    )

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value
      }
      const err = result.reason as Error | undefined
      const argsPreview = JSON.stringify(toolCalls[index].arguments).substring(0, 300)
      return {
        toolCallId: toolCalls[index].id,
        content: `Tool "${toolCalls[index].name}" failed (args: ${argsPreview}): [${err?.name ?? 'Error'}] ${err?.message ?? 'Unknown error'}`,
        isError: true
      }
    })
  }

  // ── Private helpers ─────────────────────────────────────────

  private async executeToolInner(
    toolCall: AgentToolCall,
    ctx?: ToolContext
  ): Promise<AgentToolResult> {
    // 1. Check built-in tools first
    const builtIn = this.builtInTools.get(toolCall.name)
    if (builtIn) {
      // Second check, independent of getAvailableTools: a model can name a tool
      // it was never offered, and the two methods have different callers.
      // Deliberately does not fall through to an MCP tool of the same name.
      if (!gateAllows(builtIn, ctx)) {
        return {
          toolCallId: toolCall.id,
          content: `Unknown tool: "${toolCall.name}". Available tools: ${this.getToolNames(ctx).join(', ')}`,
          isError: true
        }
      }
      const result = await builtIn.handler(toolCall.arguments, ctx)
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
        // Error Preservation: include server + tool + args context for LLM learning
        const argsPreview = JSON.stringify(toolCall.arguments).substring(0, 300)
        return {
          toolCallId: toolCall.id,
          content: `MCP tool error in "${toolCall.name}" (server: ${mapping.serverId}, args: ${argsPreview}): ${mcpResult.error}`,
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
      content: `Unknown tool: "${toolCall.name}". Available tools: ${this.getToolNames(ctx).join(', ')}`,
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
   * Execute a tool with a properly clearable timeout.
   * Prevents timer resource leaks when the tool completes before the timeout.
   */
  private executeWithTimeout(
    toolCall: AgentToolCall,
    ctx?: ToolContext
  ): Promise<AgentToolResult> {
    return new Promise<AgentToolResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Tool execution timed out after ${this.config.toolTimeoutMs}ms`)),
        this.config.toolTimeoutMs
      )

      this.executeToolInner(toolCall, ctx)
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((err) => {
          clearTimeout(timer)
          reject(err)
        })
    })
  }

  /**
   * Get names of all available tools (for error messages).
   */
  private getToolNames(ctx?: ToolContext): string[] {
    const names: string[] = []
    for (const [name, entry] of this.builtInTools) {
      if (gateAllows(entry, ctx)) names.push(name)
    }
    // A built-in owns its name even while its gate is closed: listing the MCP
    // tool of that name would put a refused name into the refusal itself.
    for (const name of this.mcpToolMap.keys()) {
      if (!this.builtInTools.has(name)) names.push(name)
    }
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
  // Coding read tools (gated: offered only in a coding run of mode read-only or above)
  registerReadTools(registry)
  // Coding edit tool (gated: offered only in mode propose or above; it records a proposal, it never writes)
  registerEditTools(registry)

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
