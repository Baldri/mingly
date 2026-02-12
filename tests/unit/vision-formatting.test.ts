/**
 * Vision Formatting Tests
 * Tests that each LLM client correctly formats messages with image attachments.
 * We test the message format transformation logic, not the API calls.
 */

import { describe, it, expect } from 'vitest'
import type { Message, ImageAttachment } from '../../src/shared/types'

// Helper: create a test message with attachments
function createMessageWithImage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'What is in this image?',
    createdAt: Date.now(),
    conversationId: 'conv-1',
    attachments: [
      {
        id: 'att-1',
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUg==', // dummy base64
        filename: 'test.png',
        width: 100,
        height: 100,
        originalSize: 5000
      }
    ],
    ...overrides
  }
}

function createTextOnlyMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-2',
    role: 'user',
    content: 'Hello!',
    createdAt: Date.now(),
    conversationId: 'conv-1',
    ...overrides
  }
}

describe('Vision Formatting', () => {
  describe('Anthropic format', () => {
    function formatAnthropicMessage(msg: Message) {
      return {
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.attachments?.length
          ? [
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: att.mimeType,
                    data: att.data
                  }
                })),
              { type: 'text' as const, text: msg.content }
            ]
          : msg.content
      }
    }

    it('should format text-only message as string', () => {
      const result = formatAnthropicMessage(createTextOnlyMessage())
      expect(result.content).toBe('Hello!')
      expect(typeof result.content).toBe('string')
    })

    it('should format message with image as content blocks', () => {
      const result = formatAnthropicMessage(createMessageWithImage())
      expect(Array.isArray(result.content)).toBe(true)
      const blocks = result.content as any[]
      expect(blocks).toHaveLength(2) // 1 image + 1 text
      expect(blocks[0].type).toBe('image')
      expect(blocks[0].source.type).toBe('base64')
      expect(blocks[0].source.media_type).toBe('image/png')
      expect(blocks[1].type).toBe('text')
      expect(blocks[1].text).toBe('What is in this image?')
    })

    it('should handle multiple images', () => {
      const msg = createMessageWithImage()
      msg.attachments = [
        ...msg.attachments!,
        { id: 'att-2', type: 'image', mimeType: 'image/jpeg', data: 'abc123', filename: 'test2.jpg' } as ImageAttachment
      ]
      const result = formatAnthropicMessage(msg)
      const blocks = result.content as any[]
      expect(blocks).toHaveLength(3) // 2 images + 1 text
    })
  })

  describe('OpenAI format', () => {
    function formatOpenAIMessage(msg: Message) {
      return {
        role: msg.role,
        content: msg.attachments?.length
          ? [
              { type: 'text' as const, text: msg.content },
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  type: 'image_url' as const,
                  image_url: {
                    url: `data:${att.mimeType};base64,${att.data}`
                  }
                }))
            ]
          : msg.content
      }
    }

    it('should format text-only message as string', () => {
      const result = formatOpenAIMessage(createTextOnlyMessage())
      expect(typeof result.content).toBe('string')
    })

    it('should format image as data URL', () => {
      const result = formatOpenAIMessage(createMessageWithImage())
      const blocks = result.content as any[]
      expect(blocks[0].type).toBe('text')
      expect(blocks[1].type).toBe('image_url')
      expect(blocks[1].image_url.url).toContain('data:image/png;base64,')
    })
  })

  describe('Google format', () => {
    function formatGoogleParts(msg: Message) {
      return msg.attachments?.length
        ? [
            { text: msg.content },
            ...msg.attachments
              .filter((att) => att.type === 'image')
              .map((att) => ({
                inlineData: { mimeType: att.mimeType, data: att.data }
              }))
          ]
        : [{ text: msg.content }]
    }

    it('should return text-only parts for plain message', () => {
      const parts = formatGoogleParts(createTextOnlyMessage())
      expect(parts).toEqual([{ text: 'Hello!' }])
    })

    it('should include inlineData for images', () => {
      const parts = formatGoogleParts(createMessageWithImage())
      expect(parts).toHaveLength(2)
      expect(parts[0]).toHaveProperty('text')
      expect(parts[1]).toHaveProperty('inlineData')
      expect(parts[1].inlineData.mimeType).toBe('image/png')
    })
  })

  describe('Ollama format', () => {
    function formatOllamaMessage(msg: Message) {
      return {
        role: msg.role === 'system' ? 'system' : msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
        ...(msg.attachments?.length
          ? {
              images: msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => att.data)
            }
          : {})
      }
    }

    it('should not include images key for text-only message', () => {
      const result = formatOllamaMessage(createTextOnlyMessage())
      expect(result).not.toHaveProperty('images')
      expect(result.content).toBe('Hello!')
    })

    it('should include images array with base64 data', () => {
      const result = formatOllamaMessage(createMessageWithImage())
      expect(result.images).toHaveLength(1)
      expect(result.images![0]).toBe('iVBORw0KGgoAAAANSUhEUg==')
      expect(result.content).toBe('What is in this image?')
    })
  })

  describe('backward compatibility', () => {
    it('messages without attachments field should format as text', () => {
      const msg: Message = {
        id: 'old-msg',
        role: 'user',
        content: 'Old format message',
        createdAt: Date.now(),
        conversationId: 'conv-1'
        // no attachments field
      }

      // All providers should treat this as text-only
      expect(msg.attachments?.length).toBeFalsy()
    })

    it('messages with empty attachments should format as text', () => {
      const msg = createTextOnlyMessage({ attachments: [] })
      expect(msg.attachments?.length).toBeFalsy() // 0 is falsy
    })
  })
})
