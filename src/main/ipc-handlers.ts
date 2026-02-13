import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type { LLMProvider, Message } from '../shared/types'
import { getClientManager } from './llm-clients/client-manager'
import { ConversationModel } from './database/models/conversation'
import { MessageModel } from './database/models/message'
import { getSystemPromptManager } from './prompts/system-prompt-manager'
import { getCommandHandler } from './commands/command-handler'
import { generateId } from './utils/id-generator'
import { getSensitiveDataDetector } from './security/sensitive-data-detector'
import { getUploadPermissionManager } from './security/upload-permission-manager'
import { getContextInjector } from './rag/context-injector'
import { getMCPToolSelector } from './mcp/mcp-tool-selector'
import { getBudgetManager } from './tracking/budget-manager'
import { getTrackingEngine } from './tracking/tracking-engine'
import { getInputSanitizer } from './security/input-sanitizer'
import { getFeatureGateManager } from './services/feature-gate-manager'
import type { UploadPermissionRequest } from './security/upload-permission-manager'
import crypto from 'crypto'

// Modular IPC handler registration
import { registerApiKeyHandlers } from './ipc/api-key-handlers'
import { registerConversationHandlers } from './ipc/conversation-handlers'
import { registerInfrastructureHandlers } from './ipc/infrastructure-handlers'
import { registerIntegrationHandlers } from './ipc/integration-handlers'
import { registerBusinessHandlers } from './ipc/business-handlers'
import { registerContentHandlers } from './ipc/content-handlers'
import { registerRBACHandlers } from './ipc/rbac-handlers'
import { registerMCPHandlers } from './ipc/mcp-handlers'
import { registerRAGHandlers } from './ipc/rag-handlers'

// ============================================================
// Helpers (only needed for SEND_MESSAGE orchestration)
// ============================================================

/** Validate provider string is valid LLMProvider */
function validateProvider(provider: string): provider is LLMProvider {
  return ['anthropic', 'openai', 'google', 'local'].includes(provider)
}

const clientManager = getClientManager()
const systemPromptManager = getSystemPromptManager()
const commandHandler = getCommandHandler()
const sensitiveDataDetector = getSensitiveDataDetector()
const uploadPermissionManager = getUploadPermissionManager()
const contextInjector = getContextInjector()
const mcpToolSelector = getMCPToolSelector()
const trackingEngine = getTrackingEngine()

export async function registerIPCHandlers(): Promise<void> {

  // ========================================
  // Delegate to modular IPC handler modules
  // ========================================
  registerApiKeyHandlers()
  registerConversationHandlers()
  registerInfrastructureHandlers()
  registerIntegrationHandlers()
  registerRAGHandlers()
  registerMCPHandlers()
  registerRBACHandlers()
  registerBusinessHandlers()
  await registerContentHandlers()

  // ========================================
  // SEND_MESSAGE — Core LLM orchestration
  // Remains here as it coordinates multiple subsystems:
  // Input sanitization, Sensitive data scanning, Commands,
  // Budget enforcement, System prompts, RAG injection,
  // MCP auto-tool-selection, LLM streaming, Tracking
  // ========================================
  ipcMain.handle(
    IPC_CHANNELS.SEND_MESSAGE,
    async (event, conversationId: string, messages: Message[], provider_: string, model: string, temperature: number = 1.0) => {
      let provider = provider_
      try {
        // Gate cloud APIs for Free tier (only local/ollama allowed)
        if (provider !== 'local') {
          const gate = getFeatureGateManager()
          const result = gate.checkFeature('cloud_apis')
          if (!result.allowed) {
            throw new Error(`Feature 'cloud_apis' requires ${result.requiredTier} plan. Please upgrade.`)
          }
        }

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

        // 3. Budget enforcement — check BEFORE expensive RAG/MCP operations
        const budgetMgr = getBudgetManager()
        const budgetCheck = budgetMgr.checkBudget(provider)
        if (!budgetCheck.allowed) {
          if (budgetCheck.fallbackProvider) {
            console.log(`💰 Budget exceeded for ${provider}, falling back to ${budgetCheck.fallbackProvider}`)
            provider = budgetCheck.fallbackProvider
          } else {
            event.sender.send('message:error', budgetCheck.reason || 'Monthly budget exceeded for this provider.')
            return {
              success: false,
              error: budgetCheck.reason || 'Monthly budget exceeded for this provider.',
              budgetExceeded: true
            }
          }
        }

        // 4. Build system prompt with mode
        let systemPrompt = await systemPromptManager.buildSystemPrompt({
          customMode: mode
        })

        // 4b. Auto-inject RAG context if enabled
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

        // 4c. Auto-inject MCP tool results if enabled
        let mcpToolsUsed: Array<{ serverId: string; toolName: string; success: boolean; timeMs: number }> = []
        try {
          const mcpResult = await mcpToolSelector.selectAndExecute(actualMessage)
          if (mcpResult.context) {
            systemPrompt = mcpToolSelector.buildAugmentedPrompt(systemPrompt, mcpResult.context)
            mcpToolsUsed = mcpResult.toolsUsed
            console.log(
              `🔧 MCP tools executed (${mcpResult.toolsUsed.length} tools, ${mcpResult.totalTimeMs}ms)`
            )
          }
        } catch (mcpError) {
          console.warn('MCP auto-tool-selection failed (non-blocking):', mcpError)
        }

        // 5. Prepend system prompt to messages
        const messagesWithSystem: Message[] = [
          { id: generateId(), role: 'system', content: systemPrompt },
          ...messages.slice(0, -1), // Previous messages
          { id: generateId(), role: 'user', content: actualMessage } // Actual message (without @mode prefix)
        ]

        console.log(`Sending message to ${provider}/${model}${mode ? ` (mode: ${mode})` : ''}`)

        // 6. Validate provider and stream the response
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
          mcpToolsUsed: mcpToolsUsed.length > 0 ? mcpToolsUsed : undefined,
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

  console.log('✅ IPC handlers registered')
}
