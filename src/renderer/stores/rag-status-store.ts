import { create } from 'zustand'

interface RAGStatusState {
  /** RAG HTTP server (Python FastAPI) connection status */
  httpOnline: boolean | null
  /** RAG-Wissen MCP knowledge base status */
  wissenOnline: boolean | null
  /** Number of indexed collections */
  collectionCount: number
  /** Whether auto-context injection is enabled */
  contextInjectionEnabled: boolean
  /** Last health check timestamp */
  lastCheckedAt: number | null

  // Actions
  checkHealth: () => Promise<void>
}

export const useRAGStatusStore = create<RAGStatusState>((set) => ({
  httpOnline: null,
  wissenOnline: null,
  collectionCount: 0,
  contextInjectionEnabled: true,
  lastCheckedAt: null,

  checkHealth: async () => {
    try {
      const [httpResult, wissenResult, configResult] = await Promise.allSettled([
        window.electronAPI.ragHttp.health(),
        window.electronAPI.ragWissen.health(),
        window.electronAPI.ragContext.getConfig()
      ])

      const httpOnline =
        httpResult.status === 'fulfilled' && httpResult.value?.success === true
      const wissenOnline =
        wissenResult.status === 'fulfilled' && wissenResult.value?.success === true

      let collectionCount = 0
      if (httpOnline) {
        try {
          const colResult = await window.electronAPI.ragHttp.listCollections()
          collectionCount = colResult?.collections?.length ?? 0
        } catch {
          // non-critical
        }
      }

      const contextInjectionEnabled =
        configResult.status === 'fulfilled'
          ? configResult.value?.enabled !== false
          : true

      set({
        httpOnline,
        wissenOnline,
        collectionCount,
        contextInjectionEnabled,
        lastCheckedAt: Date.now()
      })
    } catch {
      set({ httpOnline: false, wissenOnline: false, lastCheckedAt: Date.now() })
    }
  }
}))
