import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type { LLMConfig, LLMProvider, AppSettings } from '../shared/types'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
const api = {
  // API Key Management
  keys: {
    save: (provider: LLMProvider, apiKey: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.SAVE_API_KEY, provider, apiKey),
    get: (provider: LLMProvider) =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_API_KEY, provider),
    delete: (provider: LLMProvider) =>
      ipcRenderer.invoke(IPC_CHANNELS.DELETE_API_KEY, provider),
    list: () =>
      ipcRenderer.invoke(IPC_CHANNELS.LIST_API_KEYS)
  },

  // LLM Operations
  llm: {
    sendMessage: (conversationId: string, messages: any[], provider: string, model: string, temperature?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.SEND_MESSAGE, conversationId, messages, provider, model, temperature),

    validateApiKey: (provider: LLMProvider) =>
      ipcRenderer.invoke(IPC_CHANNELS.VALIDATE_API_KEY, provider)
  },

  // Stream event listeners
  onMessageChunk: (callback: (chunk: string) => void) => {
    const listener = (_event: any, chunk: string) => callback(chunk)
    ipcRenderer.on('message:chunk', listener)
    return () => ipcRenderer.removeListener('message:chunk', listener)
  },

  onMessageComplete: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('message:complete', listener)
    return () => ipcRenderer.removeListener('message:complete', listener)
  },

  onMessageError: (callback: (error: string) => void) => {
    const listener = (_event: any, error: string) => callback(error)
    ipcRenderer.on('message:error', listener)
    return () => ipcRenderer.removeListener('message:error', listener)
  },

  onMessagePermissionRequired: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('message:permission-required', listener)
    return () => ipcRenderer.removeListener('message:permission-required', listener)
  },

  // MCP Operations
  mcp: {
    listServers: () =>
      ipcRenderer.invoke(IPC_CHANNELS.LIST_MCP_SERVERS),

    connect: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECT_MCP_SERVER, serverId),

    addAndConnect: (config: { name: string; command: string; args?: string[]; env?: Record<string, string> }) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECT_MCP_SERVER, config),

    disconnect: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.DISCONNECT_MCP_SERVER, serverId),

    listTools: (serverId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.LIST_MCP_TOOLS, serverId),

    executeTool: (serverId: string, toolName: string, params: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.EXECUTE_MCP_TOOL, serverId, toolName, params)
  },

  // Conversations
  conversations: {
    create: (title: string, provider: string, model: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CREATE_CONVERSATION, title, provider, model),

    get: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_CONVERSATION, conversationId),

    list: () =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_CONVERSATIONS),

    update: (conversationId: string, updates: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CONVERSATION, conversationId, updates),

    delete: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.DELETE_CONVERSATION, conversationId)
  },

  // Settings
  settings: {
    get: () =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),

    update: (settings: Partial<AppSettings>) =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTINGS, settings)
  },

  // File Operations
  file: {
    select: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILE),

    read: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.READ_FILE, filePath)
  },

  // Export
  export: {
    conversation: (conversationId: string, format: 'json' | 'markdown') =>
      ipcRenderer.invoke(IPC_CHANNELS.EXPORT_CONVERSATION, conversationId, format),

    gdprData: () =>
      ipcRenderer.invoke(IPC_CHANNELS.EXPORT_GDPR_DATA)
  },

  // Network AI Servers
  networkAI: {
    addServer: (config: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.NETWORK_AI_ADD_SERVER, config),

    removeServer: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NETWORK_AI_REMOVE_SERVER, serverId),

    listServers: () =>
      ipcRenderer.invoke(IPC_CHANNELS.NETWORK_AI_LIST_SERVERS),

    testConnection: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NETWORK_AI_TEST_CONNECTION, serverId),

    discover: (networkRange: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NETWORK_AI_DISCOVER, networkRange),

    getModels: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NETWORK_AI_GET_MODELS, serverId)
  },

  // File Access Management
  fileAccess: {
    requestDirectory: (permissions: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_ACCESS_REQUEST_DIR, permissions),

    revokeDirectory: (directoryId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_ACCESS_REVOKE_DIR, directoryId),

    listDirectories: () =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_ACCESS_LIST_DIRS),

    readFile: (request: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_ACCESS_READ, request),

    createFile: (request: any, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_ACCESS_CREATE, request, content),

    listFiles: (directoryId: string, path?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_ACCESS_LIST_FILES, directoryId, path),

    addNetworkShare: (config: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_ACCESS_ADD_NETWORK_SHARE, config)
  },

  // Upload Permission Management
  uploadPermission: {
    grant: (request: any, rememberDecision: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PERMISSION_GRANT, request, rememberDecision),

    deny: (request: any, rememberDecision: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PERMISSION_DENY, request, rememberDecision),

    getPolicies: () =>
      ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PERMISSION_GET_POLICIES),

    setPolicy: (directoryId: string, directoryPath: string, policy: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PERMISSION_SET_POLICY, directoryId, directoryPath, policy),

    removePolicy: (directoryId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PERMISSION_REMOVE_POLICY, directoryId),

    getAuditLogs: (filter?: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PERMISSION_GET_AUDIT_LOGS, filter),

    getStats: () =>
      ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_PERMISSION_GET_STATS)
  },

  // RAG (Qdrant) Operations
  rag: {
    initialize: (config: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_INITIALIZE, config),

    createCollection: (name: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_CREATE_COLLECTION, name),

    deleteCollection: (name: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_DELETE_COLLECTION, name),

    listCollections: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_LIST_COLLECTIONS),

    getCollectionInfo: (name: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_GET_COLLECTION_INFO, name),

    indexDocument: (collectionName: string, text: string, source: string, filename: string, metadata?: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_INDEX_DOCUMENT, collectionName, text, source, filename, metadata),

    indexFile: (collectionName: string, filePath: string, metadata?: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_INDEX_FILE, collectionName, filePath, metadata),

    search: (collectionName: string, query: string, limit?: number, scoreThreshold?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_SEARCH, collectionName, query, limit, scoreThreshold),

    getContext: (collectionName: string, query: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_GET_CONTEXT, collectionName, query, limit)
  },

  // RAG HTTP (External Python Server)
  ragHttp: {
    health: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_HTTP_HEALTH),

    search: (collectionName: string, query: string, limit?: number, scoreThreshold?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_HTTP_SEARCH, collectionName, query, limit, scoreThreshold),

    getContext: (collectionName: string, query: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_HTTP_GET_CONTEXT, collectionName, query, limit),

    listCollections: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_HTTP_LIST_COLLECTIONS),

    indexFile: (collectionName: string, filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_HTTP_INDEX_FILE, collectionName, filePath),

    indexDirectory: (collectionName: string, directoryPath: string, recursive?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_HTTP_INDEX_DIRECTORY, collectionName, directoryPath, recursive),

    updateConfig: (config: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_HTTP_UPDATE_CONFIG, config)
  },

  // RAG Context Injection Config
  ragContext: {
    getConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_CONTEXT_GET_CONFIG),

    updateConfig: (updates: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_CONTEXT_UPDATE_CONFIG, updates)
  },

  // RAG-Wissen (External Knowledge Base)
  ragWissen: {
    health: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_HEALTH),

    search: (query: string, collection?: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_SEARCH, query, collection, limit),

    getContext: (query: string, collection?: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_GET_CONTEXT, query, collection, limit),

    listCollections: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_LIST_COLLECTIONS),

    getStats: (collection?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_GET_STATS, collection),

    indexDocument: (filepath: string, collection?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_INDEX_DOCUMENT, filepath, collection),

    getConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_GET_CONFIG),

    updateConfig: (updates: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RAG_WISSEN_UPDATE_CONFIG, updates)
  },

  // Tracking & Analytics
  tracking: {
    getSummary: (fromMs?: number, toMs?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.TRACKING_GET_SUMMARY, fromMs, toMs),

    getDailyUsage: (days?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.TRACKING_GET_DAILY_USAGE, days),

    getRecentEvents: (limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.TRACKING_GET_RECENT_EVENTS, limit)
  },

  // Integrations
  integrations: {
    getStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_GET_STATUS),

    slack: {
      configure: (webhookUrl: string, teamName?: string, botToken?: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_SLACK_CONFIGURE, webhookUrl, teamName, botToken),
      share: (params: { conversationId: string; messages: any[]; title: string }) =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_SLACK_SHARE, params),
      disconnect: () =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_SLACK_DISCONNECT),
      listChannels: () =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_SLACK_LIST_CHANNELS),
      indexToRAG: (opts?: { channelId?: string; channelIds?: string[]; collection?: string; daysBack?: number }) =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_SLACK_INDEX_TO_RAG, opts)
    },

    notion: {
      configure: (apiKey: string, workspaceName?: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_NOTION_CONFIGURE, apiKey, workspaceName),
      save: (params: { conversationId: string; messages: any[]; title: string; databaseId?: string }) =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_NOTION_SAVE, params),
      disconnect: () =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_NOTION_DISCONNECT),
      listDatabases: () =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_NOTION_LIST_DATABASES),
      indexToRAG: (opts?: { databaseId?: string; pageIds?: string[]; collection?: string }) =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_NOTION_INDEX_TO_RAG, opts)
    },

    obsidian: {
      setVault: (vaultPath: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_OBSIDIAN_SET_VAULT, vaultPath),
      index: () =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_OBSIDIAN_INDEX),
      disconnect: () =>
        ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_OBSIDIAN_DISCONNECT)
    }
  },

  // Budget Management
  budget: {
    getConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.BUDGET_GET_CONFIG),
    updateConfig: (updates: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.BUDGET_UPDATE_CONFIG, updates),
    getStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.BUDGET_GET_STATUS)
  },

  // Deployment / Server + Client
  deployment: {
    getConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_GET_CONFIG),
    updateConfig: (config: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_UPDATE_CONFIG, config),
    getStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_GET_STATUS),
    startServer: (configOverride?: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_START_SERVER, configOverride),
    stopServer: () =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_STOP_SERVER),
    addRemote: (server: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_ADD_REMOTE, server),
    removeRemote: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_REMOVE_REMOTE, serverId),
    listRemotes: () =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_LIST_REMOTES),
    checkRemote: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_CHECK_REMOTE, serverId),
    discoverServers: (networkRange?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOYMENT_DISCOVER_SERVERS, networkRange)
  },

  // Hybrid LLM Orchestration
  orchestrator: {
    getConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_GET_CONFIG),
    updateConfig: (config: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_UPDATE_CONFIG, config),
    analyze: (message: string, provider: string, model: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_ANALYZE, message, provider, model),
    approve: (proposalId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_APPROVE, proposalId),
    deny: (proposalId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_DENY, proposalId),
    execute: (proposalId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_EXECUTE, proposalId),
    getProposals: () =>
      ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_GET_PROPOSALS)
  },

  // RBAC (Enterprise Access Control)
  rbac: {
    getState: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_GET_STATE),
    enable: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_ENABLE),
    disable: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_DISABLE),
    hasPermission: (permissionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_HAS_PERMISSION, permissionId),
    getCurrentUser: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_GET_CURRENT_USER),
    listUsers: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_LIST_USERS),
    addUser: (name: string, role: string, email?: string, teamIds?: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_ADD_USER, name, role, email, teamIds),
    updateUserRole: (userId: string, role: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_UPDATE_USER_ROLE, userId, role),
    removeUser: (userId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_REMOVE_USER, userId),
    switchUser: (userId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_SWITCH_USER, userId),
    completeOnboarding: (userId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_COMPLETE_ONBOARDING, userId),
    getOrganization: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_GET_ORGANIZATION),
    createOrganization: (name: string, settings?: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_CREATE_ORGANIZATION, name, settings),
    updateOrganization: (updates: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_UPDATE_ORGANIZATION, updates),
    listTeams: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_LIST_TEAMS),
    createTeam: (name: string, managerId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_CREATE_TEAM, name, managerId),
    deleteTeam: (teamId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_DELETE_TEAM, teamId),
    addUserToTeam: (userId: string, teamId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_ADD_USER_TO_TEAM, userId, teamId),
    removeUserFromTeam: (userId: string, teamId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_REMOVE_USER_FROM_TEAM, userId, teamId),
    setUserBudget: (userId: string, limit: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_SET_USER_BUDGET, userId, limit),
    setTeamBudget: (teamId: string, limit: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_SET_TEAM_BUDGET, teamId, limit),
    checkBudget: (userId: string, tokens: number, costCents: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_CHECK_BUDGET, userId, tokens, costCents),
    getAuditLog: (opts?: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_GET_AUDIT_LOG, opts),
    clearAuditLog: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_CLEAR_AUDIT_LOG),
    getSSOConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_GET_SSO_CONFIG),
    updateSSOConfig: (provider: string, ssoConfig: any, enforce: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.RBAC_UPDATE_SSO_CONFIG, provider, ssoConfig, enforce)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', api)
  } catch (error) {
    console.error('Failed to expose electronAPI:', error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electronAPI = api
}

export type ElectronAPI = typeof api
