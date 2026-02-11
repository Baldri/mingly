/**
 * Integration Manager - Handles Slack, Notion, and Obsidian connections.
 *
 * Slack: Webhook-based sharing (conversations → Slack channels)
 * Notion: API-based saving (conversations → Notion pages)
 * Obsidian: File-based indexing (vault .md files → RAG vector DB)
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import { EventEmitter } from 'events'
import { EncryptedStore } from '../utils/encrypted-store'

// ============================================================
// Constants
// ============================================================

const SLACK_WEBHOOK_HOST = 'hooks.slack.com'
const SLACK_API_BASE = 'https://slack.com/api'
const NOTION_API_BASE = 'https://api.notion.com/v1'
const NOTION_API_VERSION = '2022-06-28'
const RAG_SERVER_URL = process.env.RAG_SERVER_URL || 'http://localhost:8001'
const DEFAULT_TIMEOUT_MS = 30_000

/** fetch() with AbortController timeout */
async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
// API Response Types (eliminate 'as any' casts)
// ============================================================

interface SlackAPIResponse {
  ok: boolean
  error?: string
  channels?: Array<{ id: string; name: string; num_members?: number }>
  channel?: { name: string }
  messages?: Array<{ user?: string; text?: string; ts: string; thread_ts?: string; subtype?: string }>
  response_metadata?: { next_cursor?: string }
}

interface NotionSearchResponse {
  results: Array<{ id: string; object: string; title?: Array<{ plain_text: string }>; properties?: Record<string, NotionProperty>; url?: string }>
  has_more?: boolean
  next_cursor?: string | null
}

interface NotionProperty {
  type: string
  title?: Array<{ plain_text: string }>
  [key: string]: unknown
}

interface NotionBlocksResponse {
  results: Array<{ type: string; [key: string]: unknown }>
}

// ============================================================
// Types
// ============================================================

export interface SlackConfig {
  webhookUrl: string
  botToken?: string
  defaultChannel?: string
  teamName?: string
  configured: boolean
}

export interface NotionConfig {
  apiKey: string
  defaultDatabaseId?: string
  workspaceName?: string
  configured: boolean
}

export interface ObsidianConfig {
  vaultPath: string
  autoIndex: boolean
  indexedFiles: number
  lastIndexed?: number
  configured: boolean
}

export interface IntegrationStatus {
  slack: { configured: boolean; teamName?: string }
  notion: { configured: boolean; workspaceName?: string }
  obsidian: { configured: boolean; vaultPath?: string; indexedFiles?: number }
}

export interface ShareToSlackParams {
  conversationId: string
  messages: Array<{ role: string; content: string; provider?: string }>
  title: string
  webhookUrl?: string
}

export interface SaveToNotionParams {
  conversationId: string
  messages: Array<{ role: string; content: string; provider?: string; model?: string }>
  title: string
  databaseId?: string
}

// ============================================================
// Integration Manager
// ============================================================

export class IntegrationManager extends EventEmitter {
  private configPath: string
  private slackConfig: SlackConfig = { webhookUrl: '', configured: false }
  private notionConfig: NotionConfig = { apiKey: '', configured: false }
  private obsidianConfig: ObsidianConfig = { vaultPath: '', autoIndex: false, indexedFiles: 0, configured: false }
  private secureStore = new EncryptedStore('integration-secrets.enc.json')

  constructor() {
    super()
    this.configPath = path.join(app.getPath('userData'), 'integrations.json')
    this.loadConfig()
  }

