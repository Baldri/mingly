/**
 * IPC Handlers — RAG (HTTP, Wissen, Context Injection)
 *
 * Phase 6.5: Removed local Qdrant backend (dead code).
 * Kept: Generic HTTP RAG (user-configurable) + RAG-Wissen + Context Injection.
 */

import { IPC_CHANNELS } from '../../shared/types'
import { getRAGHttpClient } from '../rag/rag-http-client'
import { getContextInjector } from '../rag/context-injector'
import { getRAGWissenClient } from '../rag/rag-wissen-client'
import { wrapHandler, requireFeature } from './ipc-utils'

export function registerRAGHandlers(): void {
  const ragHttpClient = getRAGHttpClient()
  const contextInjector = getContextInjector()
  const ragWissenClient = getRAGWissenClient()

  // ── RAG HTTP Client (User-configurable external RAG server) ──

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

  // ── Context Injection Config ──────────────────────────────

  wrapHandler(IPC_CHANNELS.RAG_CONTEXT_GET_CONFIG, () => ({ success: true, config: contextInjector.getConfig() }))

  wrapHandler(IPC_CHANNELS.RAG_CONTEXT_UPDATE_CONFIG, (updates: any) => {
    contextInjector.updateConfig(updates)
    return { success: true, config: contextInjector.getConfig() }
  })

  // ── RAG-Wissen (Holger's Knowledge Base — Team+ tier) ─────

  wrapHandler(IPC_CHANNELS.RAG_WISSEN_HEALTH, async () => { requireFeature('shared_rag'); return ragWissenClient.healthCheck() })
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_SEARCH, async (query: string, collection?: string, limit?: number) => { requireFeature('shared_rag'); return ragWissenClient.search(query, collection, limit) })
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_GET_CONTEXT, async (query: string, collection?: string, limit?: number) => { requireFeature('shared_rag'); return ragWissenClient.getContext(query, collection, limit) })
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_LIST_COLLECTIONS, async () => { requireFeature('shared_rag'); return ragWissenClient.listCollections() })
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_GET_STATS, async (collection?: string) => { requireFeature('shared_rag'); return ragWissenClient.getStats(collection) })
  wrapHandler(IPC_CHANNELS.RAG_WISSEN_INDEX_DOCUMENT, async (filepath: string, collection?: string) => { requireFeature('shared_rag'); return ragWissenClient.indexDocument(filepath, collection) })

  wrapHandler(IPC_CHANNELS.RAG_WISSEN_GET_CONFIG, () => { requireFeature('shared_rag'); return { success: true, config: ragWissenClient.getConfig() } })

  wrapHandler(IPC_CHANNELS.RAG_WISSEN_UPDATE_CONFIG, (updates: any) => {
    requireFeature('shared_rag')
    ragWissenClient.updateConfig(updates)
    return { success: true, config: ragWissenClient.getConfig() }
  })

  wrapHandler(IPC_CHANNELS.RAG_WISSEN_LIST_PROJECTS, async () => {
    requireFeature('shared_rag')
    return ragWissenClient.listProjects()
  })
}
