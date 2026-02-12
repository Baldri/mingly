/**
 * ExportService Tests
 * Tests Markdown, JSON, and HTML export format output.
 */

import { describe, it, expect } from 'vitest'
import { ExportService } from '../../src/main/services/export-service'
import type { ExportOptions } from '../../src/main/services/export-service'
import type { Message } from '../../src/shared/types'

const sampleMessages: Message[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'What is 2+2?',
    createdAt: 1700000000000,
    conversationId: 'conv-1'
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: '2+2 equals 4.',
    tokens: 50,
    cost: 0.0003,
    latencyMs: 450,
    createdAt: 1700000001000,
    conversationId: 'conv-1'
  }
]

const baseOptions: ExportOptions = {
  title: 'Test Chat',
  provider: 'anthropic',
  model: 'claude-3-sonnet',
  messages: sampleMessages,
  format: 'markdown'
}

describe('ExportService', () => {
  const service = new ExportService()

  describe('formatMarkdown', () => {
    it('should include title as h1', () => {
      const result = service.formatMarkdown(baseOptions)
      expect(result).toContain('# Test Chat')
    })

    it('should include provider and model metadata', () => {
      const result = service.formatMarkdown(baseOptions)
      expect(result).toContain('**Provider:** anthropic')
      expect(result).toContain('**Model:** claude-3-sonnet')
    })

    it('should include message content', () => {
      const result = service.formatMarkdown(baseOptions)
      expect(result).toContain('What is 2+2?')
      expect(result).toContain('2+2 equals 4.')
    })

    it('should label roles correctly', () => {
      const result = service.formatMarkdown(baseOptions)
      expect(result).toContain('### You')
      expect(result).toContain('### Assistant')
    })

    it('should include assistant metadata', () => {
      const result = service.formatMarkdown(baseOptions)
      expect(result).toContain('50 tokens')
      expect(result).toContain('450ms')
    })

    it('should skip metadata when disabled', () => {
      const result = service.formatMarkdown({ ...baseOptions, includeMetadata: false })
      expect(result).not.toContain('**Provider:**')
      expect(result).not.toContain('50 tokens')
    })
  })

  describe('formatJSON', () => {
    it('should produce valid JSON', () => {
      const result = service.formatJSON(baseOptions)
      expect(() => JSON.parse(result)).not.toThrow()
    })

    it('should include all required fields', () => {
      const parsed = JSON.parse(service.formatJSON(baseOptions))
      expect(parsed.title).toBe('Test Chat')
      expect(parsed.provider).toBe('anthropic')
      expect(parsed.model).toBe('claude-3-sonnet')
      expect(parsed.messageCount).toBe(2)
      expect(parsed.messages).toHaveLength(2)
    })

    it('should include message metadata', () => {
      const parsed = JSON.parse(service.formatJSON(baseOptions))
      expect(parsed.messages[1].tokens).toBe(50)
      expect(parsed.messages[1].cost).toBe(0.0003)
    })

    it('should include export timestamp', () => {
      const parsed = JSON.parse(service.formatJSON(baseOptions))
      expect(parsed.exportedAt).toBeTruthy()
    })
  })

  describe('formatHTML', () => {
    it('should produce valid HTML', () => {
      const result = service.formatHTML(baseOptions)
      expect(result).toContain('<!DOCTYPE html>')
      expect(result).toContain('</html>')
    })

    it('should include title in h1', () => {
      const result = service.formatHTML(baseOptions)
      expect(result).toContain('<h1>Test Chat</h1>')
    })

    it('should include message content', () => {
      const result = service.formatHTML(baseOptions)
      expect(result).toContain('What is 2+2?')
      expect(result).toContain('2+2 equals 4.')
    })

    it('should escape HTML entities', () => {
      const options = {
        ...baseOptions,
        messages: [{ id: 'm1', role: 'user' as const, content: '<script>alert("xss")</script>', createdAt: 1, conversationId: 'c1' }]
      }
      const result = service.formatHTML(options)
      expect(result).not.toContain('<script>')
      expect(result).toContain('&lt;script&gt;')
    })
  })

  describe('export', () => {
    it('should route to correct formatter', () => {
      const md = service.export({ ...baseOptions, format: 'markdown' })
      expect(md).toContain('# Test Chat')

      const json = service.export({ ...baseOptions, format: 'json' })
      expect(() => JSON.parse(json)).not.toThrow()

      const html = service.export({ ...baseOptions, format: 'html' })
      expect(html).toContain('<!DOCTYPE html>')
    })

    it('should throw on unsupported format', () => {
      expect(() => service.export({ ...baseOptions, format: 'pdf' as any })).toThrow('Unsupported')
    })
  })

  describe('with attachments', () => {
    const messagesWithImages: Message[] = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Look at this image',
        createdAt: 1700000000000,
        conversationId: 'conv-1',
        attachments: [{
          id: 'att-1',
          type: 'image',
          mimeType: 'image/png',
          data: 'base64data',
          filename: 'screenshot.png'
        }]
      }
    ]

    it('should include image references in markdown when enabled', () => {
      const result = service.formatMarkdown({
        ...baseOptions,
        messages: messagesWithImages,
        includeImages: true
      })
      expect(result).toContain('![screenshot.png]')
    })

    it('should skip images in markdown when disabled', () => {
      const result = service.formatMarkdown({
        ...baseOptions,
        messages: messagesWithImages,
        includeImages: false
      })
      expect(result).not.toContain('![screenshot.png]')
    })

    it('should include base64 images in HTML when enabled', () => {
      const result = service.formatHTML({
        ...baseOptions,
        messages: messagesWithImages,
        includeImages: true
      })
      expect(result).toContain('data:image/png;base64,base64data')
    })
  })
})
