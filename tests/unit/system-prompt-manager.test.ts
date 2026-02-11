/**
 * SystemPromptManager Tests
 * Tests prompt loading, building, and command help.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-spm-test',
    getAppPath: () => '/tmp/mingly-app'
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    promises: {
      readFile: vi.fn().mockRejectedValue(new Error('Not found')),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
  },
  existsSync: vi.fn().mockReturnValue(false),
  promises: {
    readFile: vi.fn().mockRejectedValue(new Error('Not found')),
    writeFile: vi.fn().mockResolvedValue(undefined)
  }
}))

import { SystemPromptManager } from '../../src/main/prompts/system-prompt-manager'

describe('SystemPromptManager', () => {
  let manager: SystemPromptManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new SystemPromptManager()
  })

  describe('loadPrompts', () => {
    it('should return fallback prompts when files not found', async () => {
      const prompts = await manager.loadPrompts()

      expect(prompts.soul).toContain('helpful AI assistant')
      expect(prompts.skills).toContain('code')
      expect(prompts.personality).toContain('helpful')
    })

    it('should cache prompts after first load', async () => {
      const first = await manager.loadPrompts()
      const second = await manager.loadPrompts()

      // Should be same object (cached)
      expect(first).toBe(second)
    })
  })

  describe('buildSystemPrompt', () => {
    it('should include soul section', async () => {
      const prompt = await manager.buildSystemPrompt()
      expect(prompt).toContain('System Instructions')
    })

    it('should include skills by default', async () => {
      const prompt = await manager.buildSystemPrompt()
      expect(prompt).toContain('code')
    })

    it('should exclude skills when asked', async () => {
      const withSkills = await manager.buildSystemPrompt({ includeSkills: true })
      const withoutSkills = await manager.buildSystemPrompt({ includeSkills: false })

      // Without skills should be shorter
      expect(withoutSkills.length).toBeLessThan(withSkills.length)
    })

    it('should add mode instructions when customMode is set', async () => {
      const prompt = await manager.buildSystemPrompt({ customMode: 'code' })
      expect(prompt).toContain('Code Mode Active')
    })

    it('should add creative mode instructions', async () => {
      const prompt = await manager.buildSystemPrompt({ customMode: 'creative' })
      expect(prompt).toContain('Creative Mode Active')
    })

    it('should add analysis mode instructions', async () => {
      const prompt = await manager.buildSystemPrompt({ customMode: 'analysis' })
      expect(prompt).toContain('Analysis Mode Active')
    })

    it('should add fast mode instructions', async () => {
      const prompt = await manager.buildSystemPrompt({ customMode: 'fast' })
      expect(prompt).toContain('Quick Mode Active')
    })

    it('should add teach mode instructions', async () => {
      const prompt = await manager.buildSystemPrompt({ customMode: 'teach' })
      expect(prompt).toContain('Teaching Mode Active')
    })

    it('should handle unknown mode gracefully', async () => {
      const prompt = await manager.buildSystemPrompt({ customMode: 'unknown' })
      // Should not crash, just not add mode section
      expect(prompt).toBeTruthy()
    })
  })

  describe('getCommandHelp', () => {
    it('should return help text', () => {
      const help = manager.getCommandHelp()
      expect(help).toContain('/clear')
      expect(help).toContain('/switch')
      expect(help).toContain('/help')
      expect(help).toContain('@code')
      expect(help).toContain('@creative')
    })
  })

  describe('reloadPrompts', () => {
    it('should clear cache and reload', async () => {
      // Load once (caches)
      const first = await manager.loadPrompts()
      // Reload (clears cache)
      await manager.reloadPrompts()
      // Load again (should get fresh data)
      const second = await manager.loadPrompts()

      // Different object references since cache was cleared
      expect(first).not.toBe(second)
    })
  })
})
