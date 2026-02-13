/**
 * IPC Handlers — Integrations (Slack, Notion, Obsidian) & DocMind
 */

import { IPC_CHANNELS } from '../../shared/types'
import { getIntegrationManager } from '../integrations/integration-manager'
import { getDocMindIntegration } from '../integrations/docmind-integration'
import { wrapHandler, requirePermission, requireFeature } from './ipc-utils'

export function registerIntegrationHandlers(): void {
  const integrationManager = getIntegrationManager()
  const docMind = getDocMindIntegration()

  // ========================================
  // Integrations (Slack, Notion, Obsidian) — Enterprise tier
  // ========================================

  wrapHandler(IPC_CHANNELS.INTEGRATION_GET_STATUS, () => { requireFeature('custom_integrations'); return { success: true, status: integrationManager.getStatus() } })

  // Slack
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_CONFIGURE, (webhookUrl: string, teamName?: string, botToken?: string) => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.configureSlack(webhookUrl, teamName, botToken) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_SHARE, async (params: any) => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.shareToSlack(params) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_DISCONNECT, () => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.disconnectSlack() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_LIST_CHANNELS, async () => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.listSlackChannels() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_INDEX_TO_RAG, async (opts?: any) => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.indexSlackToRAG(opts) })

  // Notion
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_CONFIGURE, (apiKey: string, workspaceName?: string) => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.configureNotion(apiKey, workspaceName) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_SAVE, async (params: any) => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.saveToNotion(params) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_DISCONNECT, () => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.disconnectNotion() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_LIST_DATABASES, async () => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.listNotionDatabases() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_INDEX_TO_RAG, async (opts?: any) => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.indexNotionToRAG(opts) })

  // Obsidian
  wrapHandler(IPC_CHANNELS.INTEGRATION_OBSIDIAN_SET_VAULT, async (vaultPath: string) => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.setObsidianVault(vaultPath) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_OBSIDIAN_INDEX, async () => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.indexObsidianVault() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_OBSIDIAN_DISCONNECT, () => { requireFeature('custom_integrations'); requirePermission('integrations.manage'); return integrationManager.disconnectObsidian() })

  // ========================================
  // DocMind Integration
  // ========================================

  wrapHandler(IPC_CHANNELS.DOCMIND_GET_CONFIG, () => {
    return { success: true, config: docMind.getConfig() }
  })

  wrapHandler(IPC_CHANNELS.DOCMIND_UPDATE_CONFIG, (updates: any) => {
    docMind.updateConfig(updates)
    return { success: true, config: docMind.getConfig() }
  })

  wrapHandler(IPC_CHANNELS.DOCMIND_GET_STATUS, async () => {
    const status = await docMind.getStatus()
    return { success: true, ...status }
  })

  wrapHandler(IPC_CHANNELS.DOCMIND_INITIALIZE, async () => {
    const result = await docMind.initialize()
    return { success: true, ...result }
  })

  wrapHandler(IPC_CHANNELS.DOCMIND_CONNECT_MCP, async () => {
    const result = await docMind.connectMCP()
    return result
  })

  wrapHandler(IPC_CHANNELS.DOCMIND_DISCONNECT_MCP, async () => {
    const result = await docMind.disconnectMCP()
    return result
  })

  wrapHandler(IPC_CHANNELS.DOCMIND_CHECK_REST, async () => {
    const result = await docMind.checkRESTHealth()
    return result
  })
}
