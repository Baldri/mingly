/**
 * Privacy Store Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electronAPI
const mockElectronAPI = {
  privacy: {
    setMode: vi.fn().mockResolvedValue({ success: true }),
    getMode: vi.fn().mockResolvedValue({ mode: 'shield' }),
    detectPII: vi.fn().mockResolvedValue({
      entities: [
        { category: 'EMAIL', sensitivity: 'high', original: 'test@test.ch', start: 0, end: 12 }
      ]
    }),
    clearSession: vi.fn().mockResolvedValue({ success: true })
  }
}

vi.stubGlobal('window', { electronAPI: mockElectronAPI })

const { usePrivacyStore } = await import('../../src/renderer/stores/privacy-store')

describe('PrivacyStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePrivacyStore.setState({
      mode: 'shield',
      sessionId: null,
      preview: null,
      enabled: true,
      sessionAnonymizedCount: 0,
      loading: false
    })
  })

  describe('initial state', () => {
    it('should default to shield mode', () => {
      expect(usePrivacyStore.getState().mode).toBe('shield')
    })

    it('should be enabled by default', () => {
      expect(usePrivacyStore.getState().enabled).toBe(true)
    })
  })

  describe('setMode', () => {
    it('should update mode via IPC', async () => {
      await usePrivacyStore.getState().setMode('session-1', 'vault')
      expect(mockElectronAPI.privacy.setMode).toHaveBeenCalledWith('session-1', 'vault')
      expect(usePrivacyStore.getState().mode).toBe('vault')
      expect(usePrivacyStore.getState().sessionId).toBe('session-1')
    })

    it('should handle IPC failure', async () => {
      mockElectronAPI.privacy.setMode.mockRejectedValueOnce(new Error('fail'))
      await usePrivacyStore.getState().setMode('session-1', 'vault')
      expect(usePrivacyStore.getState().loading).toBe(false)
    })
  })

  describe('loadMode', () => {
    it('should load mode from IPC', async () => {
      mockElectronAPI.privacy.getMode.mockResolvedValueOnce({ mode: 'vault' })
      await usePrivacyStore.getState().loadMode('session-1')
      expect(usePrivacyStore.getState().mode).toBe('vault')
      expect(usePrivacyStore.getState().sessionId).toBe('session-1')
    })

    it('should default to shield on error', async () => {
      mockElectronAPI.privacy.getMode.mockRejectedValueOnce(new Error('fail'))
      await usePrivacyStore.getState().loadMode('session-1')
      expect(usePrivacyStore.getState().mode).toBe('shield')
    })
  })

  describe('detectPreview', () => {
    it('should detect PII and update preview', async () => {
      await usePrivacyStore.getState().detectPreview('test@test.ch')
      expect(usePrivacyStore.getState().preview).toEqual({
        entityCount: 1,
        categories: ['EMAIL'],
        hasCritical: false
      })
    })

    it('should clear preview for empty text', async () => {
      usePrivacyStore.setState({ preview: { entityCount: 1, categories: ['EMAIL'], hasCritical: false } })
      await usePrivacyStore.getState().detectPreview('')
      expect(usePrivacyStore.getState().preview).toBeNull()
    })

    it('should not detect when disabled', async () => {
      usePrivacyStore.setState({ enabled: false })
      await usePrivacyStore.getState().detectPreview('test@test.ch')
      expect(usePrivacyStore.getState().preview).toBeNull()
    })

    it('should detect critical PII', async () => {
      mockElectronAPI.privacy.detectPII.mockResolvedValueOnce({
        entities: [
          { category: 'AHV', sensitivity: 'critical', original: '756.1234.5678.97', start: 0, end: 16 }
        ]
      })
      await usePrivacyStore.getState().detectPreview('AHV: 756.1234.5678.97')
      expect(usePrivacyStore.getState().preview?.hasCritical).toBe(true)
    })
  })

  describe('clearSession', () => {
    it('should clear session state', async () => {
      usePrivacyStore.setState({ sessionAnonymizedCount: 5, preview: { entityCount: 1, categories: [], hasCritical: false } })
      await usePrivacyStore.getState().clearSession('session-1')
      expect(mockElectronAPI.privacy.clearSession).toHaveBeenCalledWith('session-1')
      expect(usePrivacyStore.getState().sessionAnonymizedCount).toBe(0)
      expect(usePrivacyStore.getState().preview).toBeNull()
    })
  })

  describe('setEnabled', () => {
    it('should toggle enabled state', () => {
      usePrivacyStore.getState().setEnabled(false)
      expect(usePrivacyStore.getState().enabled).toBe(false)
    })
  })

  describe('incrementAnonymized', () => {
    it('should increment counter', () => {
      usePrivacyStore.getState().incrementAnonymized(3)
      expect(usePrivacyStore.getState().sessionAnonymizedCount).toBe(3)
      usePrivacyStore.getState().incrementAnonymized(2)
      expect(usePrivacyStore.getState().sessionAnonymizedCount).toBe(5)
    })
  })
})
