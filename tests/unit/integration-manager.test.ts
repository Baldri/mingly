/**
 * Integration Manager Tests
 * Tests Slack, Notion, and Obsidian integration flows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-integration-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([])
}))

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn().mockRejectedValue(new Error('ENOENT')),
    readdir: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue(undefined)
  },
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  writeFile: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return {
    ...actual,
    default: actual,
    join: actual.join,
    dirname: actual.dirname,
    basename: actual.basename
  }
})

const mockFetch = vi.fn()
global.fetch = mockFetch

import { IntegrationManager } from '../../src/main/integrations/integration-manager'

describe('IntegrationManager', () => {
  let manager: IntegrationManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    manager = new IntegrationManager()
  })

  describe('getStatus', () => {
    it('should return default unconfigured status', () => {
      const status = manager.getStatus()
      expect(status.slack.configured).toBe(false)
      expect(status.notion.configured).toBe(false)
      expect(status.obsidian.configured).toBe(false)
    })
  })

  // ---- Slack ----

  describe('configureSlack', () => {
    it('should reject invalid webhook URL', () => {
      const result = manager.configureSlack('https://example.com/hook')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid Slack webhook URL')
    })

    it('should accept valid webhook URL', () => {
      const result = manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      expect(result.success).toBe(true)
    })

    it('should set team name', () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx', 'Test Team')
      const status = manager.getStatus()
      expect(status.slack.configured).toBe(true)
      expect(status.slack.teamName).toBe('Test Team')
    })

    it('should default team name to "Slack Workspace"', () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      const status = manager.getStatus()
      expect(status.slack.teamName).toBe('Slack Workspace')
    })

    it('should emit integration-changed event', () => {
      const spy = vi.fn()
      manager.on('integration-changed', spy)
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      expect(spy).toHaveBeenCalledWith('slack')
    })
  })

  describe('disconnectSlack', () => {
    it('should reset slack config', () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      const result = manager.disconnectSlack()
      expect(result.success).toBe(true)
      expect(manager.getStatus().slack.configured).toBe(false)
    })
  })

  describe('shareToSlack', () => {
    it('should fail when no webhook configured', async () => {
      const result = await manager.shareToSlack({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Test'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('webhook not configured')
    })

    it('should post to slack webhook', async () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      mockFetch.mockResolvedValueOnce({ ok: true })

      const result = await manager.shareToSlack({
        conversationId: 'c1',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there', provider: 'anthropic' }
        ],
        title: 'Chat'
      })
      expect(result.success).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should use custom webhook URL from params', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })

      const result = await manager.shareToSlack({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Chat',
        webhookUrl: 'https://hooks.slack.com/services/custom'
      })
      expect(result.success).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://hooks.slack.com/services/custom',
        expect.objectContaining({ method: 'POST' })
      )
    })

    it('should handle Slack API error response', async () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })

      const result = await manager.shareToSlack({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Chat'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('403')
    })

    it('should handle fetch error', async () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const result = await manager.shareToSlack({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Chat'
      })
      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })

    it('should truncate long messages', async () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      mockFetch.mockResolvedValueOnce({ ok: true })

      const longContent = 'x'.repeat(3000)
      await manager.shareToSlack({
        conversationId: 'c1',
        messages: [{ role: 'user', content: longContent }],
        title: 'Chat'
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      // The message block should be truncated to 2000 chars + "..."
      const messageBlock = body.blocks.find((b: any) => b.type === 'section')
      expect(messageBlock.text.text.length).toBeLessThan(longContent.length + 20)
    })

    it('should limit to last 10 messages', async () => {
      manager.configureSlack('https://hooks.slack.com/services/T00/B00/xxx')
      mockFetch.mockResolvedValueOnce({ ok: true })

      const messages = Array.from({ length: 15 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`
      }))

      await manager.shareToSlack({
        conversationId: 'c1',
        messages,
        title: 'Chat'
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      // header + divider + 10 messages + divider + context = 14
      const sectionBlocks = body.blocks.filter((b: any) => b.type === 'section')
      expect(sectionBlocks.length).toBe(10)
    })
  })

  // ---- Notion ----

  describe('configureNotion', () => {
    it('should reject invalid API key', () => {
      const result = manager.configureNotion('invalid-key')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid Notion API key')
    })

    it('should accept ntn_ prefixed key', () => {
      const result = manager.configureNotion('ntn_test123')
      expect(result.success).toBe(true)
    })

    it('should accept secret_ prefixed key', () => {
      const result = manager.configureNotion('secret_test123')
      expect(result.success).toBe(true)
    })

    it('should set workspace name', () => {
      manager.configureNotion('ntn_test', 'My Workspace')
      const status = manager.getStatus()
      expect(status.notion.configured).toBe(true)
      expect(status.notion.workspaceName).toBe('My Workspace')
    })

    it('should default workspace name', () => {
      manager.configureNotion('ntn_test')
      expect(manager.getStatus().notion.workspaceName).toBe('Notion Workspace')
    })
  })

  describe('disconnectNotion', () => {
    it('should reset notion config', () => {
      manager.configureNotion('ntn_test')
      const result = manager.disconnectNotion()
      expect(result.success).toBe(true)
      expect(manager.getStatus().notion.configured).toBe(false)
    })
  })

  describe('saveToNotion', () => {
    it('should fail when not configured', async () => {
      const result = await manager.saveToNotion({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Test'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Notion not configured')
    })

    it('should save to Notion API', async () => {
      manager.configureNotion('ntn_test123')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://notion.so/page-123' })
      })

      const result = await manager.saveToNotion({
        conversationId: 'c1',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi', provider: 'anthropic', model: 'claude-3' }
        ],
        title: 'Chat'
      })
      expect(result.success).toBe(true)
      expect(result.pageUrl).toBe('https://notion.so/page-123')
    })

    it('should use databaseId when provided', async () => {
      manager.configureNotion('ntn_test123')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://notion.so/page-456' })
      })

      await manager.saveToNotion({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Chat',
        databaseId: 'db-123'
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.parent.database_id).toBe('db-123')
    })

    it('should handle Notion API error', async () => {
      manager.configureNotion('ntn_test123')
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Unauthorized' })
      })

      const result = await manager.saveToNotion({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Chat'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('401')
    })

    it('should handle fetch error', async () => {
      manager.configureNotion('ntn_test123')
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const result = await manager.saveToNotion({
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'Hello' }],
        title: 'Chat'
      })
      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })

  // ---- Obsidian ----

  describe('setObsidianVault', () => {
    it('should fail when directory does not exist', async () => {
      const fsp = await import('fs/promises')
      vi.mocked(fsp.access).mockRejectedValue(new Error('ENOENT'))

      const result = await manager.setObsidianVault('/nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toContain('does not exist')
    })

    it('should configure vault when directory exists', async () => {
      const fsp = await import('fs/promises')
      vi.mocked(fsp.access).mockResolvedValue(undefined)
      vi.mocked(fsp.readdir).mockResolvedValue([])

      const result = await manager.setObsidianVault('/home/user/vault')
      expect(result.success).toBe(true)
      expect(result.fileCount).toBe(0)
      expect(manager.getStatus().obsidian.configured).toBe(true)
    })
  })

  describe('indexObsidianVault', () => {
    it('should fail when vault not configured', async () => {
      const result = await manager.indexObsidianVault()
      expect(result.success).toBe(false)
      expect(result.error).toContain('not configured')
    })
  })

  describe('disconnectObsidian', () => {
    it('should reset obsidian config', async () => {
      const fsp = await import('fs/promises')
      vi.mocked(fsp.access).mockResolvedValue(undefined)
      vi.mocked(fsp.readdir).mockResolvedValue([])
      await manager.setObsidianVault('/home/user/vault')

      const result = manager.disconnectObsidian()
      expect(result.success).toBe(true)
      expect(manager.getStatus().obsidian.configured).toBe(false)
    })
  })
})
