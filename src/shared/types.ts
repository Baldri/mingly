// LLM Provider Types
export type LLMProvider = 'anthropic' | 'openai' | 'google' | 'local'

export type LLMModel =
  | 'gpt-4'
  | 'gpt-4-turbo'
  | 'gpt-3.5-turbo'
  | 'claude-3-opus'
  | 'claude-3-sonnet'
  | 'claude-3-haiku'
  | 'claude-3-5-sonnet-20241022'
  | 'gemini-pro'
  | 'gemini-ultra'
  | 'gemini-1.5-flash'
  | 'gemma2:2b'
  | 'llama3:8b'
  | 'mistral:7b'

export interface LLMConfig {
  provider: LLMProvider
  model: LLMModel
  temperature?: number
  maxTokens?: number
  topP?: number
  systemPrompt?: string
}

// Message Types
export interface Message {
  id: string
  conversationId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  provider?: LLMProvider
  model?: LLMModel | string
  createdAt?: number
  timestamp?: number // deprecated, use createdAt
  tokens?: number
  cost?: number
  latencyMs?: number
  ragSources?: Array<{ filename: string; score: number }>
  tokensUsed?: number // deprecated, use tokens
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  provider: LLMProvider
  model: LLMModel
}

// LLM Response Types
export interface LLMResponse {
  content: string
  provider: LLMProvider
  model: LLMModel
  tokens: number
  cost?: number
  finishReason?: string
}

export interface StreamChunk {
  content: string
  done: boolean
}

// API Key Management
export interface APIKeyConfig {
  provider: LLMProvider
  apiKey: string
  isValid: boolean
  lastValidated?: number
}

// MCP Types
export interface MCPServer {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  connected: boolean
}

export interface MCPTool {
  id: string
  serverName: string
  toolName: string
  description: string
  inputSchema: Record<string, any>
}

export interface MCPToolResult {
  toolName: string
  result: any
  error?: string
}

// Context Types
export type ContextItemType = 'file' | 'url' | 'note' | 'mcp_result'

export interface ContextItem {
  id: string
  type: ContextItemType
  content: string
  metadata?: {
    filename?: string
    url?: string
    mimeType?: string
    size?: number
    [key: string]: any
  }
}

// Settings Types
export interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  defaultProvider: LLMProvider
  defaultModel: LLMModel
  enableParallelMode: boolean
  enableCostTracking: boolean
  enableAuditLog: boolean
  obsidianVaultPath?: string
  /** Deployment mode: standalone | server | hybrid */
  deploymentMode?: 'standalone' | 'server' | 'hybrid'
  /** Whether the setup wizard has been completed */
  wizardCompleted?: boolean
  /** UI language: German or English */
  language?: 'de' | 'en'
}

