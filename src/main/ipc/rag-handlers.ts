/**
 * IPC Handlers — RAG (Qdrant, HTTP, Wissen, Context Injection)
 */

import { IPC_CHANNELS } from '../../shared/types'
import { getRAGManager } from '../rag/rag-manager'
import { getRAGHttpClient } from '../rag/rag-http-client'
import { getContextInjector } from '../rag/context-injector'
import { getRAGWissenClient } from '../rag/rag-wissen-client'
import { validateCollectionName, validateRAGQuery, validateFilePath, validateString } from '../security/input-validator'
import { wrapHandler, requirePermission, requireFeature } from './ipc-utils'
import type { QdrantConfig } from '../rag/qdrant-client'

export function registerRAGHandlers(): void {
  const ragManager = getRAGManager()
  const ragHttpClient = getRAGHttpClient()
  const contextInjector = getContextInjector()
  const ragWissenClient = getRAGWissenClient()

  // ── Local Qdrant RAG ─────────────────────────────────────

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

  // ── RAG HTTP Client (External Python Server) ─────────────

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

  // ── RAG-Wissen (Shared Knowledge Base) — Team+ tier ──────

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
}
