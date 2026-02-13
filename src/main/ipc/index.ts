/**
 * IPC Handler Registry — Central entry point for all IPC handler modules.
 *
 * The SEND_MESSAGE handler remains in ipc-handlers.ts as it orchestrates
 * multiple subsystems (RAG, MCP, Budget, Tracking, Security). All other
 * handlers are delegated to focused modules.
 */

export { registerIPCHandlers } from '../ipc-handlers'

// Individual handler modules
export { registerApiKeyHandlers } from './api-key-handlers'
export { registerRAGHandlers } from './rag-handlers'
export { registerMCPHandlers } from './mcp-handlers'
export { registerConversationHandlers } from './conversation-handlers'
export { registerInfrastructureHandlers } from './infrastructure-handlers'
export { registerIntegrationHandlers } from './integration-handlers'
export { registerBusinessHandlers } from './business-handlers'
export { registerContentHandlers } from './content-handlers'
export { registerRBACHandlers } from './rbac-handlers'
