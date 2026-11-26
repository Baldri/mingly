/**
 * The `on-device` label must describe where the request actually goes.
 *
 * `ollama` and `local` are registered with `residency: 'on-device'`
 * (provider-registry.ts). Two guards read that label and act on it:
 *
 *   - DEFAULT_POLICY's rule `sensitive-stays-ch` permits exactly
 *     `['CH', 'on-device']` from protection level `high` upwards, so
 *     on-device is where confidential content is routed TO;
 *   - `residencyIsCloud('on-device')` is false, so preflightGuard skips the
 *     whole sensitive-scan + upload-permission branch (request-guard.ts:78).
 *
 * The OllamaClient behind both ids does not necessarily talk to this device.
 * `getEffectiveBaseURL()` asks the shared load balancer FIRST and only falls
 * back to `localhost:11434`, and `LocalAIBridge.registerServer()` pushes every
 * configured Ollama server into that same balancer — including one on another
 * machine. The balancer's own `validateBackendUrl()` checks syntax, not
 * locality.
 *
 * Measured (26.11.2026) before the fix, with two LAN backends in the pool:
 * the built-in client dialled `http://192.168.1.50:11434/api/tags`. The label
 * said the content stays on the device; the socket said otherwise.
 *
 * Scope of the reachable state, also measured: `discoverServers()` scans
 * localhost only (network-ai-manager.ts:168-172, the network sweep is a
 * comment), and `getServers()` is a user-maintained store
 * (`network-ai-servers.json`, absent on a default install). So nothing finds a
 * LAN host by itself — a user adds it through the Network-AI settings, which
 * is a supported path, and `isBalancingAvailable()` needs two healthy
 * backends before the pool overrides the built-in client at all.
 *
 * The assertions below read the URL the client actually dials, never the
 * configured one: a label is tested against the socket, not against the
 * config it was derived from.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OllamaClient } from '../../src/main/llm-clients/ollama-client'
import { getOllamaLoadBalancer } from '../../src/main/network/ollama-load-balancer'
import { LLMClientManager } from '../../src/main/llm-clients/client-manager'
import { ProviderRegistry, seedBuiltInProviders } from '../../src/main/routing/provider-registry'
import { residencyIsCloud } from '../../src/shared/provider-types'
import { isLoopbackHostname, isLoopbackUrl } from '../../src/shared/network-ai-types'
import type { NetworkAIServerConfig } from '../../src/shared/network-ai-types'

// ── Helpers ────────────────────────────────────────────────────

function makeServer(overrides: Partial<NetworkAIServerConfig> = {}): NetworkAIServerConfig {
  return {
    id: `server-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Ollama',
    type: 'ollama',
    protocol: 'http',
    host: 'localhost',
    port: 11434,
    apiKeyRequired: false,
    isLocal: true,
    isLAN: false,
    tlsVerify: false,
    allowSelfSigned: false,
    createdAt: Date.now(),
    ...overrides
  }
}

/**
 * Replace global fetch and record every URL. The recorded URL is the
 * measurement — `getEffectiveBaseURL` is private, and reading it through a
 * cast would measure the method instead of the dispatch.
 */
function captureDialledUrls(): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      return {
        ok: true,
        json: async () => ({ models: [] })
      } as unknown as Response
    })
  )
  return urls
}

function hostnameOf(url: string): string {
  return new URL(url).hostname
}

/** Two LAN machines — the configuration LocalAIBridge exists to support. */
const LAN_HOSTS = ['192.168.1.50', '192.168.1.51']