// IPC Channel Names
export const IPC_CHANNELS = {
  // LLM Operations
  SEND_MESSAGE: 'llm:send-message',
  STREAM_MESSAGE: 'llm:stream-message',
  STREAM_CHUNK: 'llm:stream-chunk',
  VALIDATE_API_KEY: 'llm:validate-api-key',

  // API Key Management
  SAVE_API_KEY: 'keys:save',
  GET_API_KEY: 'keys:get',
  DELETE_API_KEY: 'keys:delete',
  LIST_API_KEYS: 'keys:list',

  // MCP Operations
  LIST_MCP_SERVERS: 'mcp:list-servers',
  CONNECT_MCP_SERVER: 'mcp:connect',
  DISCONNECT_MCP_SERVER: 'mcp:disconnect',
  LIST_MCP_TOOLS: 'mcp:list-tools',
  EXECUTE_MCP_TOOL: 'mcp:execute-tool',

  // Conversations
  CREATE_CONVERSATION: 'conversations:create',
  GET_CONVERSATION: 'conversations:get',
  GET_CONVERSATIONS: 'conversations:list',
  UPDATE_CONVERSATION: 'conversations:update',
  DELETE_CONVERSATION: 'conversations:delete',

  // Settings
  GET_SETTINGS: 'settings:get',
  UPDATE_SETTINGS: 'settings:update',

  // File Operations
  SELECT_FILE: 'file:select',
  READ_FILE: 'file:read',

  // Network AI Servers
  NETWORK_AI_ADD_SERVER: 'network-ai:add-server',
  NETWORK_AI_REMOVE_SERVER: 'network-ai:remove-server',
  NETWORK_AI_LIST_SERVERS: 'network-ai:list-servers',
  NETWORK_AI_TEST_CONNECTION: 'network-ai:test-connection',
  NETWORK_AI_DISCOVER: 'network-ai:discover',
  NETWORK_AI_GET_MODELS: 'network-ai:get-models',

  // File Access
  FILE_ACCESS_REQUEST_DIR: 'file-access:request-directory',
  FILE_ACCESS_REVOKE_DIR: 'file-access:revoke-directory',
  FILE_ACCESS_LIST_DIRS: 'file-access:list-directories',
  FILE_ACCESS_READ: 'file-access:read',
  FILE_ACCESS_CREATE: 'file-access:create',
  FILE_ACCESS_LIST_FILES: 'file-access:list-files',
  FILE_ACCESS_ADD_NETWORK_SHARE: 'file-access:add-network-share',

  // Upload Permission & Data Security
  UPLOAD_PERMISSION_GRANT: 'upload-permission:grant',
  UPLOAD_PERMISSION_DENY: 'upload-permission:deny',
  UPLOAD_PERMISSION_GET_POLICIES: 'upload-permission:get-policies',
  UPLOAD_PERMISSION_SET_POLICY: 'upload-permission:set-policy',
  UPLOAD_PERMISSION_REMOVE_POLICY: 'upload-permission:remove-policy',
  UPLOAD_PERMISSION_GET_AUDIT_LOGS: 'upload-permission:get-audit-logs',
  UPLOAD_PERMISSION_GET_STATS: 'upload-permission:get-stats',

  // Sensitive Data Detection
  SENSITIVE_DATA_ADD_PATTERN: 'sensitive-data:add-pattern',
  SENSITIVE_DATA_REMOVE_PATTERN: 'sensitive-data:remove-pattern',
  SENSITIVE_DATA_GET_PATTERNS: 'sensitive-data:get-patterns',

  // RAG (Qdrant)
  RAG_INITIALIZE: 'rag:initialize',
  RAG_CREATE_COLLECTION: 'rag:create-collection',
  RAG_DELETE_COLLECTION: 'rag:delete-collection',
  RAG_LIST_COLLECTIONS: 'rag:list-collections',
  RAG_GET_COLLECTION_INFO: 'rag:get-collection-info',
  RAG_INDEX_DOCUMENT: 'rag:index-document',
  RAG_INDEX_FILE: 'rag:index-file',
  RAG_SEARCH: 'rag:search',
  RAG_GET_CONTEXT: 'rag:get-context',

  // RAG HTTP (External Python Server)
  RAG_HTTP_HEALTH: 'rag-http:health',
  RAG_HTTP_SEARCH: 'rag-http:search',
  RAG_HTTP_GET_CONTEXT: 'rag-http:get-context',
  RAG_HTTP_LIST_COLLECTIONS: 'rag-http:list-collections',
  RAG_HTTP_INDEX_FILE: 'rag-http:index-file',
  RAG_HTTP_INDEX_DIRECTORY: 'rag-http:index-directory',
  RAG_HTTP_UPDATE_CONFIG: 'rag-http:update-config',

  // RAG-Wissen (External Knowledge Base)
  RAG_WISSEN_HEALTH: 'rag-wissen:health',
  RAG_WISSEN_SEARCH: 'rag-wissen:search',
  RAG_WISSEN_GET_CONTEXT: 'rag-wissen:get-context',
  RAG_WISSEN_LIST_COLLECTIONS: 'rag-wissen:list-collections',
  RAG_WISSEN_GET_STATS: 'rag-wissen:get-stats',
  RAG_WISSEN_INDEX_DOCUMENT: 'rag-wissen:index-document',
  RAG_WISSEN_GET_CONFIG: 'rag-wissen:get-config',
  RAG_WISSEN_UPDATE_CONFIG: 'rag-wissen:update-config',

  // RAG Context Injection
  RAG_CONTEXT_GET_CONFIG: 'rag-context:get-config',
  RAG_CONTEXT_UPDATE_CONFIG: 'rag-context:update-config',

  // Tracking & Analytics
  TRACKING_GET_SUMMARY: 'tracking:get-summary',
  TRACKING_GET_DAILY_USAGE: 'tracking:get-daily-usage',
  TRACKING_GET_RECENT_EVENTS: 'tracking:get-recent-events',

  // Export
  EXPORT_CONVERSATION: 'export:conversation',
  EXPORT_GDPR_DATA: 'export:gdpr-data',

  // Integrations
  INTEGRATION_GET_STATUS: 'integration:get-status',
  INTEGRATION_SLACK_CONFIGURE: 'integration:slack-configure',
  INTEGRATION_SLACK_SHARE: 'integration:slack-share',
  INTEGRATION_SLACK_DISCONNECT: 'integration:slack-disconnect',
  INTEGRATION_SLACK_LIST_CHANNELS: 'integration:slack-list-channels',
  INTEGRATION_SLACK_INDEX_TO_RAG: 'integration:slack-index-to-rag',
  INTEGRATION_NOTION_CONFIGURE: 'integration:notion-configure',
  INTEGRATION_NOTION_SAVE: 'integration:notion-save',
  INTEGRATION_NOTION_DISCONNECT: 'integration:notion-disconnect',
  INTEGRATION_NOTION_LIST_DATABASES: 'integration:notion-list-databases',
  INTEGRATION_NOTION_INDEX_TO_RAG: 'integration:notion-index-to-rag',
  INTEGRATION_OBSIDIAN_SET_VAULT: 'integration:obsidian-set-vault',
  INTEGRATION_OBSIDIAN_INDEX: 'integration:obsidian-index',
  INTEGRATION_OBSIDIAN_DISCONNECT: 'integration:obsidian-disconnect',

  // Budget Management
  BUDGET_GET_CONFIG: 'budget:get-config',
  BUDGET_UPDATE_CONFIG: 'budget:update-config',
  BUDGET_GET_STATUS: 'budget:get-status',

  // Deployment / Server + Client
  DEPLOYMENT_GET_CONFIG: 'deployment:get-config',
  DEPLOYMENT_UPDATE_CONFIG: 'deployment:update-config',
  DEPLOYMENT_GET_STATUS: 'deployment:get-status',
  DEPLOYMENT_START_SERVER: 'deployment:start-server',
  DEPLOYMENT_STOP_SERVER: 'deployment:stop-server',
  DEPLOYMENT_ADD_REMOTE: 'deployment:add-remote',
  DEPLOYMENT_REMOVE_REMOTE: 'deployment:remove-remote',
  DEPLOYMENT_LIST_REMOTES: 'deployment:list-remotes',
  DEPLOYMENT_CHECK_REMOTE: 'deployment:check-remote',
  DEPLOYMENT_DISCOVER_SERVERS: 'deployment:discover-servers',

  // Hybrid LLM Orchestration
  ORCHESTRATOR_GET_CONFIG: 'orchestrator:get-config',
  ORCHESTRATOR_UPDATE_CONFIG: 'orchestrator:update-config',
  ORCHESTRATOR_ANALYZE: 'orchestrator:analyze',
  ORCHESTRATOR_APPROVE: 'orchestrator:approve',
  ORCHESTRATOR_DENY: 'orchestrator:deny',
  ORCHESTRATOR_EXECUTE: 'orchestrator:execute',
  ORCHESTRATOR_GET_PROPOSALS: 'orchestrator:get-proposals',

  // RBAC (Enterprise Access Control)
  RBAC_GET_STATE: 'rbac:get-state',
  RBAC_ENABLE: 'rbac:enable',
  RBAC_DISABLE: 'rbac:disable',
  RBAC_HAS_PERMISSION: 'rbac:has-permission',
  RBAC_GET_CURRENT_USER: 'rbac:get-current-user',
  RBAC_LIST_USERS: 'rbac:list-users',
  RBAC_ADD_USER: 'rbac:add-user',
  RBAC_UPDATE_USER_ROLE: 'rbac:update-user-role',
  RBAC_REMOVE_USER: 'rbac:remove-user',
  RBAC_SWITCH_USER: 'rbac:switch-user',
  RBAC_COMPLETE_ONBOARDING: 'rbac:complete-onboarding',
  RBAC_GET_ORGANIZATION: 'rbac:get-organization',
  RBAC_CREATE_ORGANIZATION: 'rbac:create-organization',
  RBAC_UPDATE_ORGANIZATION: 'rbac:update-organization',
  RBAC_LIST_TEAMS: 'rbac:list-teams',
  RBAC_CREATE_TEAM: 'rbac:create-team',
  RBAC_DELETE_TEAM: 'rbac:delete-team',
  RBAC_ADD_USER_TO_TEAM: 'rbac:add-user-to-team',
  RBAC_REMOVE_USER_FROM_TEAM: 'rbac:remove-user-from-team',
  RBAC_SET_USER_BUDGET: 'rbac:set-user-budget',
  RBAC_SET_TEAM_BUDGET: 'rbac:set-team-budget',
  RBAC_CHECK_BUDGET: 'rbac:check-budget',
  RBAC_GET_AUDIT_LOG: 'rbac:get-audit-log',
  RBAC_CLEAR_AUDIT_LOG: 'rbac:clear-audit-log',
  RBAC_GET_SSO_CONFIG: 'rbac:get-sso-config',
  RBAC_UPDATE_SSO_CONFIG: 'rbac:update-sso-config',

  // DSGVO/DSG Compliance
  GDPR_DELETE_USER_DATA: 'gdpr:delete-user-data',
  GDPR_EXPORT_USER_DATA: 'gdpr:export-user-data',
  GDPR_ENFORCE_RETENTION: 'gdpr:enforce-retention'
} as const
