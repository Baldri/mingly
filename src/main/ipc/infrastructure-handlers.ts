/**
 * IPC Handlers — Network AI, File Access, Security & Privacy
 */

import { IPC_CHANNELS } from '../../shared/types'
import type { SensitiveDataType, RiskLevel } from '../security/sensitive-data-detector'
import { getNetworkAIManager } from '../network/network-ai-manager'
import { getFileAccessManager } from '../file-access/file-access-manager'
import { getSensitiveDataDetector } from '../security/sensitive-data-detector'
import { getUploadPermissionManager } from '../security/upload-permission-manager'
import { validateFilePath } from '../security/input-validator'
import { wrapHandler, requirePermission } from './ipc-utils'
import type { NetworkAIServerConfig } from '../../shared/network-ai-types'
import type { FileAccessRequest, FileAccessPermission } from '../../shared/file-access-types'

export function registerInfrastructureHandlers(): void {
  const networkAIManager = getNetworkAIManager()
  const fileAccessManager = getFileAccessManager()
  const sensitiveDataDetector = getSensitiveDataDetector()
  const uploadPermissionManager = getUploadPermissionManager()

  // ========================================
  // Network AI Server Management
  // ========================================

  wrapHandler(IPC_CHANNELS.NETWORK_AI_ADD_SERVER, async (config: Omit<NetworkAIServerConfig, 'id' | 'createdAt'>) => {
    return { success: true, server: networkAIManager.addServer(config) }
  })

  wrapHandler(IPC_CHANNELS.NETWORK_AI_REMOVE_SERVER, (serverId: string) => {
    return { success: networkAIManager.removeServer(serverId) }
  })

  wrapHandler(IPC_CHANNELS.NETWORK_AI_LIST_SERVERS, () => {
    return { success: true, servers: networkAIManager.getServers() }
  })

  wrapHandler(IPC_CHANNELS.NETWORK_AI_TEST_CONNECTION, async (serverId: string) => {
    return await networkAIManager.testConnection(serverId)
  })

  wrapHandler(IPC_CHANNELS.NETWORK_AI_DISCOVER, async (networkRange?: string) => {
    return { success: true, servers: await networkAIManager.discoverServers(networkRange) }
  })

  wrapHandler(IPC_CHANNELS.NETWORK_AI_GET_MODELS, async (serverId: string) => {
    return { success: true, models: await networkAIManager.getModels(serverId) }
  })

  // ========================================
  // File Access Management
  // ========================================

  wrapHandler(IPC_CHANNELS.FILE_ACCESS_REQUEST_DIR, async (permissions: FileAccessPermission[]) => {
    const allowedDir = await fileAccessManager.requestDirectoryAccess(permissions)
    return { success: !!allowedDir, directory: allowedDir }
  })

  wrapHandler(IPC_CHANNELS.FILE_ACCESS_REVOKE_DIR, (directoryId: string) => {
    return { success: fileAccessManager.revokeDirectoryAccess(directoryId) }
  })

  wrapHandler(IPC_CHANNELS.FILE_ACCESS_LIST_DIRS, () => {
    return { success: true, directories: fileAccessManager.getAllowedDirectories() }
  })

  wrapHandler(IPC_CHANNELS.FILE_ACCESS_READ, async (request: FileAccessRequest) => {
    return { success: true, content: await fileAccessManager.readFile(request) }
  })

  wrapHandler(IPC_CHANNELS.FILE_ACCESS_CREATE, async (request: FileAccessRequest, content: string) => {
    return await fileAccessManager.createFile(request, content)
  })

  wrapHandler(IPC_CHANNELS.FILE_ACCESS_LIST_FILES, async (directoryId: string, relativePath?: string) => {
    if (relativePath) { const pv = validateFilePath(relativePath); if (!pv.valid) throw new Error(pv.error) }
    return { success: true, files: await fileAccessManager.listFiles(directoryId, relativePath) }
  })

  wrapHandler(IPC_CHANNELS.FILE_ACCESS_ADD_NETWORK_SHARE, async (config: any) => {
    return { success: true, share: await fileAccessManager.addNetworkShare(config) }
  })

  // ========================================
  // Data Security & Privacy Management
  // ========================================

  wrapHandler(IPC_CHANNELS.UPLOAD_PERMISSION_GRANT, (request: any, rememberDecision: boolean) => {
    uploadPermissionManager.grantPermission(request, rememberDecision)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.UPLOAD_PERMISSION_DENY, (request: any, rememberDecision: boolean) => {
    uploadPermissionManager.denyPermission(request, rememberDecision)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.UPLOAD_PERMISSION_GET_POLICIES, () => {
    return { success: true, policies: uploadPermissionManager.getAllDirectoryPolicies() }
  })

  wrapHandler(IPC_CHANNELS.UPLOAD_PERMISSION_SET_POLICY, (directoryId: string, directoryPath: string, policy: any) => {
    uploadPermissionManager.setDirectoryPolicy(directoryId, directoryPath, policy)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.UPLOAD_PERMISSION_REMOVE_POLICY, (directoryId: string) => {
    return { success: true, removed: uploadPermissionManager.removeDirectoryPolicy(directoryId) }
  })

  wrapHandler(IPC_CHANNELS.UPLOAD_PERMISSION_GET_AUDIT_LOGS, (filter: any) => {
    return { success: true, logs: uploadPermissionManager.getAuditLogs(filter) }
  })

  wrapHandler(IPC_CHANNELS.UPLOAD_PERMISSION_GET_STATS, () => {
    return { success: true, stats: uploadPermissionManager.getStatistics() }
  })

  wrapHandler(IPC_CHANNELS.SENSITIVE_DATA_ADD_PATTERN, (type: SensitiveDataType, pattern: { source: string; flags: string }, riskLevel: RiskLevel) => {
    requirePermission('settings.security')
    const regex = new RegExp(pattern.source, pattern.flags)
    sensitiveDataDetector.addCustomPattern(type, regex, riskLevel)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.SENSITIVE_DATA_GET_PATTERNS, () => {
    const patterns = sensitiveDataDetector.getCustomPatterns()
    return {
      success: true,
      patterns: patterns.map((p) => ({
        type: p.type,
        pattern: p.pattern.source,
        flags: p.pattern.flags,
        riskLevel: p.riskLevel
      }))
    }
  })
}
