/**
 * IPC Handler Registry — Central entry point for all modular IPC handler modules.
 *
 * Each module registers its own handlers using the shared wrapHandler utility.
 * The SEND_MESSAGE handler remains in ipc-handlers.ts as it orchestrates
 * multiple subsystems (RAG, MCP, Budget, Tracking, Security).
 */

export { registerApiKeyHandlers } from './api-key-handlers'
export { registerConversationHandlers } from './conversation-handlers'
export { registerInfrastructureHandlers } from './infrastructure-handlers'
export { registerIntegrationHandlers } from './integration-handlers'
export { registerBusinessHandlers } from './business-handlers'
export { registerContentHandlers } from './content-handlers'
export { registerRBACHandlers } from './rbac-handlers'
export { registerMCPHandlers } from './mcp-handlers'
export { registerRAGHandlers } from './rag-handlers'
