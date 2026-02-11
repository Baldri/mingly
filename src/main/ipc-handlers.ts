import { ipcMain, dialog } from 'electron'
import * as fs from 'fs/promises'
import { IPC_CHANNELS } from '../shared/types'
import type { LLMProvider, AppSettings, Message } from '../shared/types'
import type { SensitiveDataType, RiskLevel } from './security/sensitive-data-detector'
import { KeychainManager } from './security/keychain-manager'
import { getClientManager } from './llm-clients/client-manager'
import { ConversationModel } from './database/models/conversation'
import { MessageModel } from './database/models/message'
import { getSystemPromptManager } from './prompts/system-prompt-manager'
import { getCommandHandler } from './commands/command-handler'
import { SimpleStore } from './utils/simple-store'
import { generateId } from './utils/id-generator'
import { getNetworkAIManager } from './network/network-ai-manager'
import { getFileAccessManager } from './file-access/file-access-manager'
import { getSensitiveDataDetector } from './security/sensitive-data-detector'
import { getUploadPermissionManager } from './security/upload-permission-manager'
import { getRAGManager } from './rag/rag-manager'
import { getRAGHttpClient } from './rag/rag-http-client'
import { getContextInjector } from './rag/context-injector'
import { getRAGWissenClient } from './rag/rag-wissen-client'
import { getMCPClientManager } from './mcp/mcp-client-manager'
import { getIntegrationManager } from './integrations/integration-manager'
import { getBudgetManager } from './tracking/budget-manager'
import { getTrackingEngine } from './tracking/tracking-engine'
import { getDeploymentManager } from './server/deployment-manager'
import { getHybridOrchestrator } from './routing/hybrid-orchestrator'
import { getRBACManager } from './security/rbac-manager'
import { getInputSanitizer } from './security/input-sanitizer'
import { getRateLimiter } from './security/rate-limiter'
import { validateFilePath, validateCollectionName, validateRAGQuery, validateMCPArgs, validateString } from './security/input-validator'
import type { NetworkAIServerConfig } from '../shared/network-ai-types'
import type { FileAccessRequest, FileAccessPermission } from '../shared/file-access-types'
import type { UploadPermissionRequest } from './security/upload-permission-manager'
import type { QdrantConfig } from './rag/qdrant-client'
import crypto from 'crypto'

// ============================================================
// Helpers
// ============================================================

/** Validate provider string is valid LLMProvider */
function validateProvider(provider: string): provider is LLMProvider {
  return ['anthropic', 'openai', 'google', 'local'].includes(provider)
}

/**
 * Wrap an IPC handler with consistent error handling + rate limiting.
 * Eliminates 90+ duplicated try-catch blocks across all handlers.
 */
function wrapHandler<T extends any[]>(
  channel: string,
  handler: (...args: T) => Promise<any> | any
): void {
  ipcMain.handle(channel, async (_event, ...args: any[]) => {
    // Rate limiting
    const rateLimiter = getRateLimiter()
    const rateResult = rateLimiter.check(channel)
    if (!rateResult.allowed) {
      console.warn(`[IPC] Rate limit exceeded for ${channel}`)
      return { success: false, error: 'Rate limit exceeded. Please try again later.', retryAfterMs: rateResult.retryAfterMs }
    }

    try {
      return await handler(...(args as unknown as T))
    } catch (error) {
      console.error(`[IPC] ${channel} failed:`, (error as Error).message)
      return { success: false, error: (error as Error).message }
    }
  })
}


const keychainManager = new KeychainManager()
const clientManager = getClientManager()
const store = new SimpleStore()
const systemPromptManager = getSystemPromptManager()
const commandHandler = getCommandHandler()
const networkAIManager = getNetworkAIManager()
const fileAccessManager = getFileAccessManager()
const sensitiveDataDetector = getSensitiveDataDetector()
const uploadPermissionManager = getUploadPermissionManager()
const ragManager = getRAGManager()
const ragHttpClient = getRAGHttpClient()
const contextInjector = getContextInjector()
const mcpManager = getMCPClientManager()
const trackingEngine = getTrackingEngine()

/**
 * Enforce RBAC permission check. Throws if denied.
 * When RBAC is disabled, all permissions are granted (hasPermission returns true).
 */
