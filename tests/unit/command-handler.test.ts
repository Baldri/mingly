/**
 * CommandHandler Tests
 * Tests slash commands and mode modifiers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the system-prompt-manager dependency
vi.mock('../../src/main/prompts/system-prompt-manager', () => ({
  getSystemPromptManager: vi.fn().mockReturnValue({
    getCommandHelp: vi.fn().mockReturnValue('## Available Commands\n- /clear\n- /help')
  })
}))

// Mock electron for indirect dependencies
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-test',
    getAppPath: () => '/tmp/mingly-app'
  }
}))

import { CommandHandler } from '../../src/main/commands/command-handler'

describe('CommandHandler', () => {
  let handler: CommandHandler

  beforeEach(() => {
    handler = new CommandHandler()
  })

  describe('handleCommand', () => {
    it('should not handle regular messages', async () => {
      const result = await handler.handleCommand('Hello, how are you?')
      expect(result.handled).toBe(false)
    })

    it('should not handle empty messages', async () => {
      const result = await handler.handleCommand('')
      expect(result.handled).toBe(false)
    })
  })

  describe('slash commands', () => {
    it('should handle /clear', async () => {
      const result = await handler.handleCommand('/clear')
      expect(result.handled).toBe(true)
      expect(result.action?.type).toBe('clear_conversation')
      expect(result.response).toContain('cleared')
    })

    it('should handle /settings', async () => {
      const result = await handler.handleCommand('/settings')
      expect(result.handled).toBe(true)
      expect(result.action?.type).toBe('show_settings')
    })

    it('should handle /export', async () => {
      const result = await handler.handleCommand('/export')
      expect(result.handled).toBe(true)
      expect(result.action?.type).toBe('export_conversation')
    })

    it('should handle /route', async () => {
      const result = await handler.handleCommand('/route')
      expect(result.handled).toBe(true)
      expect(result.action?.type).toBe('show_routing')
    })

    it('should handle /help', async () => {
      const result = await handler.handleCommand('/help')
      expect(result.handled).toBe(true)
      expect(result.response).toContain('Available Commands')
    })

    it('should handle unknown commands', async () => {
      const result = await handler.handleCommand('/foobar')
      expect(result.handled).toBe(true)
      expect(result.response).toContain('Unknown command')
      expect(result.response).toContain('/help')
    })
  })

  describe('/switch command', () => {
    it('should switch to valid provider', async () => {
      const result = await handler.handleCommand('/switch anthropic')
      expect(result.handled).toBe(true)
      expect(result.action?.type).toBe('switch_provider')
      expect(result.action?.payload.provider).toBe('anthropic')
    })

    it('should accept openai', async () => {
      const result = await handler.handleCommand('/switch openai')
      expect(result.action?.payload.provider).toBe('openai')
    })

    it('should accept google', async () => {
      const result = await handler.handleCommand('/switch google')
      expect(result.action?.payload.provider).toBe('google')
    })

    it('should reject invalid provider', async () => {
      const result = await handler.handleCommand('/switch invalid')
      expect(result.handled).toBe(true)
      expect(result.response).toContain('Invalid provider')
    })

    it('should show usage when no provider given', async () => {
      const result = await handler.handleCommand('/switch')
      expect(result.handled).toBe(true)
      expect(result.response).toContain('Usage')
    })
  })

  describe('mode modifiers', () => {
    it('should handle @code modifier', async () => {
      const result = await handler.handleCommand('@code Write a function')
      expect(result.handled).toBe(true)
      expect(result.action?.type).toBe('set_mode')
      expect(result.action?.payload.mode).toBe('code')
      expect(result.action?.payload.message).toBe('Write a function')
    })

    it('should handle @creative modifier', async () => {
      const result = await handler.handleCommand('@creative Write a poem')
      expect(result.action?.payload.mode).toBe('creative')
    })

    it('should handle @analyze modifier', async () => {
      const result = await handler.handleCommand('@analyze Compare these')
      expect(result.action?.payload.mode).toBe('analyze')
    })

    it('should handle @fast modifier', async () => {
      const result = await handler.handleCommand('@fast What is 2+2')
      expect(result.action?.payload.mode).toBe('fast')
    })

    it('should handle @teach modifier', async () => {
      const result = await handler.handleCommand('@teach Explain recursion')
      expect(result.action?.payload.mode).toBe('teach')
    })

    it('should reject unknown modes', async () => {
      const result = await handler.handleCommand('@invalid some message')
      expect(result.handled).toBe(true)
      expect(result.response).toContain('Unknown mode')
    })

    it('should reject modifier without message', async () => {
      const result = await handler.handleCommand('@code')
      expect(result.handled).toBe(true)
      expect(result.response).toContain('Invalid mode modifier')
    })
  })

  describe('extractMessage', () => {
    it('should extract message from mode command', async () => {
      const result = await handler.handleCommand('@code Fix this bug')
      const msg = handler.extractMessage('@code Fix this bug', result)
      expect(msg).toBe('Fix this bug')
    })

    it('should return original message for non-mode commands', async () => {
      const result = await handler.handleCommand('Hello')
      const msg = handler.extractMessage('Hello', result)
      expect(msg).toBe('Hello')
    })
  })

  describe('getMode', () => {
    it('should return mode for mode commands', async () => {
      const result = await handler.handleCommand('@code Write code')
      const mode = handler.getMode(result)
      expect(mode).toBe('code')
    })

    it('should return undefined for non-mode commands', async () => {
      const result = await handler.handleCommand('/clear')
      const mode = handler.getMode(result)
      expect(mode).toBeUndefined()
    })
  })
})