describe('the on-device pool only ever contains this device', () => {
  beforeEach(() => {
    getOllamaLoadBalancer().shutdown()
  })

  afterEach(() => {
    getOllamaLoadBalancer().shutdown()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('two guards act on the on-device label, so the label has to be true', () => {
    const registry = new ProviderRegistry()
    seedBuiltInProviders(registry)

    for (const id of ['ollama', 'local']) {
      const entry = registry.get(id)
      expect(entry, `${id} must be registered`).toBeDefined()
      expect(entry!.origin.residency).toBe('on-device')
      // false means preflightGuard skips the sensitive-data branch entirely
      expect(residencyIsCloud(entry!.origin.residency)).toBe(false)
    }
  })

  it('the built-in client does not dial a LAN host that sits in the pool', async () => {
    const balancer = getOllamaLoadBalancer()
    for (const host of LAN_HOSTS) balancer.addBackend(makeServer({ host, isLocal: false, isLAN: true }))

    const urls = captureDialledUrls()
    // The built-in client — no setBaseURL call, so it is the one the registry
    // labels `ollama` / `local`.
    await new OllamaClient().getInstalledModels()

    expect(urls).toHaveLength(1)
    expect(LAN_HOSTS).not.toContain(hostnameOf(urls[0]))
  })

  it('a LAN backend never enters the pool the built-in client consults', () => {
    const balancer = getOllamaLoadBalancer()
    balancer.addBackend(makeServer({ host: '192.168.1.50', isLocal: false, isLAN: true }))

    expect(balancer.getBackends()).toHaveLength(0)
    expect(balancer.getNextUrl()).toBeNull()
  })

  it('a LAN server selected by its own provider id reaches that machine', async () => {
    // A LAN Ollama is a legitimate deployment. It stays usable — but through
    // its own `network:*` id, which no guard reads as on-device, not by
    // hijacking the built-in client's destination.
    const manager = new LLMClientManager()
    manager.registerCustomProvider({
      id: 'network:192.168.1.50:11434',
      name: 'Ollama (LAN)',
      type: 'ollama',
      apiBase: 'http://192.168.1.50:11434',
      apiKeyRequired: false,
      supportsStreaming: true,
      models: []
    })

    const client = manager.getClient('network:192.168.1.50:11434')
    expect(client).toBeDefined()

    const urls = captureDialledUrls()
    await (client as OllamaClient).getInstalledModels()

    expect(urls).toHaveLength(1)
    expect(hostnameOf(urls[0])).toBe('192.168.1.50')
  })

  it('a pinned LAN client is not pulled back into the on-device pool', async () => {
    // Two loopback backends make balancing available. The pinned client must
    // still reach its own machine — otherwise selecting a LAN server would
    // silently answer from this one.
    const balancer = getOllamaLoadBalancer()
    balancer.addBackend(makeServer({ id: 'local-a', host: '127.0.0.1', port: 11434 }))
    balancer.addBackend(makeServer({ id: 'local-b', host: '127.0.0.1', port: 11435 }))
    expect(balancer.isBalancingAvailable()).toBe(true)

    const pinned = new OllamaClient()
    pinned.setBaseURL('http://192.168.1.50:11434')

    const urls = captureDialledUrls()
    await pinned.getInstalledModels()

    expect(urls).toHaveLength(1)
    expect(hostnameOf(urls[0])).toBe('192.168.1.50')
  })

  it('an off-device URL reaching the built-in client by another route fails closed', async () => {
    // addBackend is one route into the pool; it is not the only one. The pool
    // stores the server config BY REFERENCE and NetworkAIManager mutates those
    // objects in place (network-ai-manager.ts:204-205), so a host changed
    // after validation never passes addBackend's check again. This is the case
    // the dispatch-time assertion exists for.
    const balancer = getOllamaLoadBalancer()
    balancer.addBackend(makeServer({ id: 'local-a', host: '127.0.0.1', port: 11434 }))
    balancer.addBackend(makeServer({ id: 'local-b', host: '127.0.0.1', port: 11435 }))

    for (const backend of balancer.getBackends()) backend.server.host = '192.168.1.50'

    const urls = captureDialledUrls()
    // Measured on the path that TRANSMITS content. The probe paths
    // (validateApiKey, getInstalledModels, healthCheck) catch everything and
    // degrade to "not available" by design, so they would hide the refusal —
    // they still dial nothing, which is asserted below.
    await expect(
      new OllamaClient().sendMessageNonStreaming([{ role: 'user', content: 'x' } as never], 'llama3')
    ).rejects.toThrow(/not this machine/)

    // Refused, not redirected: nothing was dialled at all, on either path.
    await new OllamaClient().getInstalledModels()
    expect(urls).toHaveLength(0)
  })
})

describe('isLoopbackHostname / isLoopbackUrl', () => {
  // URL parsing normalises the numeric IPv4 encodings, so the predicate is
  // fed hostnames and never has to recognise a spelling. Measured, because
  // "2130706433 becomes 127.0.0.1" is a claim about the runtime, not the code.
  it.each([
    'http://localhost:11434',
    'http://127.0.0.1:11434',
    'http://127.0.0.2:11434',
    'http://127.1.2.3:11434',
    'http://[::1]:11434',
    'http://2130706433:11434',
    'http://0x7f.1:11434',
    'http://127.1:11434'
  ])('%s is this machine', (url) => {
    expect(isLoopbackUrl(url)).toBe(true)
  })

  it.each([
    // the near-misses a substring check would wave through
    'http://127.0.0.1.evil.example:11434',
    'http://localhost.evil.example:11434',
    'http://notlocalhost:11434',
    'http://my-localhost:11434',
    // deliberately refused although they do resolve to loopback
    'http://foo.localhost:11434',
    'http://[::ffff:127.0.0.1]:11434',
    // 0.0.0.0 means "every interface", which is not the same statement
    'http://0.0.0.0:11434',
    // ordinary LAN and public hosts
    'http://192.168.1.50:11434',
    'http://10.0.0.5:11434',
    'https://api.example.com',
    // not a URL at all
    'localhost:11434',
    ''
  ])('%s is not this machine', (url) => {
    expect(isLoopbackUrl(url)).toBe(false)
  })

  it('rejects an octet above 255 rather than reading only the first one', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.0.0.999')).toBe(false)
  })
})
