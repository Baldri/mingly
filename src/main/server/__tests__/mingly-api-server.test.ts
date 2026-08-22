import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'http'
import { checkApiAuth, applyCorsHeaders } from '../api-auth'
import type { MinglyServerConfig } from '../../../shared/deployment-types'

function makeConfig(overrides: Partial<MinglyServerConfig> = {}): MinglyServerConfig {
  return {
    port: 0, host: '127.0.0.1', requireAuth: true, apiKey: 'secret',
    enableWebSocket: false, maxSessions: 4, corsOrigins: [],
    ...overrides,
  } as MinglyServerConfig
}
const req = (headers: Record<string, string | undefined> = {}): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage)
function fakeRes() {
  const set: Record<string, string> = {}
  const res = { setHeader: (k: string, v: string) => { set[k.toLowerCase()] = v } } as unknown as ServerResponse
  return { res, set }
}

describe('checkApiAuth', () => {
  it('fails CLOSED when auth is required but no apiKey is configured', () => {
    expect(checkApiAuth(makeConfig({ requireAuth: true, apiKey: undefined }), req({ authorization: 'Bearer x' }))).toBe(false)
  })
  it('denies when the Authorization header is missing', () => {
    expect(checkApiAuth(makeConfig(), req())).toBe(false)
  })
  it('denies a wrong token', () => {
    expect(checkApiAuth(makeConfig(), req({ authorization: 'Bearer wrong' }))).toBe(false)
  })
  it('allows the correct Bearer token', () => {
    expect(checkApiAuth(makeConfig(), req({ authorization: 'Bearer secret' }))).toBe(true)
  })
  it('allows everything when auth is explicitly disabled', () => {
    expect(checkApiAuth(makeConfig({ requireAuth: false }), req())).toBe(true)
  })
})

describe('applyCorsHeaders', () => {
  it('never sends a wildcard when no origins are configured', () => {
    const { res, set } = fakeRes()
    applyCorsHeaders(makeConfig({ corsOrigins: [] }), req({ origin: 'https://evil.example' }), res)
    expect(set['access-control-allow-origin']).toBeUndefined()
  })
  it('reflects a configured, matching origin', () => {
    const { res, set } = fakeRes()
    applyCorsHeaders(makeConfig({ corsOrigins: ['https://app.local'] }), req({ origin: 'https://app.local' }), res)
    expect(set['access-control-allow-origin']).toBe('https://app.local')
  })
  it('does not reflect an unlisted origin', () => {
    const { res, set } = fakeRes()
    applyCorsHeaders(makeConfig({ corsOrigins: ['https://app.local'] }), req({ origin: 'https://evil.example' }), res)
    expect(set['access-control-allow-origin']).toBeUndefined()
  })
})
