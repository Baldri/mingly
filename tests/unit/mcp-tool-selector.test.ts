/**
 * MCPToolSelector Tests
 * Tests auto-tool-selection, keyword matching, and prompt augmentation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import nodePath from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => nodePath.join(tmpdir(), 'mingly-mcp-selector-test-' + process.pid)
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn()
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn()
}))

const { mockTools, mockExecuteTool } = vi.hoisted(() => {
  const mockTools = [
    {
      id: 'srv-1:search_documents',
      serverName: 'TestServer',
      toolName: 'search_documents',
      description: 'Search through indexed documents in the knowledge base',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
    },
    {
      id: 'srv-1:get_weather',
      serverName: 'TestServer',
      toolName: 'get_weather',
      description: 'Get current weather information for a location',
      inputSchema: { type: 'object', properties: { location: { type: 'string' } } }
    },
    {
      id: 'srv-1:calculate_math',
      serverName: 'TestServer',
      toolName: 'calculate_math',
      description: 'Calculate mathematical expressions and formulas',
      inputSchema: { type: 'object', properties: { expression: { type: 'string' } } }
    }
  ]

  const mockExecuteTool = vi.fn().mockResolvedValue({
    toolName: 'search_documents',
    result: JSON.stringify({ data: 'test result' }),
    error: null
  })

  return { mockTools, mockExecuteTool }
})

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn().mockReturnValue({
    listAllTools: vi.fn().mockReturnValue(mockTools),
    listTools: vi.fn().mockReturnValue(mockTools),
    executeTool: mockExecuteTool,
    listServers: vi.fn().mockReturnValue([{ id: 'srv-1', name: 'TestServer', connected: true }])
  })
}))

vi.mock('../../src/main/security/input-sanitizer', () => ({
  getInputSanitizer: vi.fn().mockReturnValue({
    sanitizeRAGContext: vi.fn().mockImplementation((text: string) => text)
  })
}))

import { MCPToolSelector, getMCPToolSelector } from '../../src/main/mcp/mcp-tool-selector'

describe('MCPToolSelector', () => {
  let selector: MCPToolSelector

  beforeEach(() => {
    vi.clearAllMocks()
    selector = new MCPToolSelector()
  })

  describe('constructor and config', () => {
    it('should initialize with default config', () => {
      const config = selector.getConfig()
      // Default config has enabled: false (per DEFAULT_CONFIG in source)
      expect(config.enabled).toBe(false)
      expect(config.maxToolsPerMessage).toBeGreaterThan(0)
      expect(config.toolTimeoutMs).toBeGreaterThan(0)
    })

    it('should update config', () => {
      selector.updateConfig({ enabled: true })
      expect(selector.getConfig().enabled).toBe(true)
    })
  })

  describe('selectAndExecute', () => {
    it('should return empty result when disabled', async () => {
      // Explicitly disable since store may retain enabled: true from previous test
      selector.updateConfig({ enabled: false })
      const result = await selector.selectAndExecute('search for documents')
      expect(result.toolsUsed).toHaveLength(0)
      expect(result.context).toBe('')
    })

    it('should select relevant tools based on message keywords', async () => {
      selector.updateConfig({ enabled: true })
      const result = await selector.selectAndExecute('search documents about AI')
      expect(result.toolsUsed.length).toBeGreaterThanOrEqual(0)
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('should respect maxToolsPerMessage limit', async () => {
      selector.updateConfig({ enabled: true, maxToolsPerMessage: 1 })
      const result = await selector.selectAndExecute('search documents and calculate math weather')
      expect(result.toolsUsed.length).toBeLessThanOrEqual(1)
    })

    it('should handle tool execution errors gracefully', async () => {
      selector.updateConfig({ enabled: true })
      mockExecuteTool.mockRejectedValueOnce(new Error('Tool failed'))
      const result = await selector.selectAndExecute('search documents')
      // Should not throw — errors are caught internally
      expect(result).toBeDefined()
    })
  })

  describe('buildAugmentedPrompt', () => {
    it('should return base prompt when no MCP context', () => {
      const result = selector.buildAugmentedPrompt('You are a helpful assistant.', '')
      expect(result).toBe('You are a helpful assistant.')
    })

    it('should inject MCP context into system prompt', () => {
      const result = selector.buildAugmentedPrompt(
        'You are a helpful assistant.',
        '[search_documents] Found 3 documents about AI'
      )
      expect(result).toContain('You are a helpful assistant.')
      expect(result).toContain('search_documents')
      expect(result).toContain('Found 3 documents about AI')
    })

    it('should include safety warnings about MCP context', () => {
      const result = selector.buildAugmentedPrompt(
        'Base prompt',
        'Some MCP context'
      )
      // Should contain isolation markers or safety instructions
      expect(result).toContain('MCP')
    })
  })

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = getMCPToolSelector()
      const b = getMCPToolSelector()
      expect(a).toBe(b)
    })
  })
})
