/**
 * DocMindIntegration Tests
 * Tests DocMind integration: MCP connection, REST configuration, context injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import nodePath from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => nodePath.join(tmpdir(), 'mingly-docmind-test-' + process.pid)
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn()
  },
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn()
}))

const {
  mockConnect, mockDisconnect, mockListTools,
  mockAddServer, mockRemoveServer,
  mockWissenUpdateConfig, mockInjectorUpdateConfig
} = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue({ success: true }),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
  mockListTools: vi.fn().mockReturnValue([
    { toolName: 'search_materials' },
    { toolName: 'get_context' },
    { toolName: 'hybrid_search' }
  ]),
  mockAddServer: vi.fn().mockReturnValue({ id: 'docmind-server-1' }),
  mockRemoveServer: vi.fn().mockResolvedValue(undefined),
  mockWissenUpdateConfig: vi.fn(),
  mockInjectorUpdateConfig: vi.fn()
}))

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn().mockReturnValue({
    addServer: mockAddServer,
    connect: mockConnect,
    disconnect: mockDisconnect,
    listTools: mockListTools,
    removeServer: mockRemoveServer
  })
}))

vi.mock('../../src/main/rag/rag-wissen-client', () => ({
  getRAGWissenClient: vi.fn().mockReturnValue({
    updateConfig: mockWissenUpdateConfig
  })
}))

vi.mock('../../src/main/rag/context-injector', () => ({
  getContextInjector: vi.fn().mockReturnValue({
    updateConfig: mockInjectorUpdateConfig,
    getConfig: vi.fn().mockReturnValue({ ragWissenEnabled: true })
  })
}))

// Mock global fetch for REST health check
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { DocMindIntegration, getDocMindIntegration } from '../../src/main/integrations/docmind-integration'

describe('DocMindIntegration', () => {
  let docmind: DocMindIntegration

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    docmind = new DocMindIntegration()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'healthy', qdrant: 'ok' })
    })
  })

  describe('config', () => {
    it('should initialize with default config', () => {
      const config = docmind.getConfig()
      expect(config.enabled).toBe(true)
      expect(config.mcp.enabled).toBe(true)
      expect(config.rest.enabled).toBe(true)
      expect(config.rest.port).toBe(8000)
    })

    it('should update config', () => {
      docmind.updateConfig({ enabled: false })
      expect(docmind.getConfig().enabled).toBe(false)
    })

    it('should deep-merge nested config', () => {
      docmind.updateConfig({ rest: { port: 9000 } } as any)
      const config = docmind.getConfig()
      expect(config.rest.port).toBe(9000)
      expect(config.rest.host).toBe('localhost') // Should preserve
    })
  })

  describe('connectMCP', () => {
    it('should connect to DocMind MCP server', async () => {
      // Ensure enabled (store may have persisted enabled: false from config test)
      docmind.updateConfig({ enabled: true, mcp: { enabled: true, autoConnect: true } })
      const result = await docmind.connectMCP()
      expect(result.success).toBe(true)
      expect(result.tools).toBe(3)
      expect(mockAddServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'DocMind' })
      )
      expect(mockConnect).toHaveBeenCalled()
    })

    it('should return error when disabled', async () => {
      docmind.updateConfig({ enabled: false })
      const result = await docmind.connectMCP()
      expect(result.success).toBe(false)
      expect(result.error).toContain('disabled')
    })

    it('should return error when MCP server file not found', async () => {
      // Ensure enabled so we reach the file check
      docmind.updateConfig({ enabled: true, mcp: { enabled: true, autoConnect: true } })
      const { existsSync } = await import('fs')
      vi.mocked(existsSync).mockReturnValueOnce(false)
      const result = await docmind.connectMCP()
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  describe('disconnectMCP', () => {
    it('should disconnect MCP server', async () => {
      docmind.updateConfig({ enabled: true, mcp: { enabled: true, autoConnect: true } })
      await docmind.connectMCP() // connect first
      const result = await docmind.disconnectMCP()
      expect(result.success).toBe(true)
    })

    it('should succeed even when not connected', async () => {
      const result = await docmind.disconnectMCP()
      expect(result.success).toBe(true)
    })
  })

  describe('configureRESTClient', () => {
    it('should configure RAG-Wissen client with DocMind REST settings', () => {
      // Ensure enabled and rest.enabled so configureRESTClient proceeds
      docmind.updateConfig({ enabled: true, rest: { enabled: true, host: 'localhost', port: 8000 } })
      docmind.configureRESTClient()
      expect(mockWissenUpdateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'localhost',
          port: 8000,
          apiMode: 'rest',
          enabled: true
        })
      )
    })

    it('should not configure when disabled', () => {
      docmind.updateConfig({ enabled: false })
      docmind.configureRESTClient()
      expect(mockWissenUpdateConfig).not.toHaveBeenCalled()
    })
  })

  describe('checkRESTHealth', () => {
    it('should return available when health endpoint responds', async () => {
      const result = await docmind.checkRESTHealth()
      expect(result.available).toBe(true)
    })

    it('should return unavailable on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 })
      const result = await docmind.checkRESTHealth()
      expect(result.available).toBe(false)
    })

    it('should return unavailable on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))
      const result = await docmind.checkRESTHealth()
      expect(result.available).toBe(false)
      expect(result.error).toContain('Connection refused')
    })
  })

  describe('enableContextInjection', () => {
    it('should enable RAG-Wissen in context injector', () => {
      docmind.enableContextInjection()
      expect(mockInjectorUpdateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ ragWissenEnabled: true })
      )
    })
  })

  describe('initialize', () => {
    it('should initialize all three paths: REST, context injection, MCP', async () => {
      // Ensure enabled for all paths (store may have persisted disabled state)
      docmind.updateConfig({
        enabled: true,
        rest: { enabled: true, host: 'localhost', port: 8000 },
        mcp: { enabled: true, autoConnect: true },
        contextInjection: { enabled: true, collection: 'rag_documents' }
      })
      const result = await docmind.initialize()
      expect(result.rest.available).toBe(true)
      expect(result.contextInjection).toBe(true)
      expect(result.mcp.connected).toBe(true)
    })

    it('should skip when disabled', async () => {
      docmind.updateConfig({ enabled: false })
      const result = await docmind.initialize()
      expect(result.rest.available).toBe(false)
      expect(result.mcp.connected).toBe(false)
      expect(result.contextInjection).toBe(false)
    })
  })

  describe('getStatus', () => {
    it('should return comprehensive status', async () => {
      docmind.updateConfig({ enabled: true, mcp: { enabled: true, autoConnect: true }, rest: { enabled: true, host: 'localhost', port: 8000 } })
      await docmind.connectMCP()
      const status = await docmind.getStatus()
      expect(status.config).toBeDefined()
      expect(status.mcp).toBeDefined()
      expect(status.rest).toBeDefined()
      expect(status.contextInjection).toBeDefined()
    })
  })

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = getDocMindIntegration()
      const b = getDocMindIntegration()
      expect(a).toBe(b)
    })
  })
})