function requirePermission(permissionId: string): void {
  const rbac = getRBACManager()
  if (!rbac.hasPermission(permissionId)) {
    throw new Error(`Access denied: missing permission '${permissionId}'`)
  }
}

export function registerIPCHandlers(): void {

  // Load API keys from keychain on startup
  initializeAPIKeys()

  // ========================================
  // API Key Management
  // ========================================

  wrapHandler(IPC_CHANNELS.SAVE_API_KEY, async (provider: LLMProvider, apiKey: string) => {
    requirePermission('settings.api_keys')
    await keychainManager.saveAPIKey(provider, apiKey)
    if (validateProvider(provider)) {
      clientManager.setApiKey(provider, apiKey)
    }
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.GET_API_KEY, async (provider: LLMProvider) => {
    const apiKey = await keychainManager.getAPIKey(provider)
    return { success: true, apiKey }
  })

  wrapHandler(IPC_CHANNELS.DELETE_API_KEY, async (provider: LLMProvider) => {
    requirePermission('settings.api_keys')
    await keychainManager.deleteAPIKey(provider)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.LIST_API_KEYS, async () => {
    const providers = await keychainManager.listConfiguredProviders()
    return { success: true, providers }
  })

  wrapHandler(IPC_CHANNELS.VALIDATE_API_KEY, async (provider: LLMProvider) => {
    if (!validateProvider(provider)) {
      return { success: false, valid: false, error: 'Invalid provider' }
    }
    const isValid = await clientManager.validateApiKey(provider)
    return { success: true, valid: isValid }
  })

  // LLM Operations
  ipcMain.handle(
    IPC_CHANNELS.SEND_MESSAGE,
    async (event, conversationId: string, messages: Message[], provider: string, model: string, temperature: number = 1.0) => {
      try {
        const userMessage = messages[messages.length - 1].content

        // 0a. Prompt Injection Defense: Scan user input for injection patterns
        const inputSanitizer = getInputSanitizer()
        const sanitizationResult = inputSanitizer.sanitize(userMessage)
        if (!sanitizationResult.safe) {
          console.warn(
            `[Security] Prompt injection risk detected (score: ${sanitizationResult.riskScore}, warnings: ${sanitizationResult.warnings.map(w => w.type).join(', ')})`
          )
          // Critical risk (score >= 80) — block the request
          if (sanitizationResult.riskScore >= 80) {
            event.sender.send('message:error', 'Message blocked: High-risk content detected. Please rephrase your message.')
            return {
              success: false,
              error: 'Message blocked due to high-risk content patterns detected.',
              injectionBlocked: true,
              riskScore: sanitizationResult.riskScore,
              warnings: sanitizationResult.warnings.map(w => ({ type: w.type, severity: w.severity }))
            }
          }
          // Medium risk (50-79) — warn but allow (defense in depth — LLM has its own safeguards)
        }

        // 0b. Security Check: Scan for sensitive data before sending to cloud LLMs
        const fullMessageContent = messages.map((m) => m.content).join('\n')

        // Determine destination type
        const isCloudProvider = provider === 'anthropic' || provider === 'openai' || provider === 'google'
        const destination = isCloudProvider ? 'cloud' : 'local'

        // Scan for sensitive data
        const scanResult = sensitiveDataDetector.scan(fullMessageContent)

        if (scanResult.hasSensitiveData && destination === 'cloud') {
          console.log(
            `⚠️ Sensitive data detected (${scanResult.matches.length} items, risk: ${scanResult.overallRiskLevel})`
          )

          // Create upload permission request
          const fileId = crypto.createHash('sha256').update(fullMessageContent).digest('hex')
          const request: UploadPermissionRequest = {
            fileId,
            filePath: '<message-content>',
            directoryId: 'conversation',
            destination,
            provider,
            scanResult,
            timestamp: Date.now()
          }

          // Check permission
          const permissionResponse = await uploadPermissionManager.checkUploadPermission(request)

          if (permissionResponse.decision === 'denied') {
            // Blocked - sensitive data detected
            console.log(`🚫 Upload blocked: ${permissionResponse.reason}`)
            event.sender.send('message:error', permissionResponse.reason)
            return {
              success: false,
              error: permissionResponse.reason,
              sensitiveDataBlocked: true,
              scanResult
            }
          }

          if (permissionResponse.requiresUserConsent) {
            // Need user consent - send request to renderer
            console.log(`⏸️ User consent required for sensitive data upload`)
            event.sender.send('message:permission-required', {
              request,
              response: permissionResponse,
              matches: scanResult.matches.map((m) => ({
                type: m.type,
                value: m.value,
                riskLevel: m.riskLevel
              }))
            })

            return {
              success: false,
              pendingConsent: true,
              request,
              scanResult
            }
          }
        }

        // 1. Check for commands
        const commandResult = await commandHandler.handleCommand(userMessage)

        if (commandResult.handled) {
          // Command was handled - send response if any
          if (commandResult.response) {
            event.sender.send('message:complete')
            return {
              success: true,
              response: commandResult.response,
              isCommand: true,
              action: commandResult.action
            }
          }

          // Command has action but no response (like /settings)
          if (commandResult.action) {
            return {
              success: true,
              isCommand: true,
              action: commandResult.action
            }
          }
        }

        // 2. Extract actual message (if mode modifier was used)
        const actualMessage = commandHandler.extractMessage(userMessage, commandResult)
        const mode = commandHandler.getMode(commandResult)

        // 3. Build system prompt with mode
        let systemPrompt = await systemPromptManager.buildSystemPrompt({
          customMode: mode
        })

        // 3b. Auto-inject RAG context if enabled
        let ragSources: Array<{ filename: string; score: number }> = []
        try {
          const ragResult = await contextInjector.getContext(actualMessage)
          if (ragResult.context) {
            systemPrompt = contextInjector.buildAugmentedPrompt(systemPrompt, ragResult.context)
            ragSources = ragResult.sources
            console.log(
              `🔍 RAG context injected (${ragResult.sources.length} sources, ${ragResult.source}, ${ragResult.timeMs}ms)`
            )
          }
        } catch (ragError) {
          console.warn('RAG context injection failed (non-blocking):', ragError)
        }

        // 4. Prepend system prompt to messages
        const messagesWithSystem: Message[] = [
          { id: generateId(), role: 'system', content: systemPrompt },
          ...messages.slice(0, -1), // Previous messages
          { id: generateId(), role: 'user', content: actualMessage } // Actual message (without @mode prefix)
        ]

        console.log(`Sending message to ${provider}/${model}${mode ? ` (mode: ${mode})` : ''}`)

        // 5. Validate provider and stream the response
        if (!validateProvider(provider)) {
          throw new Error(`Invalid provider: ${provider}`)
        }

        const startTime = Date.now()

        const stream = await clientManager.sendMessage(
          provider,
          messagesWithSystem,
          model,
          temperature
        )

        let fullResponse = ''

        for await (const chunk of stream) {
          if (!chunk.done) {
            fullResponse += chunk.content
            // Send chunk to renderer
            event.sender.send('message:chunk', chunk.content)
          }
        }

        const latencyMs = Date.now() - startTime

        // 6. Persist assistant response to database
        try {
          MessageModel.create(conversationId, 'assistant', fullResponse)
          ConversationModel.updateTimestamp(conversationId)
        } catch (dbError) {
          console.error('Failed to persist message to database:', dbError)
        }

        // 7. Security: Scan LLM output for leaked sensitive data before returning
        const outputScanResult = sensitiveDataDetector.scan(fullResponse)
        if (outputScanResult.hasSensitiveData) {
          console.warn(
            `[Security] LLM response contains sensitive data (${outputScanResult.matches.length} items, risk: ${outputScanResult.overallRiskLevel})`
          )
          // Note: We log the warning but don't block — the user asked for this response.
          // In enterprise mode, this could be escalated to audit or redacted.
        }

        // 8. Track usage and compute metadata (PRIVACY: no full-text logging)
        const inputText = messagesWithSystem.map((m) => m.content).join('\n')
        const inputTokens = trackingEngine.estimateTokens(inputText)
        const outputTokens = trackingEngine.estimateTokens(fullResponse)
        const { totalCost } = trackingEngine.calculateCost(model, inputTokens, outputTokens)

        try {
          trackingEngine.recordEvent({
            conversationId,
            provider,
            model,
            inputText: '',  // DSGVO/DSG: Do NOT log full message text to analytics
            outputText: '', // DSGVO/DSG: Do NOT log full response text to analytics
            latencyMs,
            ragUsed: ragSources.length > 0,
            ragSourceCount: ragSources.length,
            success: true,
            inputTokens,
            outputTokens
          })
        } catch (trackErr) {
          console.warn('Tracking failed (non-blocking):', trackErr)
        }

        event.sender.send('message:complete')

        return {
          success: true,
          response: fullResponse,
          ragSources: ragSources.length > 0 ? ragSources : undefined,
          metadata: {
            provider,
            model,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            cost: totalCost,
            latencyMs
          }
        }
      } catch (error) {
        console.error('Failed to send message:', error)

        // Track failed request
        try {
          trackingEngine.recordEvent({
            conversationId,
            provider,
            model,
            inputText: '',
            outputText: '',
            latencyMs: 0,
            ragUsed: false,
            ragSourceCount: 0,
            success: false,
            errorMessage: (error as Error).message
          })
        } catch (_) { /* ignore tracking errors */ }

        event.sender.send('message:error', (error as Error).message)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // ========================================
  // Conversation Management
  // ========================================

  wrapHandler(IPC_CHANNELS.CREATE_CONVERSATION, (title: string, provider: string, model: string) => {
    const conversation = ConversationModel.create(title, provider, model)
    return { success: true, conversation }
  })

  wrapHandler(IPC_CHANNELS.GET_CONVERSATIONS, () => {
    return { success: true, conversations: ConversationModel.findAll() }
  })

  wrapHandler(IPC_CHANNELS.GET_CONVERSATION, (conversationId: string) => {
    const conversation = ConversationModel.findById(conversationId)
    if (!conversation) return { success: false, error: 'Conversation not found' }
    return { success: true, conversation, messages: MessageModel.findByConversation(conversationId) }
  })

  wrapHandler(IPC_CHANNELS.DELETE_CONVERSATION, (conversationId: string) => {
    requirePermission('chat.delete')
    MessageModel.deleteByConversation(conversationId)
    ConversationModel.delete(conversationId)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.UPDATE_CONVERSATION, (conversationId: string, updates: { title?: string }) => {
    ConversationModel.update(conversationId, updates)
    return { success: true }
  })

  // ========================================
  // Settings Management
  // ========================================

  wrapHandler(IPC_CHANNELS.GET_SETTINGS, () => {
    const settings = (store.get('settings') || {
      theme: 'system',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-3-5-sonnet-20241022',
      enableParallelMode: false,
      enableCostTracking: true,
      enableAuditLog: true
    }) as AppSettings
    return { success: true, settings }
  })

  wrapHandler(IPC_CHANNELS.UPDATE_SETTINGS, (settings: Partial<AppSettings>) => {
    requirePermission('settings.general')
    const currentSettings = (store.get('settings') || {}) as AppSettings
    store.set('settings', { ...currentSettings, ...settings })
    return { success: true }
  })

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

  // ========================================
  // RAG (Retrieval-Augmented Generation)
  // ========================================

  wrapHandler(IPC_CHANNELS.RAG_INITIALIZE, async (config: QdrantConfig) => { requirePermission('rag.manage'); return ragManager.initialize(config) })
  wrapHandler(IPC_CHANNELS.RAG_CREATE_COLLECTION, async (name: string) => { requirePermission('rag.manage'); const v = validateCollectionName(name); if (!v.valid) throw new Error(v.error); return ragManager.createCollection(name) })
  wrapHandler(IPC_CHANNELS.RAG_DELETE_COLLECTION, async (name: string) => { requirePermission('rag.manage'); const v = validateCollectionName(name); if (!v.valid) throw new Error(v.error); return ragManager.deleteCollection(name) })
  wrapHandler(IPC_CHANNELS.RAG_LIST_COLLECTIONS, async () => { requirePermission('rag.search'); return ragManager.listCollections() })
  wrapHandler(IPC_CHANNELS.RAG_GET_COLLECTION_INFO, async (name: string) => { requirePermission('rag.search'); return ragManager.getCollectionInfo(name) })

  wrapHandler(IPC_CHANNELS.RAG_INDEX_DOCUMENT, async (collectionName: string, text: string, source: string, filename: string, metadata?: any) => {
    requirePermission('rag.index')
    const cv = validateCollectionName(collectionName); if (!cv.valid) throw new Error(cv.error)
    const sv = validateString(text, 'text', 500_000); if (!sv.valid) throw new Error(sv.error)
    return ragManager.indexDocument(collectionName, text, source, filename, metadata)
  })

  wrapHandler(IPC_CHANNELS.RAG_INDEX_FILE, async (collectionName: string, filePath: string, metadata?: any) => {
    requirePermission('rag.index')
    const cv = validateCollectionName(collectionName); if (!cv.valid) throw new Error(cv.error)
    const fv = validateFilePath(filePath); if (!fv.valid) throw new Error(fv.error)
    return ragManager.indexFile(collectionName, filePath, metadata)
  })

  wrapHandler(IPC_CHANNELS.RAG_SEARCH, async (collectionName: string, query: string, limit?: number, scoreThreshold?: number) => {
    requirePermission('rag.search')
    const cv = validateCollectionName(collectionName); if (!cv.valid) throw new Error(cv.error)
    const qv = validateRAGQuery(query); if (!qv.valid) throw new Error(qv.error)
    return ragManager.search(collectionName, query, limit, scoreThreshold)
  })

  wrapHandler(IPC_CHANNELS.RAG_GET_CONTEXT, async (collectionName: string, query: string, limit?: number) => {
    requirePermission('rag.search')
    const cv = validateCollectionName(collectionName); if (!cv.valid) throw new Error(cv.error)
    const qv = validateRAGQuery(query); if (!qv.valid) throw new Error(qv.error)
    return { success: true, context: await ragManager.getContext(collectionName, query, limit) }
  })

  // ========================================
  // RAG HTTP Client (External Python Server)
  // ========================================

  wrapHandler(IPC_CHANNELS.RAG_HTTP_HEALTH, async () => ragHttpClient.healthCheck())
  wrapHandler(IPC_CHANNELS.RAG_HTTP_SEARCH, async (collectionName: string, query: string, limit?: number, scoreThreshold?: number) => ragHttpClient.search(collectionName, query, limit, scoreThreshold))
  wrapHandler(IPC_CHANNELS.RAG_HTTP_GET_CONTEXT, async (collectionName: string, query: string, limit?: number) => ragHttpClient.getContext(collectionName, query, limit))
  wrapHandler(IPC_CHANNELS.RAG_HTTP_LIST_COLLECTIONS, async () => ragHttpClient.listCollections())
  wrapHandler(IPC_CHANNELS.RAG_HTTP_INDEX_FILE, async (collectionName: string, filePath: string) => ragHttpClient.indexFile(collectionName, filePath))
  wrapHandler(IPC_CHANNELS.RAG_HTTP_INDEX_DIRECTORY, async (collectionName: string, directoryPath: string, recursive?: boolean) => ragHttpClient.indexDirectory(collectionName, directoryPath, recursive))

  wrapHandler(IPC_CHANNELS.RAG_HTTP_UPDATE_CONFIG, (config: any) => {
    ragHttpClient.updateConfig(config)
    return { success: true }
  })

  // ========================================
  // RAG Context Injection Configuration
  // ========================================

  wrapHandler(IPC_CHANNELS.RAG_CONTEXT_GET_CONFIG, () => ({ success: true, config: contextInjector.getConfig() }))

  wrapHandler(IPC_CHANNELS.RAG_CONTEXT_UPDATE_CONFIG, (updates: any) => {
    contextInjector.updateConfig(updates)
    return { success: true, config: contextInjector.getConfig() }
  })

  // ========================================
  // RAG-Wissen (External Knowledge Base)
  // ========================================

  const ragWissenClient = getRAGWissenClient()

  wrapHandler(IPC_CHANNELS.RAG_WISSEN_HEALTH, async () => ragWissenClient.healthCheck())
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_SEARCH, async (query: string, collection?: string, limit?: number) => ragWissenClient.search(query, collection, limit))
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_GET_CONTEXT, async (query: string, collection?: string, limit?: number) => ragWissenClient.getContext(query, collection, limit))
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_LIST_COLLECTIONS, async () => ragWissenClient.listCollections())
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_GET_STATS, async (collection?: string) => ragWissenClient.getStats(collection))
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_INDEX_DOCUMENT, async (filepath: string, collection?: string) => ragWissenClient.indexDocument(filepath, collection))

  wrapHandler(IPC_CHANNELS.RAG_WISSEN_GET_CONFIG, () => ({ success: true, config: ragWissenClient.getConfig() }))

  wrapHandler(IPC_CHANNELS.RAG_WISSEN_UPDATE_CONFIG, (updates: any) => {
    ragWissenClient.updateConfig(updates)
    return { success: true, config: ragWissenClient.getConfig() }
  })

  // ========================================
  // MCP Client Manager
  // ========================================

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
    requirePermission('mcp.execute')
    const sv = validateString(serverId, 'serverId', 256); if (!sv.valid) throw new Error(sv.error)
    const tv = validateString(toolName, 'toolName', 256); if (!tv.valid) throw new Error(tv.error)
    const av = validateMCPArgs(args); if (!av.valid) throw new Error(av.error)
    const result = await mcpManager.executeTool(serverId, toolName, args || {})
    return { success: !result.error, ...result }
  })

  // ========================================
  // Tracking & Analytics
  // ========================================

  wrapHandler(IPC_CHANNELS.TRACKING_GET_SUMMARY, (fromMs?: number, toMs?: number) => ({ success: true, summary: trackingEngine.getSummary(fromMs, toMs) }))
  wrapHandler(IPC_CHANNELS.TRACKING_GET_DAILY_USAGE, (days?: number) => ({ success: true, dailyUsage: trackingEngine.getDailyUsage(days) }))
  wrapHandler(IPC_CHANNELS.TRACKING_GET_RECENT_EVENTS, (limit?: number) => ({ success: true, events: trackingEngine.getRecentEvents(limit) }))

  // ========================================
  // Integrations (Slack, Notion, Obsidian)
  // ========================================

  const integrationManager = getIntegrationManager()

  wrapHandler(IPC_CHANNELS.INTEGRATION_GET_STATUS, () => ({ success: true, status: integrationManager.getStatus() }))

  // Slack
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_CONFIGURE, (webhookUrl: string, teamName?: string, botToken?: string) => { requirePermission('integrations.manage'); return integrationManager.configureSlack(webhookUrl, teamName, botToken) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_SHARE, async (params: any) => { requirePermission('integrations.manage'); return integrationManager.shareToSlack(params) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_DISCONNECT, () => { requirePermission('integrations.manage'); return integrationManager.disconnectSlack() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_LIST_CHANNELS, async () => { requirePermission('integrations.manage'); return integrationManager.listSlackChannels() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_SLACK_INDEX_TO_RAG, async (opts?: any) => { requirePermission('integrations.manage'); return integrationManager.indexSlackToRAG(opts) })

  // Notion
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_CONFIGURE, (apiKey: string, workspaceName?: string) => { requirePermission('integrations.manage'); return integrationManager.configureNotion(apiKey, workspaceName) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_SAVE, async (params: any) => { requirePermission('integrations.manage'); return integrationManager.saveToNotion(params) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_DISCONNECT, () => { requirePermission('integrations.manage'); return integrationManager.disconnectNotion() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_LIST_DATABASES, async () => { requirePermission('integrations.manage'); return integrationManager.listNotionDatabases() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_NOTION_INDEX_TO_RAG, async (opts?: any) => { requirePermission('integrations.manage'); return integrationManager.indexNotionToRAG(opts) })

  // Obsidian
  wrapHandler(IPC_CHANNELS.INTEGRATION_OBSIDIAN_SET_VAULT, async (vaultPath: string) => { requirePermission('integrations.manage'); return integrationManager.setObsidianVault(vaultPath) })
  wrapHandler(IPC_CHANNELS.INTEGRATION_OBSIDIAN_INDEX, async () => { requirePermission('integrations.manage'); return integrationManager.indexObsidianVault() })
  wrapHandler(IPC_CHANNELS.INTEGRATION_OBSIDIAN_DISCONNECT, () => { requirePermission('integrations.manage'); return integrationManager.disconnectObsidian() })

  // ========================================
  // Budget Management
  // ========================================

  const budgetManager = getBudgetManager()

  wrapHandler(IPC_CHANNELS.BUDGET_GET_CONFIG, () => { requirePermission('budget.view'); return { success: true, config: budgetManager.getConfig() } })
  wrapHandler(IPC_CHANNELS.BUDGET_UPDATE_CONFIG, (updates: any) => { requirePermission('budget.manage'); return budgetManager.updateConfig(updates) })
  wrapHandler(IPC_CHANNELS.BUDGET_GET_STATUS, async () => { requirePermission('budget.view'); return { success: true, ...(await budgetManager.getStatus()) } })

  // ========================================
  // Deployment / Server + Client
  // ========================================

  const deploymentManager = getDeploymentManager()

  wrapHandler(IPC_CHANNELS.DEPLOYMENT_GET_CONFIG, () => { requirePermission('deployment.manage'); return { success: true, config: deploymentManager.getConfig() } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_UPDATE_CONFIG, (config: any) => { requirePermission('deployment.manage'); return { success: true, config: deploymentManager.updateConfig(config) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_GET_STATUS, () => { requirePermission('deployment.manage'); return { success: true, status: deploymentManager.getStatus() } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_START_SERVER, async (configOverride?: any) => { requirePermission('deployment.manage'); return deploymentManager.startServer(configOverride) })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_STOP_SERVER, async () => { requirePermission('deployment.manage'); return deploymentManager.stopServer() })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_ADD_REMOTE, (server: any) => { requirePermission('deployment.manage'); return { success: true, server: deploymentManager.addRemoteServer(server) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_REMOVE_REMOTE, (serverId: string) => { requirePermission('deployment.manage'); return { success: true, removed: deploymentManager.removeRemoteServer(serverId) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_LIST_REMOTES, () => { requirePermission('deployment.manage'); return { success: true, servers: deploymentManager.getRemoteServers() } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_CHECK_REMOTE, async (serverId: string) => { requirePermission('deployment.manage'); return { success: true, ...(await deploymentManager.checkRemoteServer(serverId)) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_DISCOVER_SERVERS, async (networkRange?: string) => { requirePermission('deployment.manage'); return { success: true, servers: await deploymentManager.discoverServers(networkRange) } })

  // ========================================
  // Hybrid LLM Orchestration
  // ========================================

  const orchestrator = getHybridOrchestrator()

  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_GET_CONFIG, () => ({ success: true, config: orchestrator.getConfig() }))

  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_UPDATE_CONFIG, (config: any) => {
    orchestrator.updateConfig(config)
    return { success: true, config: orchestrator.getConfig() }
  })

  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_ANALYZE, async (message: string, provider: string, model: string) => ({ success: true, proposal: await orchestrator.analyzeForDelegation(message, provider, model) }))
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_APPROVE, (proposalId: string) => ({ success: orchestrator.approveProposal(proposalId) }))
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_DENY, (proposalId: string) => ({ success: orchestrator.denyProposal(proposalId) }))
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_EXECUTE, async (proposalId: string) => { const r = await orchestrator.executeDelegation(proposalId); return { success: !!r, result: r } })
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_GET_PROPOSALS, () => ({ success: true, proposals: orchestrator.getPendingProposals() }))

  // ========================================
  // RBAC (Enterprise Access Control)
  // ========================================

  const rbacManager = getRBACManager()

  wrapHandler(IPC_CHANNELS.RBAC_GET_STATE, () => ({ success: true, state: rbacManager.getFullState() }))
  wrapHandler(IPC_CHANNELS.RBAC_ENABLE, () => { rbacManager.enable(); return { success: true } })
  wrapHandler(IPC_CHANNELS.RBAC_DISABLE, () => { rbacManager.disable(); return { success: true } })
  wrapHandler(IPC_CHANNELS.RBAC_HAS_PERMISSION, (permissionId: string) => rbacManager.hasPermission(permissionId))
  wrapHandler(IPC_CHANNELS.RBAC_GET_CURRENT_USER, () => rbacManager.getCurrentUser())
  wrapHandler(IPC_CHANNELS.RBAC_LIST_USERS, () => rbacManager.listUsers())
  wrapHandler(IPC_CHANNELS.RBAC_ADD_USER, (name: string, role: string, email?: string, teamIds?: string[]) => rbacManager.addUser(name, role as any, email, teamIds))
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_USER_ROLE, (userId: string, role: string) => rbacManager.updateUserRole(userId, role as any))
  wrapHandler(IPC_CHANNELS.RBAC_REMOVE_USER, (userId: string) => rbacManager.removeUser(userId))
  wrapHandler(IPC_CHANNELS.RBAC_SWITCH_USER, (userId: string) => rbacManager.switchUser(userId))
  wrapHandler(IPC_CHANNELS.RBAC_COMPLETE_ONBOARDING, (userId: string) => rbacManager.completeOnboarding(userId))
  wrapHandler(IPC_CHANNELS.RBAC_GET_ORGANIZATION, () => rbacManager.getOrganization())
  wrapHandler(IPC_CHANNELS.RBAC_CREATE_ORGANIZATION, (name: string, settings?: any) => rbacManager.createOrganization(name, settings))
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_ORGANIZATION, (updates: any) => rbacManager.updateOrganization(updates))
  wrapHandler(IPC_CHANNELS.RBAC_LIST_TEAMS, () => rbacManager.listTeams())
  wrapHandler(IPC_CHANNELS.RBAC_CREATE_TEAM, (name: string, managerId?: string) => rbacManager.createTeam(name, managerId))
  wrapHandler(IPC_CHANNELS.RBAC_DELETE_TEAM, (teamId: string) => rbacManager.deleteTeam(teamId))
  wrapHandler(IPC_CHANNELS.RBAC_ADD_USER_TO_TEAM, (userId: string, teamId: string) => rbacManager.addUserToTeam(userId, teamId))
  wrapHandler(IPC_CHANNELS.RBAC_REMOVE_USER_FROM_TEAM, (userId: string, teamId: string) => rbacManager.removeUserFromTeam(userId, teamId))
  wrapHandler(IPC_CHANNELS.RBAC_SET_USER_BUDGET, (userId: string, limit: any) => rbacManager.setUserBudget(userId, limit))
  wrapHandler(IPC_CHANNELS.RBAC_SET_TEAM_BUDGET, (teamId: string, limit: any) => rbacManager.setTeamBudget(teamId, limit))
  wrapHandler(IPC_CHANNELS.RBAC_CHECK_BUDGET, (userId: string, tokens: number, costCents: number) => rbacManager.checkBudget(userId, tokens, costCents))
  wrapHandler(IPC_CHANNELS.RBAC_GET_AUDIT_LOG, (opts?: any) => rbacManager.getAuditLog(opts))
  wrapHandler(IPC_CHANNELS.RBAC_CLEAR_AUDIT_LOG, () => rbacManager.clearAuditLog())
  wrapHandler(IPC_CHANNELS.RBAC_GET_SSO_CONFIG, () => rbacManager.getSSOConfig())
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_SSO_CONFIG, (provider: string, ssoConfig: any, enforce: boolean) => rbacManager.updateSSOConfig(provider as any, ssoConfig, enforce))

  // ========================================
  // DSGVO/DSG Compliance
  // ========================================

  wrapHandler(IPC_CHANNELS.GDPR_DELETE_USER_DATA, (userId: string) => {
    requirePermission('users.manage')
    return rbacManager.deleteUserData(userId)
  })

  wrapHandler(IPC_CHANNELS.GDPR_EXPORT_USER_DATA, (userId: string) => {
    return rbacManager.exportUserData(userId)
  })

  wrapHandler(IPC_CHANNELS.GDPR_ENFORCE_RETENTION, () => {
    requirePermission('org.manage')
    return rbacManager.enforceRetention()
  })

  // ========================================
  // File Operations
  // ========================================

  ipcMain.handle(IPC_CHANNELS.SELECT_FILE, async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Directory'
      })
      return { filePaths: result.filePaths, canceled: result.canceled }
    } catch (error) {
      return { filePaths: [], canceled: true, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.READ_FILE, async (_, filePath: string) => {
    try {
      const pathValidation = validateFilePath(filePath)
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error }
      }
      const content = await fs.readFile(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  console.log('✅ IPC handlers registered')
}

async function initializeAPIKeys(): Promise<void> {
  try {
    const providers = await keychainManager.listConfiguredProviders()

    for (const provider of providers) {
      if (validateProvider(provider)) {
        const apiKey = await keychainManager.getAPIKey(provider)
        if (apiKey) {
          clientManager.setApiKey(provider, apiKey)
        }
      }
    }

    console.log(`✅ Initialized API keys for ${providers.length} providers`)
  } catch (error) {
    console.error('Failed to initialize API keys:', error)
  }
}
