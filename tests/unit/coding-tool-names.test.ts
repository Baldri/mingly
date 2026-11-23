/**
 * The four coding tools carry a namespace (`mingly_`), so they cannot take a
 * name an MCP server uses.
 *
 * `read_file` and `edit_file` are the most common MCP tool names there are. A
 * built-in owns its name in the registry, open gate or closed, so an unprefixed
 * built-in of that name silently removed a user's filesystem MCP server from
 * every run — including runs with coding mode `off`, because the built-ins are
 * registered unconditionally on the singleton.
 *
 * The expected names here are LITERALS on purpose: a test that read them back
 * from the modules under test would pass whatever they were renamed to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import { registerReadTools } from '../../src/main/coding/read-tools'
import { registerEditTools, createEditProposalStore } from '../../src/main/coding/edit-proposals'
import { registerRunCommand } from '../../src/main/coding/run-command'
import { CODING_MODE_CHOICES, type CodingMode } from '../../src/shared/coding-types'

/** The names a filesystem MCP server typically serves. */
const MCP_NAMES = ['read_file', 'edit_file', 'list_files', 'run_command'] as const

const mcpExecute = vi.fn(async () => ({ result: 'mcp result' }))

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({
    listAllTools: () =>
      ['read_file', 'edit_file', 'list_files', 'run_command'].map((toolName) => ({
        id: `fs-server:${toolName}`,
        serverName: 'fs-server',
        toolName,
        description: `MCP ${toolName}`,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } }
      })),
    executeTool: (...args: unknown[]) => mcpExecute(...(args as []))
  }))
}))

let registry: ToolRegistry

function ctx(mode: CodingMode): ToolContext {
  return { coding: { directoryId: 'dir-1', projectPath: '/tmp/p', mode } }
}

beforeEach(() => {
  mcpExecute.mockClear()
  registry = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: 4000 })
  // The real registrations, with deps that never reach the file system: the
  // question here is which NAME is claimed, not what a handler does.
  registerReadTools(registry, { findGrant: async () => undefined })
  registerEditTools(registry, {
    findGrant: async () => undefined,
    store: createEditProposalStore()
  })
  registerRunCommand(registry, { findGrant: async () => undefined })
  registry.refreshMCPTools()
})

describe('the coding tools do not take an MCP tool name', () => {
  it.each(CODING_MODE_CHOICES.map((c) => c.mode))(
    'offers every MCP name in mode %s',
    (mode) => {
      const names = registry.getAvailableTools(ctx(mode)).map((t) => t.name)
      for (const mcpName of MCP_NAMES) expect(names).toContain(mcpName)
    }
  )

  it('offers every MCP name to a run with no coding context at all', () => {
    const names = registry.getAvailableTools().map((t) => t.name)
    for (const mcpName of MCP_NAMES) expect(names).toContain(mcpName)
  })

  it.each(CODING_MODE_CHOICES.map((c) => c.mode))(
    'executes the MCP read_file in mode %s, reaching the MCP server',
    async (mode) => {
      const [res] = await registry.executeToolCalls(
        [{ id: '1', name: 'read_file', arguments: { path: 'a.ts' } }],
        ctx(mode)
      )
      expect(res.isError).toBe(false)
      expect(res.content).toBe('mcp result')
      expect(mcpExecute).toHaveBeenCalledWith('fs-server', 'read_file', { path: 'a.ts' })
    }
  )

  it('registers the coding tools under their namespaced names', () => {
    const offered = (mode: CodingMode): string[] =>
      registry.getAvailableTools(ctx(mode)).map((t) => t.name)
    expect(offered('read-only')).toContain('mingly_list_files')
    expect(offered('read-only')).toContain('mingly_read_file')
    expect(offered('propose')).toContain('mingly_edit_file')
    expect(offered('propose-run')).toContain('mingly_run_command')
    // The gates still hold: the namespace is not a second way in.
    expect(offered('off')).not.toContain('mingly_read_file')
    expect(offered('read-only')).not.toContain('mingly_edit_file')
    expect(offered('propose')).not.toContain('mingly_run_command')
  })
})