  // ---- Config Persistence ----

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
        if (data.slack) this.slackConfig = { ...this.slackConfig, ...data.slack }
        if (data.notion) this.notionConfig = { ...this.notionConfig, ...data.notion }
        if (data.obsidian) this.obsidianConfig = { ...this.obsidianConfig, ...data.obsidian }
      }

      // Load sensitive tokens from encrypted store
      this.slackConfig.webhookUrl = this.secureStore.get('slack-webhook') || ''
      this.slackConfig.botToken = this.secureStore.get('slack-bot-token')
      this.notionConfig.apiKey = this.secureStore.get('notion-api-key') || ''
    } catch (error) {
      console.error('Failed to load integration config:', error)
    }
  }

  private saveConfig(): void {
    const data = {
      slack: { defaultChannel: this.slackConfig.defaultChannel, teamName: this.slackConfig.teamName, configured: this.slackConfig.configured },
      notion: { defaultDatabaseId: this.notionConfig.defaultDatabaseId, workspaceName: this.notionConfig.workspaceName, configured: this.notionConfig.configured },
      obsidian: { vaultPath: this.obsidianConfig.vaultPath, autoIndex: this.obsidianConfig.autoIndex, indexedFiles: this.obsidianConfig.indexedFiles, lastIndexed: this.obsidianConfig.lastIndexed, configured: this.obsidianConfig.configured }
    }
    fsp.writeFile(this.configPath, JSON.stringify(data, null, 2)).catch((error) => {
      console.error('[Integration] Failed to save config:', error)
    })

    // Store sensitive tokens in encrypted store
    if (this.slackConfig.webhookUrl) {
      this.secureStore.set('slack-webhook', this.slackConfig.webhookUrl)
    }
    if (this.slackConfig.botToken) {
      this.secureStore.set('slack-bot-token', this.slackConfig.botToken)
    }
    if (this.notionConfig.apiKey) {
      this.secureStore.set('notion-api-key', this.notionConfig.apiKey)
    }
  }

  // ---- Status ----

  getStatus(): IntegrationStatus {
    return {
      slack: { configured: this.slackConfig.configured, teamName: this.slackConfig.teamName },
      notion: { configured: this.notionConfig.configured, workspaceName: this.notionConfig.workspaceName },
      obsidian: { configured: this.obsidianConfig.configured, vaultPath: this.obsidianConfig.vaultPath, indexedFiles: this.obsidianConfig.indexedFiles }
    }
  }

  // ============================================================
  // Slack Integration
  // ============================================================

  configureSlack(webhookUrl: string, teamName?: string, botToken?: string): { success: boolean; error?: string } {
    try {
      const parsed = new URL(webhookUrl)
      if (parsed.protocol !== 'https:' || parsed.hostname !== SLACK_WEBHOOK_HOST) {
        return { success: false, error: 'Invalid Slack webhook URL. Must be https://hooks.slack.com/...' }
      }
    } catch {
      return { success: false, error: 'Invalid Slack webhook URL. Must be a valid https://hooks.slack.com/ URL' }
    }

    if (botToken && !botToken.startsWith('xoxb-')) {
      return { success: false, error: 'Invalid Slack bot token. Must start with xoxb-' }
    }

    this.slackConfig = {
      webhookUrl,
      botToken: botToken || this.slackConfig.botToken,
      teamName: teamName || 'Slack Workspace',
      configured: true
    }
    this.saveConfig()
    this.emit('integration-changed', 'slack')
    return { success: true }
  }

  disconnectSlack(): { success: boolean } {
    this.slackConfig = { webhookUrl: '', configured: false }
    this.secureStore.delete('slack-webhook')
    this.secureStore.delete('slack-bot-token')
    this.saveConfig()
    this.emit('integration-changed', 'slack')
    return { success: true }
  }

  async shareToSlack(params: ShareToSlackParams): Promise<{ success: boolean; error?: string }> {
    const webhookUrl = params.webhookUrl || this.slackConfig.webhookUrl
    if (!webhookUrl) {
      return { success: false, error: 'Slack webhook not configured' }
    }

    try {
      // Format conversation for Slack
      const blocks: Record<string, unknown>[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: `Mingly: ${params.title}` }
        },
        { type: 'divider' }
      ]

      for (const msg of params.messages.slice(-10)) { // Last 10 messages
        const roleLabel = msg.role === 'user' ? 'You' : (msg.provider || 'AI')
        const content = msg.content.length > 2000 ? msg.content.substring(0, 2000) + '...' : msg.content
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${roleLabel}:*\n${content}`
          }
        })
      }

      blocks.push(
        { type: 'divider' },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '_Shared from Mingly_' }]
        }
      )

      const response = await fetchWithTimeout(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks })
      })

      if (!response.ok) {
        return { success: false, error: `Slack API error: ${response.status}` }
      }

      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ---- Slack: List channels (requires bot token) ----

  async listSlackChannels(): Promise<{ success: boolean; channels?: Array<{ id: string; name: string; memberCount: number }>; error?: string }> {
    if (!this.slackConfig.botToken) {
      return { success: false, error: 'Slack bot token not configured. Add a bot token with channels:read scope.' }
    }

    try {
      const response = await fetchWithTimeout(`${SLACK_API_BASE}/conversations.list?types=public_channel,private_channel&limit=200`, {
        headers: { 'Authorization': `Bearer ${this.slackConfig.botToken}` }
      })

      const data = await response.json() as SlackAPIResponse
      if (!data.ok) {
        return { success: false, error: `Slack API error: ${data.error}` }
      }

      const channels = (data.channels || []).map((ch: NonNullable<SlackAPIResponse["channels"]>[number]) => ({
        id: ch.id,
        name: ch.name,
        memberCount: ch.num_members || 0
      }))

      return { success: true, channels }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ---- Slack: RAG indexing (pull channel messages → vector DB) ----

  async indexSlackToRAG(opts?: { channelId?: string; channelIds?: string[]; collection?: string; daysBack?: number }): Promise<{ success: boolean; indexed?: number; error?: string }> {
    if (!this.slackConfig.botToken) {
      return { success: false, error: 'Slack bot token not configured. Add a bot token with channels:history scope.' }
    }

    const collection = opts?.collection || 'slack'
    const daysBack = opts?.daysBack || 30
    const oldest = Math.floor((Date.now() - daysBack * 86400000) / 1000).toString()

    try {
      // Determine which channels to index
      let channelIds: string[] = []
      if (opts?.channelIds && opts.channelIds.length > 0) {
        channelIds = opts.channelIds
      } else if (opts?.channelId) {
        channelIds = [opts.channelId]
      } else {
        // Index all accessible channels
        const channelsResult = await this.listSlackChannels()
        if (channelsResult.channels) {
          channelIds = channelsResult.channels.map(ch => ch.id)
        }
      }

      if (channelIds.length === 0) {
        return { success: true, indexed: 0 }
      }

      let indexed = 0

      for (const channelId of channelIds) {
        try {
          const messages = await this.fetchSlackChannelMessages(channelId, oldest)
          if (messages.length === 0) continue

          // Get channel name for context
          const channelName = await this.getSlackChannelName(channelId)

          // Group messages into conversation threads for better context
          const threadGroups = this.groupSlackMessages(messages)

          for (const thread of threadGroups) {
            const text = `# Slack: #${channelName}\n\n${thread.map(m => `**${m.user}** (${new Date(parseFloat(m.ts) * 1000).toISOString()}):\n${m.text}`).join('\n\n')}`

            try {
              const response = await fetchWithTimeout(`${RAG_SERVER_URL}/api/v1/index/text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  text,
                  collection_name: collection,
                  source: `slack:${channelId}:${thread[0].ts}`,
                  metadata: {
                    title: `#${channelName} conversation`,
                    source_type: 'slack',
                    slack_channel_id: channelId,
                    slack_channel_name: channelName,
                    message_count: thread.length,
                    indexed_at: new Date().toISOString()
                  }
                })
              })
              if (response.ok) indexed++
            } catch (error) {
              console.warn('[Integration] Failed to index Slack thread:', (error as Error).message)
            }
          }
        } catch (error) {
          console.warn('[Integration] Failed to index Slack channel:', (error as Error).message)
        }
      }

      return { success: true, indexed }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  private async fetchSlackChannelMessages(channelId: string, oldest: string): Promise<Array<{ user: string; text: string; ts: string; thread_ts?: string }>> {
    const messages: Array<{ user: string; text: string; ts: string; thread_ts?: string }> = []
    try {
      let cursor: string | undefined
      do {
        const params = new URLSearchParams({
          channel: channelId,
          oldest,
          limit: '200'
        })
        if (cursor) params.set('cursor', cursor)

        const response = await fetchWithTimeout(`${SLACK_API_BASE}/conversations.history?${params}`, {
          headers: { 'Authorization': `Bearer ${this.slackConfig.botToken}` }
        })

        const data = await response.json() as SlackAPIResponse
        if (!data.ok) break

        for (const msg of data.messages || []) {
          if (msg.subtype && msg.subtype !== 'thread_broadcast') continue
          messages.push({
            user: msg.user || 'unknown',
            text: msg.text || '',
            ts: msg.ts,
            thread_ts: msg.thread_ts
          })
        }

        cursor = data.response_metadata?.next_cursor
      } while (cursor)
    } catch (error) { console.warn('[Integration] Slack history fetch error:', (error as Error).message) }
    return messages
  }

  private async getSlackChannelName(channelId: string): Promise<string> {
    try {
      const response = await fetchWithTimeout(`${SLACK_API_BASE}/conversations.info?channel=${channelId}`, {
        headers: { 'Authorization': `Bearer ${this.slackConfig.botToken}` }
      })
      const data = await response.json() as SlackAPIResponse
      return data.channel?.name || channelId
    } catch (error) {
      console.warn('[Integration] Failed to get channel name:', (error as Error).message)
      return channelId
    }
  }

  private groupSlackMessages(messages: Array<{ user: string; text: string; ts: string; thread_ts?: string }>): Array<Array<{ user: string; text: string; ts: string }>> {
    // Group by thread_ts or create groups of ~10 sequential messages
    const threads = new Map<string, Array<{ user: string; text: string; ts: string }>>()

    for (const msg of messages) {
      const key = msg.thread_ts || msg.ts
      if (!threads.has(key)) threads.set(key, [])
      threads.get(key)!.push({ user: msg.user, text: msg.text, ts: msg.ts })
    }

    // Split large non-thread groups into chunks of 10
    const groups: Array<Array<{ user: string; text: string; ts: string }>> = []
    for (const [, msgs] of threads) {
      if (msgs.length <= 10) {
        groups.push(msgs)
      } else {
        for (let i = 0; i < msgs.length; i += 10) {
          groups.push(msgs.slice(i, i + 10))
        }
      }
    }

    return groups
  }

  // ============================================================
  // Notion Integration
  // ============================================================

  configureNotion(apiKey: string, workspaceName?: string): { success: boolean; error?: string } {
    if (!apiKey.startsWith('ntn_') && !apiKey.startsWith('secret_')) {
      return { success: false, error: 'Invalid Notion API key. Must start with ntn_ or secret_' }
    }

    this.notionConfig = {
      apiKey,
      workspaceName: workspaceName || 'Notion Workspace',
      configured: true
    }
    this.saveConfig()
    this.emit('integration-changed', 'notion')
    return { success: true }
  }

  disconnectNotion(): { success: boolean } {
    this.notionConfig = { apiKey: '', configured: false }
    this.secureStore.delete('notion-api-key')
    this.saveConfig()
    this.emit('integration-changed', 'notion')
    return { success: true }
  }

  async saveToNotion(params: SaveToNotionParams): Promise<{ success: boolean; pageUrl?: string; error?: string }> {
    if (!this.notionConfig.configured || !this.notionConfig.apiKey) {
      return { success: false, error: 'Notion not configured' }
    }

    try {
      const parentId = params.databaseId || this.notionConfig.defaultDatabaseId

      // Build page content as rich text blocks
      const children: Record<string, unknown>[] = []

      for (const msg of params.messages) {
        const roleLabel = msg.role === 'user' ? 'You' : `${msg.provider || 'AI'}${msg.model ? ` (${msg.model})` : ''}`

        children.push({
          object: 'block',
          type: 'heading_3',
          heading_3: {
            rich_text: [{ type: 'text', text: { content: roleLabel } }]
          }
        })

        // Split content into paragraphs (Notion has 2000 char limit per block)
        const paragraphs = msg.content.split('\n\n').filter(Boolean)
        for (const para of paragraphs) {
          const chunks = para.match(/.{1,2000}/gs) || [para]
          for (const chunk of chunks) {
            children.push({
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [{ type: 'text', text: { content: chunk } }]
              }
            })
          }
        }

        children.push({ object: 'block', type: 'divider', divider: {} })
      }

      const body: Record<string, unknown> = {
        children,
        properties: {
          title: {
            title: [{ text: { content: params.title } }]
          }
        }
      }

      if (parentId) {
        body.parent = { database_id: parentId }
      } else {
        // Create as standalone page in workspace
        body.parent = { type: 'workspace', workspace: true }
      }

      const response = await fetchWithTimeout(`${NOTION_API_BASE}/pages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.notionConfig.apiKey}`,
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_API_VERSION
        },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        return { success: false, error: `Notion API error: ${response.status} - ${(errData as { message?: string }).message || 'Unknown error'}` }
      }

      const data = await response.json() as { url?: string }
      return { success: true, pageUrl: data.url }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ---- Notion: Fetch databases ----

  async listNotionDatabases(): Promise<{ success: boolean; databases?: Array<{ id: string; title: string }>; error?: string }> {
    if (!this.notionConfig.configured || !this.notionConfig.apiKey) {
      return { success: false, error: 'Notion not configured' }
    }

    try {
      const response = await fetchWithTimeout(`${NOTION_API_BASE}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.notionConfig.apiKey}`,
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_API_VERSION
        },
        body: JSON.stringify({ filter: { value: 'database', property: 'object' }, page_size: 50 })
      })

      if (!response.ok) {
        return { success: false, error: `Notion API error: ${response.status}` }
      }

      const data = await response.json() as NotionSearchResponse
      const databases = (data.results || []).map((db: NotionSearchResponse["results"][number]) => ({
        id: db.id,
        title: db.title?.[0]?.plain_text || 'Untitled'
      }))

      return { success: true, databases }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // ---- Notion: RAG indexing (pull pages → vector DB) ----

  async indexNotionToRAG(opts?: { databaseId?: string; pageIds?: string[]; collection?: string }): Promise<{ success: boolean; indexed?: number; error?: string }> {
    if (!this.notionConfig.configured || !this.notionConfig.apiKey) {
      return { success: false, error: 'Notion not configured' }
    }

    const collection = opts?.collection || 'notion'

    try {
      let pages: Array<{ id: string; title: string; content: string }> = []

      if (opts?.pageIds && opts.pageIds.length > 0) {
        // Fetch specific pages
        for (const pageId of opts.pageIds) {
          const page = await this.fetchNotionPageContent(pageId)
          if (page) pages.push(page)
        }
      } else if (opts?.databaseId) {
        // Fetch all pages from a database
        pages = await this.fetchNotionDatabasePages(opts.databaseId)
      } else {
        // Search for recent pages
        pages = await this.fetchNotionRecentPages()
      }

      if (pages.length === 0) {
        return { success: true, indexed: 0 }
      }

      // Index each page into RAG via HTTP server
      let indexed = 0
      for (const page of pages) {
        try {
          const text = `# ${page.title}\n\n${page.content}`
          const response = await fetchWithTimeout(`${RAG_SERVER_URL}/api/v1/index/text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              collection_name: collection,
              source: `notion:${page.id}`,
              metadata: {
                title: page.title,
                source_type: 'notion',
                notion_page_id: page.id,
                indexed_at: new Date().toISOString()
              }
            })
          })
          if (response.ok) indexed++
        } catch (error) {
          console.warn('[Integration] Failed to index Notion page:', (error as Error).message)
        }
      }

      return { success: true, indexed }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  private async fetchNotionPageContent(pageId: string): Promise<{ id: string; title: string; content: string } | null> {
    try {
      // Get page metadata
      const pageResp = await fetchWithTimeout(`${NOTION_API_BASE}/pages/${pageId}`, {
        headers: {
          'Authorization': `Bearer ${this.notionConfig.apiKey}`,
          'Notion-Version': NOTION_API_VERSION
        }
      })
      if (!pageResp.ok) return null
      const pageData = await pageResp.json() as { properties?: Record<string, NotionProperty> }
      const title = this.extractNotionTitle(pageData)

      // Get page blocks (content)
      const blocksResp = await fetchWithTimeout(`${NOTION_API_BASE}/blocks/${pageId}/children?page_size=100`, {
        headers: {
          'Authorization': `Bearer ${this.notionConfig.apiKey}`,
          'Notion-Version': NOTION_API_VERSION
        }
      })
      if (!blocksResp.ok) return null
      const blocksData = await blocksResp.json() as NotionBlocksResponse
      const content = this.extractBlocksText(blocksData.results || [])

      return { id: pageId, title, content }
    } catch (error) {
      console.warn('[Integration] Failed to fetch Notion page:', (error as Error).message)
      return null
    }
  }

  private async fetchNotionDatabasePages(databaseId: string): Promise<Array<{ id: string; title: string; content: string }>> {
    const pages: Array<{ id: string; title: string; content: string }> = []
    try {
      const response = await fetchWithTimeout(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.notionConfig.apiKey}`,
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_API_VERSION
        },
        body: JSON.stringify({ page_size: 50 })
      })

      if (!response.ok) return pages
      const data = await response.json() as NotionSearchResponse

      for (const result of data.results || []) {
        const page = await this.fetchNotionPageContent(result.id)
        if (page) pages.push(page)
      }
    } catch (error) { console.warn('[Integration] Notion database query error:', (error as Error).message) }
    return pages
  }

  private async fetchNotionRecentPages(): Promise<Array<{ id: string; title: string; content: string }>> {
    const pages: Array<{ id: string; title: string; content: string }> = []
    try {
      const response = await fetchWithTimeout(`${NOTION_API_BASE}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.notionConfig.apiKey}`,
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_API_VERSION
        },
        body: JSON.stringify({
          filter: { value: 'page', property: 'object' },
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          page_size: 20
        })
      })

      if (!response.ok) return pages
      const data = await response.json() as NotionSearchResponse

      for (const result of (data.results || []).slice(0, 20)) {
        const page = await this.fetchNotionPageContent(result.id)
        if (page) pages.push(page)
      }
    } catch (error) { console.warn('[Integration] Notion recent pages error:', (error as Error).message) }
    return pages
  }

  private extractNotionTitle(pageData: { properties?: Record<string, NotionProperty> }): string {
    const props = pageData.properties || {}
    for (const key of Object.keys(props)) {
      const prop = props[key]
      if (prop && prop.type === 'title' && prop.title && prop.title.length > 0) {
        return prop.title.map((t: { plain_text: string }) => t.plain_text).join('')
      }
    }
    return 'Untitled'
  }

  private extractBlocksText(blocks: NotionBlocksResponse['results']): string {
    const parts: string[] = []
    for (const block of blocks) {
      const blockContent = block[block.type] as { rich_text?: Array<{ plain_text: string }> } | undefined
      const richText = blockContent?.rich_text
      if (richText) {
        const text = richText.map((t: { plain_text: string }) => t.plain_text).join('')
        if (text) parts.push(text)
      }
    }
    return parts.join('\n\n')
  }

  // ============================================================
  // Obsidian Integration
  // ============================================================

  async setObsidianVault(vaultPath: string): Promise<{ success: boolean; fileCount?: number; error?: string }> {
    try {
      // Verify path exists and looks like an Obsidian vault
      try {
        await fsp.access(vaultPath)
      } catch {
        return { success: false, error: 'Directory does not exist' }
      }

      // Count .md files
      const mdFiles = await this.countMdFiles(vaultPath)

      this.obsidianConfig = {
        vaultPath,
        autoIndex: true,
        indexedFiles: 0,
        configured: true
      }
      this.saveConfig()
      this.emit('integration-changed', 'obsidian')

      return { success: true, fileCount: mdFiles }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async indexObsidianVault(): Promise<{ success: boolean; indexed?: number; error?: string }> {
    if (!this.obsidianConfig.configured || !this.obsidianConfig.vaultPath) {
      return { success: false, error: 'Obsidian vault not configured' }
    }

    try {
      const vaultPath = this.obsidianConfig.vaultPath
      const mdFiles = await this.collectMdFiles(vaultPath)

      // Use the RAG HTTP client to index each file
      let indexed = 0
      for (const filePath of mdFiles) {
        try {
          const response = await fetchWithTimeout(`${RAG_SERVER_URL}/api/v1/index/file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file_path: filePath,
              collection_name: 'obsidian'
            })
          })
          if (response.ok) indexed++
        } catch (error) {
          console.warn('[Integration] Failed to index file:', (error as Error).message)
        }
      }

      this.obsidianConfig.indexedFiles = indexed
      this.obsidianConfig.lastIndexed = Date.now()
      this.saveConfig()

      return { success: true, indexed }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  disconnectObsidian(): { success: boolean } {
    this.obsidianConfig = { vaultPath: '', autoIndex: false, indexedFiles: 0, configured: false }
    this.saveConfig()
    this.emit('integration-changed', 'obsidian')
    return { success: true }
  }

  private async countMdFiles(dirPath: string, depth = 0): Promise<number> {
    if (depth > 5) return 0
    let count = 0
    try {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isFile() && entry.name.endsWith('.md')) count++
        if (entry.isDirectory()) count += await this.countMdFiles(path.join(dirPath, entry.name), depth + 1)
      }
    } catch (error) {
      console.warn(`[Integration] Failed to read directory ${dirPath}:`, (error as Error).message)
    }
    return count
  }

  private async collectMdFiles(dirPath: string, depth = 0): Promise<string[]> {
    if (depth > 5) return []
    const files: string[] = []
    try {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath)
        if (entry.isDirectory()) files.push(...await this.collectMdFiles(fullPath, depth + 1))
      }
    } catch (error) {
      console.warn(`[Integration] Failed to read directory ${dirPath}:`, (error as Error).message)
    }
    return files
  }
}

// Singleton
let instance: IntegrationManager | null = null
export function getIntegrationManager(): IntegrationManager {
  if (!instance) instance = new IntegrationManager()
  return instance
}
