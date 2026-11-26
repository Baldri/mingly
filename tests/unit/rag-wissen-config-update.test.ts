/**
 * The renderer is not trusted with the connection settings.
 *
 * `ragWissen:update-config` used to spread whatever object the renderer sent
 * into the persisted config. The settings now decide where an API key goes, so
 * the payload is checked field by field at the IPC boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { parseRAGWissenConfigUpdate } from '../../src/main/rag/rag-wissen-config-update'

describe('parseRAGWissenConfigUpdate', () => {
  it('accepts exactly what the settings form sends', () => {
    const input = { host: 'localhost', port: 8000, apiMode: 'rest', enabled: true, apiKey: 'rw_abc' }

    expect(parseRAGWissenConfigUpdate(input)).toEqual(input)
  })

  it('accepts a partial update', () => {
    expect(parseRAGWissenConfigUpdate({ apiKey: '' })).toEqual({ apiKey: '' })
    expect(parseRAGWissenConfigUpdate({ protocol: 'https' })).toEqual({ protocol: 'https' })
  })

  it('drops fields it does not know instead of persisting them', () => {
    const parsed = parseRAGWissenConfigUpdate({ port: 8000, hasApiKey: true, evil: 'x', constructor: 1 })

    expect(parsed).toEqual({ port: 8000 })
    expect(Object.keys(parsed)).toEqual(['port'])
  })

  it.each([
    ['a string port', { port: '8000' }],
    ['port 0', { port: 0 }],
    ['port 70000', { port: 70000 }],
    ['a fractional port', { port: 80.5 }],
    ['a host with a scheme', { host: 'https://evil.example' }],
    ['a host with a path', { host: 'evil.example/x' }],
    ['an empty host', { host: '' }],
    ['an unknown protocol', { protocol: 'ftp' }],
    ['an unknown API mode', { apiMode: 'graphql' }],
    ['a non-string API key', { apiKey: 42 }],
    ['a non-boolean enabled', { enabled: 'yes' }]
  ])('rejects %s', (_label, input) => {
    expect(() => parseRAGWissenConfigUpdate(input)).toThrow(/invalid/i)
  })

  it('rejects a payload that is not an object', () => {
    expect(() => parseRAGWissenConfigUpdate(null)).toThrow(/invalid/i)
    expect(() => parseRAGWissenConfigUpdate('host=evil')).toThrow(/invalid/i)
  })
})

describe('the update-config IPC handler', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const updateConfig = vi.fn()

  beforeEach(async () => {
    handlers.clear()
    updateConfig.mockReset()
    vi.resetModules()

    vi.doMock('../../src/main/ipc/ipc-utils', () => ({
      wrapHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      },
      requireFeature: () => undefined
    }))
    vi.doMock('../../src/main/rag/rag-http-client', () => ({ getRAGHttpClient: () => ({}) }))
    vi.doMock('../../src/main/rag/context-injector', () => ({ getContextInjector: () => ({}) }))
    vi.doMock('../../src/main/rag/rag-wissen-client', () => ({
      getRAGWissenClient: () => ({ updateConfig, getConfig: () => ({}) })
    }))

    const { registerRAGHandlers } = await import('../../src/main/ipc/rag-handlers')
    registerRAGHandlers()
  })

  it('hands only validated fields to the client', async () => {
    const handler = handlers.get('rag-wissen:update-config')

    await handler?.({ host: 'localhost', port: 8000, evil: 'x' })

    expect(updateConfig).toHaveBeenCalledWith({ host: 'localhost', port: 8000 })
  })

  it('refuses an invalid payload without touching the config', () => {
    const handler = handlers.get('rag-wissen:update-config')

    expect(() => handler?.({ host: 'https://evil.example' })).toThrow(/invalid/i)
    expect(updateConfig).not.toHaveBeenCalled()
  })
})
