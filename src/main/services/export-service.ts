import type { Message, MessageAttachment } from '../../shared/types'

export type ExportFormat = 'markdown' | 'json' | 'html'

export interface ExportOptions {
  title: string
  provider: string
  model: string
  messages: Message[]
  format: ExportFormat
  includeMetadata?: boolean
  includeImages?: boolean
}

export class ExportService {
  formatMarkdown(options: ExportOptions): string {
    const { title, provider, model, messages, includeMetadata = true, includeImages = false } = options
    const lines: string[] = []

    lines.push(`# ${title}`)
    lines.push('')

    if (includeMetadata) {
      lines.push(`**Provider:** ${provider}`)
      lines.push(`**Model:** ${model}`)
      lines.push(`**Messages:** ${messages.length}`)
      lines.push(`**Exported:** ${new Date().toISOString()}`)
      lines.push('')
      lines.push('---')
      lines.push('')
    }

    for (const msg of messages) {
      const roleLabel = msg.role === 'user' ? 'You' : 'Assistant'
      lines.push(`### ${roleLabel}`)
      lines.push('')

      if (includeImages && msg.attachments?.length) {
        for (const att of msg.attachments) {
          if (att.type === 'image') {
            lines.push(`![${att.filename || 'image'}](attachment:${att.id})`)
          }
        }
        lines.push('')
      }

      lines.push(msg.content)
      lines.push('')

      if (includeMetadata && msg.role === 'assistant') {
        const meta: string[] = []
        if (msg.tokens) meta.push(`${msg.tokens} tokens`)
        if (msg.cost) meta.push(`$${msg.cost.toFixed(4)}`)
        if (msg.latencyMs) meta.push(`${msg.latencyMs}ms`)
        if (meta.length > 0) {
          lines.push(`*${meta.join(' · ')}*`)
          lines.push('')
        }
      }
    }

    return lines.join('\n')
  }

  formatJSON(options: ExportOptions): string {
    const { title, provider, model, messages, includeImages = false } = options

    const exportData = {
      title,
      provider,
      model,
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages: messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        tokens: msg.tokens,
        cost: msg.cost,
        latencyMs: msg.latencyMs,
        createdAt: msg.createdAt,
        ...(includeImages && msg.attachments?.length
          ? {
              attachments: msg.attachments.map((att) => ({
                id: att.id,
                type: att.type,
                mimeType: att.mimeType,
                filename: att.filename,
                width: att.width,
                height: att.height,
                ...(includeImages ? { data: att.data } : {})
              }))
            }
          : {})
      }))
    }

    return JSON.stringify(exportData, null, 2)
  }

  formatHTML(options: ExportOptions): string {
    const { title, provider, model, messages, includeMetadata = true, includeImages = false } = options

    const escapeHtml = (text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const messageBlocks = messages.map((msg) => {
      const isUser = msg.role === 'user'
      const roleLabel = isUser ? 'You' : 'Assistant'
      const bgColor = isUser ? '#e3f2fd' : '#f5f5f5'

      let imageHtml = ''
      if (includeImages && msg.attachments?.length) {
        imageHtml = msg.attachments
          .filter((att) => att.type === 'image')
          .map((att) => `<img src="data:${att.mimeType};base64,${att.data}" alt="${escapeHtml(att.filename || 'image')}" style="max-width:400px;max-height:300px;border-radius:8px;margin:8px 0;">`)
          .join('\n')
      }

      let metaHtml = ''
      if (includeMetadata && !isUser && (msg.tokens || msg.cost || msg.latencyMs)) {
        const parts: string[] = []
        if (msg.tokens) parts.push(`${msg.tokens} tokens`)
        if (msg.cost) parts.push(`$${msg.cost.toFixed(4)}`)
        if (msg.latencyMs) parts.push(`${msg.latencyMs}ms`)
        metaHtml = `<div style="font-size:11px;color:#999;margin-top:4px;">${parts.join(' · ')}</div>`
      }

      return `
      <div style="background:${bgColor};border-radius:12px;padding:12px 16px;margin:8px 0;">
        <div style="font-weight:600;font-size:13px;color:#666;margin-bottom:6px;">${roleLabel}</div>
        ${imageHtml}
        <div style="white-space:pre-wrap;">${escapeHtml(msg.content)}</div>
        ${metaHtml}
      </div>`
    }).join('\n')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; color: #333; }
    h1 { margin-bottom: 8px; }
    .meta { font-size: 13px; color: #888; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${provider} · ${model} · ${messages.length} messages · Exported ${new Date().toISOString()}</div>
  ${messageBlocks}
</body>
</html>`
  }

  export(options: ExportOptions): string {
    switch (options.format) {
      case 'markdown':
        return this.formatMarkdown(options)
      case 'json':
        return this.formatJSON(options)
      case 'html':
        return this.formatHTML(options)
      default:
        throw new Error(`Unsupported export format: ${options.format}`)
    }
  }
}

let instance: ExportService | null = null

export function getExportService(): ExportService {
  if (!instance) {
    instance = new ExportService()
  }
  return instance
}
