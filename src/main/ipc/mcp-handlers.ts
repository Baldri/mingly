/**
 * IPC Handlers — MCP (Model Context Protocol)
 */

import { IPC_CHANNELS } from '../../shared/types'
import { getMCPClientManager } from '../mcp/mcp-client-manager'
import { getMCPToolSelector } from '../mcp/mcp-tool-selector'
import { validateString, validateMCPArgs } from '../security/input-validator'
import { wrapHandler, requirePermission, requireFeature } from './ipc-utils'

export function registerMCPHandlers(): void {
  const mcpManager = getMCPClientManager()
  const mcpToolSelector = getMCPToolSelector()

  wrapHandler(IPC_CHANNELS.LIST_MCP_SERVERS, () => ({ success: true, servers: mcpManager.listServers() }))

  wrapHandler(IPC_CHANNELS.CONNECT_MCP_SERVER, async (serverConfig: any) => {
    requirePermission('mcp.connect')
    if (typeof serverConfig === 'string') {
      return await mcpManager.connect(serverConfig)
    }
    const server = mcpManager.addServer(serverConfig)
    const result = await mcpManager.connect(server.id)
    return { ...result, server }
  })

  wrapHandler(IPC_CHANNELS.DISCONNECT_MCP_SERVER, async (serverId: string) => { requirePermission('mcp.connect'); return mcpManager.disconnect(serverId) })

  wrapHandler(IPC_CHANNELS.LIST_MCP_TOOLS, (serverId: string) => ({
    success: true,
    tools: serverId ? mcpManager.listTools(serverId) : mcpManager.listAllTools()
  }))

  wrapHandler(IPC_CHANNELS.EXECUTE_MCP_TOOL, async (serverId: string, toolName: string, args: any) => {
    requireFeature('agents')
    requirePermission('mcp.execute')
    const sv = validateString(serverId, 'serverId', 256); if (!sv.valid) throw new Error(sv.error)
    const tv = validateString(toolName, 'toolName', 256); if (!tv.valid) throw new Error(tv.error)
    const av = validateMCPArgs(args); if (!av.valid) throw new Error(av.error)
    const result = await mcpManager.executeTool(serverId, toolName, args || {})
    return { success: !result.error, ...result }
  })

  // MCP Auto-Tool-Selection Config
  wrapHandler(IPC_CHANNELS.MCP_AUTO_TOOL_GET_CONFIG, () => ({ success: true, config: mcpToolSelector.getConfig() }))

  wrapHandler(IPC_CHANNELS.MCP_AUTO_TOOL_UPDATE_CONFIG, (updates: any) => {
    mcpToolSelector.updateConfig(updates)
    return { success: true, config: mcpToolSelector.getConfig() }
  })
}
