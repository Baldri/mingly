import { dbRun, dbAll } from '../index'
import type { MessageAttachment } from '../../../shared/types'

export class AttachmentModel {
  static create(messageId: string, attachment: MessageAttachment): void {
    dbRun(
      `INSERT INTO message_attachments (id, message_id, type, mime_type, data, filename, width, height, original_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        attachment.id,
        messageId,
        attachment.type,
        attachment.mimeType,
        attachment.data,
        attachment.filename ?? null,
        attachment.width ?? null,
        attachment.height ?? null,
        attachment.originalSize ?? null,
        Date.now()
      ]
    )
  }

  static createMany(messageId: string, attachments: MessageAttachment[]): void {
    for (const attachment of attachments) {
      AttachmentModel.create(messageId, attachment)
    }
  }

  static findByMessage(messageId: string): MessageAttachment[] {
    const rows = dbAll(
      'SELECT * FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC',
      [messageId]
    )

    return rows.map((row) => ({
      id: row.id as string,
      type: row.type as 'image',
      mimeType: row.mime_type as MessageAttachment['mimeType'],
      data: row.data as string,
      filename: (row.filename as string) || undefined,
      width: (row.width as number) || undefined,
      height: (row.height as number) || undefined,
      originalSize: (row.original_size as number) || undefined
    }))
  }

  static findByMessages(messageIds: string[]): Map<string, MessageAttachment[]> {
    if (messageIds.length === 0) return new Map()

    const placeholders = messageIds.map(() => '?').join(',')
    const rows = dbAll(
      `SELECT * FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`,
      messageIds
    )

    const result = new Map<string, MessageAttachment[]>()
    for (const row of rows) {
      const msgId = row.message_id as string
      const attachment: MessageAttachment = {
        id: row.id as string,
        type: row.type as 'image',
        mimeType: row.mime_type as MessageAttachment['mimeType'],
        data: row.data as string,
        filename: (row.filename as string) || undefined,
        width: (row.width as number) || undefined,
        height: (row.height as number) || undefined,
        originalSize: (row.original_size as number) || undefined
      }

      const existing = result.get(msgId) || []
      existing.push(attachment)
      result.set(msgId, existing)
    }

    return result
  }

  static deleteByMessage(messageId: string): void {
    dbRun('DELETE FROM message_attachments WHERE message_id = ?', [messageId])
  }

  static delete(id: string): void {
    dbRun('DELETE FROM message_attachments WHERE id = ?', [id])
  }
}
