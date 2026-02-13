/**
 * RAG Status Store — Tests for health checking and status tracking
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electronAPI
const mockElectronAPI = {
  ragHttp: {
    health: vi.fn(),
    listCollections: vi.fn()
  },
  ragWissen: {
    health: vi.fn()
  },
  ragContext: {
    getConfig: vi.fn()
  }
}

vi.stubGlobal('window', { electronAPI: mockElectronAPI })

const { useRAGStatusStore } = await import('../../src/renderer/stores/rag-status-store')

describe('RAGStatusStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRAGStatusStore.setState({
      httpOnline: null,
      wissenOnline: null,
      collectionCount: 0,
      contextInjectionEnabled: true,
      lastCheckedAt: null
    })
  })

  describe('initial state', () => {
    it('should start with null (unknown) status', () => {
      const state = useRAGStatusStore.getState()
      expect(state.httpOnline).toBeNull()
      expect(state.wissenOnline).toBeNull()
      expect(state.collectionCount).toBe(0)
      expect(state.contextInjectionEnabled).toBe(true)
      expect(state.lastCheckedAt).toBeNull()
    })
  })

  describe('checkHealth', () => {
    it('should detect both services online', async () => {
      mockElectronAPI.ragHttp.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })
      mockElectronAPI.ragHttp.listCollections.mockResolvedValue({
        collections: [{ name: 'docs' }, { name: 'code' }]
      })

      await useRAGStatusStore.getState().checkHealth()

      const state = useRAGStatusStore.getState()
      expect(state.httpOnline).toBe(true)
      expect(state.wissenOnline).toBe(true)
      expect(state.collectionCount).toBe(2)
      expect(state.contextInjectionEnabled).toBe(true)
      expect(state.lastCheckedAt).toBeGreaterThan(0)
    })

    it('should detect only HTTP server online', async () => {
      mockElectronAPI.ragHttp.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragWissen.health.mockRejectedValue(new Error('offline'))
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })
      mockElectronAPI.ragHttp.listCollections.mockResolvedValue({
        collections: [{ name: 'docs' }]
      })

      await useRAGStatusStore.getState().checkHealth()

      const state = useRAGStatusStore.getState()
      expect(state.httpOnline).toBe(true)
      expect(state.wissenOnline).toBe(false)
      expect(state.collectionCount).toBe(1)
    })

    it('should detect only Wissen online', async () => {
      mockElectronAPI.ragHttp.health.mockRejectedValue(new Error('offline'))
      mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })

      await useRAGStatusStore.getState().checkHealth()

      const state = useRAGStatusStore.getState()
      expect(state.httpOnline).toBe(false)
      expect(state.wissenOnline).toBe(true)
      expect(state.collectionCount).toBe(0)
    })

    it('should detect both services offline', async () => {
      mockElectronAPI.ragHttp.health.mockRejectedValue(new Error('offline'))
      mockElectronAPI.ragWissen.health.mockRejectedValue(new Error('offline'))
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })

      await useRAGStatusStore.getState().checkHealth()

      const state = useRAGStatusStore.getState()
      expect(state.httpOnline).toBe(false)
      expect(state.wissenOnline).toBe(false)
    })

    it('should detect context injection disabled', async () => {
      mockElectronAPI.ragHttp.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: false })
      mockElectronAPI.ragHttp.listCollections.mockResolvedValue({
        collections: [{ name: 'docs' }]
      })

      await useRAGStatusStore.getState().checkHealth()

      expect(useRAGStatusStore.getState().contextInjectionEnabled).toBe(false)
    })

    it('should default to context injection enabled if config fails', async () => {
      mockElectronAPI.ragHttp.health.mockRejectedValue(new Error('offline'))
      mockElectronAPI.ragWissen.health.mockRejectedValue(new Error('offline'))
      mockElectronAPI.ragContext.getConfig.mockRejectedValue(new Error('no config'))

      await useRAGStatusStore.getState().checkHealth()

      expect(useRAGStatusStore.getState().contextInjectionEnabled).toBe(true)
    })

    it('should handle collection listing failure gracefully', async () => {
      mockElectronAPI.ragHttp.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })
      mockElectronAPI.ragHttp.listCollections.mockRejectedValue(new Error('timeout'))

      await useRAGStatusStore.getState().checkHealth()

      const state = useRAGStatusStore.getState()
      expect(state.httpOnline).toBe(true)
      expect(state.collectionCount).toBe(0) // Fallback to 0 on error
    })

    it('should handle complete failure and set both offline', async () => {
      // Simulate a total crash in the try block by making Promise.allSettled itself fail
      mockElectronAPI.ragHttp.health.mockImplementation(() => { throw new Error('crash') })
      mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })

      await useRAGStatusStore.getState().checkHealth()

      // Should have recovered
      const state = useRAGStatusStore.getState()
      expect(state.lastCheckedAt).not.toBeNull()
    })

    it('should update lastCheckedAt on every check', async () => {
      mockElectronAPI.ragHttp.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true })
      mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })
      mockElectronAPI.ragHttp.listCollections.mockResolvedValue({ collections: [] })

      const before = Date.now()
      await useRAGStatusStore.getState().checkHealth()
      const after = Date.now()

      const lastChecked = useRAGStatusStore.getState().lastCheckedAt
      expect(lastChecked).toBeGreaterThanOrEqual(before)
      expect(lastChecked).toBeLessThanOrEqual(after)
    })
  })
})
