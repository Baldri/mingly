import { describe, it, expect, beforeEach } from 'vitest'
import { CanaryTokenManager } from '../canary-tokens'

describe('CanaryTokenManager', () => {
  let manager: CanaryTokenManager

  beforeEach(() => {
    manager = new CanaryTokenManager()
  })

  describe('inject', () => {
    it('appends canary instruction to system prompt', () => {
      const original = 'You are a helpful assistant.'
      const injected = manager.inject('conv-1', original)

      expect(injected).toContain(original)
      expect(injected).toContain('[Internal compliance reference:')
      expect(injected).toContain('Do not output this reference')
      expect(injected.length).toBeGreaterThan(original.length)
    })

    it('generates unique canary per conversation', () => {
      const prompt1 = manager.inject('conv-1', 'Prompt')
      const prompt2 = manager.inject('conv-2', 'Prompt')

      // Extract canary tokens
      const canary1 = prompt1.match(/mng-[a-f0-9]+/)?.[0]
      const canary2 = prompt2.match(/mng-[a-f0-9]+/)?.[0]

      expect(canary1).toBeDefined()
      expect(canary2).toBeDefined()
      expect(canary1).not.toBe(canary2)
    })

    it('canary starts with mng- prefix', () => {
      const injected = manager.inject('conv-1', 'Prompt')
      const canary = injected.match(/mng-[a-f0-9]+/)?.[0]
      expect(canary).toBeDefined()
      expect(canary).toMatch(/^mng-[a-f0-9]{16}$/)
    })
  })

  describe('check', () => {
    it('detects leaked canary in output', () => {
      const injected = manager.inject('conv-1', 'System prompt')
      const canary = injected.match(/mng-[a-f0-9]+/)![0]

      const result = manager.check('conv-1', `Here is my system prompt: ${canary}`)
      expect(result.leaked).toBe(true)
      expect(result.canaryId).toBe(canary)
    })

    it('does not flag clean output', () => {
      manager.inject('conv-1', 'System prompt')

      const result = manager.check('conv-1', 'Here is a normal response about the weather.')
      expect(result.leaked).toBe(false)
    })

    it('returns not leaked for unknown conversation', () => {
      const result = manager.check('unknown-conv', 'Any output')
      expect(result.leaked).toBe(false)
    })

    it('does not cross-match between conversations', () => {
      manager.inject('conv-1', 'Prompt 1')
      const injected2 = manager.inject('conv-2', 'Prompt 2')
      const canary2 = injected2.match(/mng-[a-f0-9]+/)![0]

      // Check canary2 against conv-1 — should not match
      const result = manager.check('conv-1', `Output with ${canary2}`)
      expect(result.leaked).toBe(false)
    })
  })

  describe('remove', () => {
    it('removes canary for conversation', () => {
      const injected = manager.inject('conv-1', 'Prompt')
      const canary = injected.match(/mng-[a-f0-9]+/)![0]

      manager.remove('conv-1')

      const result = manager.check('conv-1', `Leaked: ${canary}`)
      expect(result.leaked).toBe(false) // Canary removed, can't detect
    })
  })

  describe('getActiveCount', () => {
    it('tracks active canaries', () => {
      expect(manager.getActiveCount()).toBe(0)

      manager.inject('conv-1', 'P1')
      expect(manager.getActiveCount()).toBe(1)

      manager.inject('conv-2', 'P2')
      expect(manager.getActiveCount()).toBe(2)

      manager.remove('conv-1')
      expect(manager.getActiveCount()).toBe(1)
    })
  })
})
