/**
 * AttachmentModel Tests
 * Tests CRUD operations on the message_attachments table (mocking DB layer).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn().mockReturnValue([]),
  dbGet: vi.fn().mockReturnValue(null)
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn().mockReturnValue('att-id-1234')
}))

import { AttachmentModel } from '../../src/main/database/models/attachment'
import { dbRun, dbAll } from '../../src/main/database/index'
import type { MessageAttachment } from '../../src/shared/types'

const sampleAttachment: MessageAttachment = {
  id: 'att-1',
  type: 'image',
  mimeType: 'image/png',
  data: 'base64data',
  filename: 'test.png',
  width: 100,
  height: 100,
  originalSize: 5000
}

describe('AttachmentModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('create', () => {
    it('should create an attachment and call dbRun', () => {
      AttachmentModel.create('msg-1', sampleAttachment)

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('INSERT INTO message_attachments')
      expect(params[1]).toBe('msg-1') // message_id
      expect(params[2]).toBe('image') // type
      expect(params[3]).toBe('image/png') // mime_type
      expect(params[4]).toBe('base64data') // data
      expect(params[5]).toBe('test.png') // filename
    })
  })

  describe('createMany', () => {
    it('should create multiple attachments', () => {
      const attachments: MessageAttachment[] = [
        sampleAttachment,
        { ...sampleAttachment, id: 'att-2', mimeType: 'image/jpeg', filename: 'photo.jpg' }
      ]

      AttachmentModel.createMany('msg-1', attachments)

      expect(dbRun).toHaveBeenCalledTimes(2)
    })

    it('should handle empty array', () => {
      AttachmentModel.createMany('msg-1', [])
      expect(dbRun).not.toHaveBeenCalled()
    })
  })

  describe('findByMessage', () => {
    it('should return empty array when no attachments', () => {
      (dbAll as any).mockReturnValue([])
      expect(AttachmentModel.findByMessage('msg-1')).toEqual([])
    })

    it('should map rows to MessageAttachment objects', () => {
      (dbAll as any).mockReturnValue([
        {
          id: 'att-1',
          message_id: 'msg-1',
          type: 'image',
          mime_type: 'image/png',
          data: 'base64data',
          filename: 'test.png',
          width: 100,
          height: 100,
          original_size: 5000,
          created_at: Date.now()
        }
      ])

      const attachments = AttachmentModel.findByMessage('msg-1')
      expect(attachments).toHaveLength(1)
      expect(attachments[0].type).toBe('image')
      expect(attachments[0].mimeType).toBe('image/png')
      expect(attachments[0].data).toBe('base64data')
      expect(attachments[0].filename).toBe('test.png')
    })
  })

  describe('findByMessages', () => {
    it('should return empty map for empty input', () => {
      const result = AttachmentModel.findByMessages([])
      expect(result.size).toBe(0)
      expect(dbAll).not.toHaveBeenCalled()
    })

    it('should batch-load attachments for multiple messages', () => {
      (dbAll as any).mockReturnValue([
        { id: 'a1', message_id: 'msg-1', type: 'image', mime_type: 'image/png', data: 'data1', filename: null, width: null, height: null, original_size: null, created_at: 1 },
        { id: 'a2', message_id: 'msg-2', type: 'image', mime_type: 'image/jpeg', data: 'data2', filename: 'photo.jpg', width: 200, height: 150, original_size: 3000, created_at: 2 }
      ])

      const result = AttachmentModel.findByMessages(['msg-1', 'msg-2', 'msg-3'])
      expect(dbAll).toHaveBeenCalledOnce()
      expect(result.get('msg-1')).toHaveLength(1)
      expect(result.get('msg-2')).toHaveLength(1)
      expect(result.has('msg-3')).toBe(false) // No attachments for msg-3
    })

    it('should group multiple attachments per message', () => {
      (dbAll as any).mockReturnValue([
        { id: 'a1', message_id: 'msg-1', type: 'image', mime_type: 'image/png', data: 'd1', filename: null, width: null, height: null, original_size: null, created_at: 1 },
        { id: 'a2', message_id: 'msg-1', type: 'image', mime_type: 'image/jpeg', data: 'd2', filename: null, width: null, height: null, original_size: null, created_at: 2 }
      ])

      const result = AttachmentModel.findByMessages(['msg-1'])
      expect(result.get('msg-1')).toHaveLength(2)
    })
  })

  describe('deleteByMessage', () => {
    it('should delete all attachments for a message', () => {
      AttachmentModel.deleteByMessage('msg-1')

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('DELETE FROM message_attachments WHERE message_id')
      expect(params).toEqual(['msg-1'])
    })
  })

  describe('delete', () => {
    it('should delete a single attachment', () => {
      AttachmentModel.delete('att-1')

      expect(dbRun).toHaveBeenCalledOnce()
      const [sql, params] = (dbRun as any).mock.calls[0]
      expect(sql).toContain('DELETE FROM message_attachments WHERE id')
      expect(params).toEqual(['att-1'])
    })
  })
})
