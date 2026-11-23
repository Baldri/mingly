/**
 * EVERY built-in the default registry registers carries the `mingly_` namespace.
 *
 * A built-in owns its name in the registry, open gate or closed, and
 * registerDefaultBuiltIns runs unconditionally on the singleton every run uses.
 * So an unprefixed built-in removes an MCP server's tool of that name from
 * every run — the same defect the four coding tools were namespaced to avoid,
 * one name further along: `echo` and `decompose_task` are names an MCP server
 * may well serve.
 *
 * The MCP manager is mocked EMPTY here on purpose, so every name the registry
 * offers is a built-in; the expected prefix is a literal.
 */
import { describe, it, expect, vi } from 'vitest'
import { getToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({ listAllTools: vi.fn().mockReturnValue([]) }))
}))

const PREFIX = 'mingly_'

function codingCtx(): ToolContext {
  return { coding: { directoryId: 'dir-1', projectPath: '/tmp/p', mode: 'propose-run' } }
}

describe('default built-in tool names', () => {
  it('offers nothing unprefixed to a run with no coding context', () => {
    const names = getToolRegistry().getAvailableTools().map((t) => t.name)
    // Positive control: the ungated built-ins ARE in this list, so the
    // assertion below is not passing on an empty set.
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => !n.startsWith(PREFIX))).toEqual([])
  })

  it('offers nothing unprefixed in the widest coding mode either', () => {
    const names = getToolRegistry().getAvailableTools(codingCtx()).map((t) => t.name)
    // Positive control: this is the real registry, with the coding tools in it.
    for (const expected of [
      'mingly_list_files',
      'mingly_read_file',
      'mingly_edit_file',
      'mingly_run_command'
    ]) {
      expect(names).toContain(expected)
    }
    expect(names.filter((n) => !n.startsWith(PREFIX))).toEqual([])
  })
})
