/**
 * What the UI says about the external knowledge server.
 *
 * /health is public but /search needs an API key, so "the health check
 * succeeded" and "searches will return hits" are different statements. The
 * status line, the status bar and the setup wizard must not claim the second
 * one on the strength of the first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { describeWissenStatus, isWissenUsable, sendsKeyInCleartext } from '../../src/shared/rag-wissen-status'

describe('sendsKeyInCleartext', () => {
  it('is false for a server on this computer, where http never leaves the machine', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
      expect(sendsKeyInCleartext({ protocol: 'http', host })).toBe(false)
    }
  })

  it('is true for http to any other host, because the key would cross the network unencrypted', () => {
    for (const host of ['192.168.1.10', 'nas.local', 'rag.example.ch', '127.0.0.1.example.ch']) {
      expect(sendsKeyInCleartext({ protocol: 'http', host })).toBe(true)
    }
  })

  it('is false over https, wherever the server is', () => {
    expect(sendsKeyInCleartext({ protocol: 'https', host: 'rag.example.ch' })).toBe(false)
  })
})

describe('isWissenUsable', () => {
  it('is true for a reachable server whose credentials work', () => {
    expect(isWissenUsable({ success: true, auth: 'ok' })).toBe(true)
  })

  it('is true when nothing is known about authentication (JSON-RPC mode, older answers)', () => {
    expect(isWissenUsable({ success: true, auth: 'unknown' })).toBe(true)
    expect(isWissenUsable({ success: true })).toBe(true)
  })

  it('is false when the server wants a key we do not have', () => {
    expect(isWissenUsable({ success: true, auth: 'required' })).toBe(false)
  })

  it('is false when the server refused the key we have', () => {
    expect(isWissenUsable({ success: true, auth: 'rejected' })).toBe(false)
  })

  it('is false when a stored key is withheld because the connection is not encrypted', () => {
    expect(isWissenUsable({ success: true, auth: 'withheld' })).toBe(false)
  })

  it('is false for an unreachable server and for no answer at all', () => {
    expect(isWissenUsable({ success: false, error: 'fetch failed' })).toBe(false)
    expect(isWissenUsable(null)).toBe(false)
    expect(isWissenUsable(undefined)).toBe(false)
  })
})

describe('describeWissenStatus', () => {
  it('shows a neutral dot while the first check is pending', () => {
    expect(describeWissenStatus(null)).toEqual({ usable: null, label: 'Checking…' })
  })

  it('says Connected only when searches can work', () => {
    expect(describeWissenStatus({ success: true, auth: 'ok' })).toEqual({ usable: true, label: 'Connected' })
  })

  it('says why a reachable server is not usable instead of just Connected', () => {
    expect(describeWissenStatus({ success: true, auth: 'required' })).toEqual({
      usable: false,
      label: 'Reachable, but an API key is required'
    })
    expect(describeWissenStatus({ success: true, auth: 'rejected' })).toEqual({
      usable: false,
      label: 'Reachable, but the API key was rejected'
    })
  })

  it('tells the user to switch to https when the key is withheld', () => {
    expect(describeWissenStatus({ success: true, auth: 'withheld' })).toEqual({
      usable: false,
      label: 'Reachable, but the API key was not sent: the connection is not encrypted (use https)'
    })
  })

  it('carries the reason when the check failed, e.g. a plan restriction', () => {
    const status = describeWissenStatus({
      success: false,
      error: "Feature 'shared_rag' requires team plan. Please upgrade."
    })

    expect(status.usable).toBe(false)
    expect(status.label).toBe("Offline (Feature 'shared_rag' requires team plan. Please upgrade.)")
  })

  it('says plain Offline when there is no reason to give', () => {
    expect(describeWissenStatus({ success: false })).toEqual({ usable: false, label: 'Offline' })
  })
})

describe('RAGStatusStore with an API-key-protected server', () => {
  const mockElectronAPI = {
    ragHttp: { health: vi.fn(), listCollections: vi.fn() },
    ragWissen: { health: vi.fn() },
    ragContext: { getConfig: vi.fn() }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockElectronAPI.ragHttp.health.mockResolvedValue({ success: false })
    mockElectronAPI.ragContext.getConfig.mockResolvedValue({ enabled: true })
  })

  async function loadStore() {
    vi.resetModules()
    vi.stubGlobal('window', { electronAPI: mockElectronAPI })
    const { useRAGStatusStore } = await import('../../src/renderer/stores/rag-status-store')
    return useRAGStatusStore
  }

  it('does not count a server that will answer every search with 401 as online', async () => {
    mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true, auth: 'required' })
    const store = await loadStore()

    await store.getState().checkHealth()

    expect(store.getState().wissenOnline).toBe(false)
  })

  it('counts a server whose key works as online', async () => {
    mockElectronAPI.ragWissen.health.mockResolvedValue({ success: true, auth: 'ok' })
    const store = await loadStore()

    await store.getState().checkHealth()

    expect(store.getState().wissenOnline).toBe(true)
  })
})
