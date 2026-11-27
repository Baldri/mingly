/**
 * A LAN server the user selected must not be rerouted to a cloud provider —
 * and it must not gain trust nobody can prove.
 *
 * Measured before the change (27.11.2026), with `ollama` as a positive control
 * in the same run: `applyResidencyPolicy` compares the chosen provider id
 * against `registry.all()`, and `LocalAIBridge.registerServer()` never entered
 * the provider into the registry (`registerTenant` exists in
 * provider-registry.ts and is called nowhere in src/). So a `network:*` id was
 * absent from `decision.allowed` at EVERY protection level — the `!rule`
 * branch of `evaluate()` lists registry ids too — and the guard reached for
 * the first trusted alternative:
 *
 *   network:192.168.1.50:11434 | public       | allowed=false | suggested=anthropic
 *   network:192.168.1.50:11434 | internal     | allowed=false | suggested=anthropic
 *   network:192.168.1.50:11434 | confidential | allowed=false | suggested=ollama
 *   ollama (control)           | all three    | allowed=true  | suggested=-
 *
 * `ipc-handlers.ts:196` assigns `provider = dispatch.provider`, and the
 * provider check on line 309 then sees `anthropic` and passes it. Choosing a
 * machine in one's own network therefore sent harmless content to US soil.
 * `dispatch.switched?.leavesDevice` does not catch it: an unregistered id
 * already reads as cloud, so cloud -> cloud is not a departure from the device.
 *
 * Same class as the `local` alias gap (see
 * preflight-local-provider-reroute.test.ts), one id space over.
 *
 * Deps are the production wiring (getGuardDeps) and the registry seeding is
 * the REAL one — the registry's id vocabulary is the thing under test. The
 * entry under test is put there by the REAL bridge, never by this file: a
 * hand-registered entry would measure the fixture, not the product.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import nodePath from 'path'

// The routing decision is audited; the audit writer talks to SQLite.
vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn()
}))

// SimpleStore and BudgetManager resolve app.getPath('userData').
vi.mock('electron', () => ({
  app: { getPath: () => nodePath.join(tmpdir(), 'mingly-network-origin-test-' + process.pid) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { LocalAIBridge } from '../../src/main/network/local-ai-bridge'
import { preflightGuard } from '../../src/main/security/request-guard'
import { getGuardDeps } from '../../src/main/security/request-guard-deps'
import { getProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'
import { trustForProvider } from '../../src/main/security/provider-trust'
import { getDataClassifier, DataSensitivity } from '../../src/main/security/data-classifier'
import { getOllamaLoadBalancer } from '../../src/main/network/ollama-load-balancer'
import type { NetworkAIServerConfig } from '../../src/shared/network-ai-types'

/** Nothing in here can classify as PII. */
const HARMLESS = 'Wie ist das Wetter?'
/** Content the residency policy must keep off foreign soil. */
const CONFIDENTIAL = 'Der Patient hat Diagnose X und braucht eine Therapie.'

/**
 * A server on the user's own network.
 *
 * `isLocal: true` is deliberately wrong and deliberately present: the flag
 * comes back from `network-ai-servers.json` unvalidated, so the origin must
 * not be derived from it. This is the I2 case one id space over — the
 * configuration may name an endpoint, never its residency.
 */
const LAN_SERVER: NetworkAIServerConfig = {
  id: '192.168.1.50:11434',
  name: 'Keller-GPU',
  type: 'ollama',
  protocol: 'http',
  host: '192.168.1.50',
  port: 11434,
  apiKeyRequired: false,
  isLocal: true,
  isLAN: true,
  tlsVerify: false,
  allowSelfSigned: true,
  createdAt: 0,
  status: 'online'
}
const LAN_ID = 'network:192.168.1.50:11434'

/** A second Ollama on this very machine, added as a network server. */
const LOOPBACK_SERVER: NetworkAIServerConfig = {
  id: 'localhost:11435',
  name: 'Zweite Instanz',
  type: 'ollama',
  protocol: 'http',
  host: 'localhost',
  port: 11435,
  apiKeyRequired: false,
  isLocal: true,
  isLAN: false,
  tlsVerify: false,
  allowSelfSigned: true,
  createdAt: 0,
  status: 'online'
}
const LOOPBACK_ID = 'network:localhost:11435'

describe('a network AI server is a provider with a declared origin', () => {
  let savedProductId: string | undefined

  beforeEach(() => {
    // Real seeding, but with the candidate set pinned to the default five so
    // the measurement does not depend on this machine's environment.
    savedProductId = process.env.INFOMANIAK_PRODUCT_ID
    delete process.env.INFOMANIAK_PRODUCT_ID
    setProviderRegistry(null)
    // registerServer() fetches the model list. No test may reach a network.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('no network in this test')
    }))
  })

  afterEach(() => {
    if (savedProductId === undefined) delete process.env.INFOMANIAK_PRODUCT_ID
    else process.env.INFOMANIAK_PRODUCT_ID = savedProductId
    setProviderRegistry(null)
    getOllamaLoadBalancer().shutdown()
    vi.unstubAllGlobals()
  })

  it('control: the text classifies as PUBLIC, so content sensitivity is not in play', () => {
    expect(getDataClassifier().classify(HARMLESS).sensitivity).toBe(DataSensitivity.PUBLIC)
  })

  it('control: the id is absent until the bridge registers it', () => {
    // Without this, the next tests could be measuring a fixture of their own.
    expect(getProviderRegistry().get(LAN_ID)).toBeUndefined()
  })

  it('the selected LAN server is not rerouted to a cloud provider', async () => {
    await new LocalAIBridge().registerServer(LAN_SERVER)

    const routing = getGuardDeps().checkRouting(HARMLESS, LAN_ID, 'conv_measure')

    expect(routing.allowed).toBe(true)
    expect(routing.suggestedProvider).toBeUndefined()
  })

  it('preflight hands the chat path back the provider the user chose', async () => {
    // The surface that decides where the content goes: ipc-handlers.ts:196
    // assigns this value to `provider`. Before the change it was 'anthropic'.
    await new LocalAIBridge().registerServer(LAN_SERVER)

    const result = await preflightGuard(
      { texts: [HARMLESS], provider: LAN_ID, model: 'llama3', conversationId: 'conv_measure' },
      getGuardDeps()
    )

    expect(result.ok).toBe(true)
    expect(result.provider).toBe(LAN_ID)
  })

  it('the origin is forced: an isLocal flag in the config buys no residency', async () => {
    await new LocalAIBridge().registerServer(LAN_SERVER)

    const origin = getProviderRegistry().get(LAN_ID)?.origin

    // residency and dpaStatus are the two fields a guard reads (measured:
    // policy-engine.ts:69, provider-trust.ts:44-50, request-guard-deps.ts:82).
    expect(origin?.residency).toBe('unknown')
    expect(origin?.dpaStatus).toBe('none')
    // The other three are audit-trail only, and say what we do know: the user
    // typed this address, so they host it; what it serves we cannot tell.
    expect(origin?.hostingMode).toBe('self-hosted')
    expect(origin?.weightsLicense).toBe('closed')
  })

  it('the entry is frozen, so no later caller can talk it into a residency', async () => {
    await new LocalAIBridge().registerServer(LAN_SERVER)

    const entry = getProviderRegistry().get(LAN_ID)!

    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.origin)).toBe(true)
  })

  it('a loopback network server gets the same unknown origin — the deliberate limit', async () => {
    // A second Ollama on this machine is verifiably on-device (its URL is
    // loopback), but it is registered as unknown anyway. Pinned here so
    // widening it later is a decision and not an accident.
    await new LocalAIBridge().registerServer(LOOPBACK_SERVER)

    expect(getProviderRegistry().get(LOOPBACK_ID)?.origin.residency).toBe('unknown')
    expect(getGuardDeps().checkRouting(CONFIDENTIAL, LOOPBACK_ID, 'conv_measure').allowed).toBe(false)
  })

  it('withdrawing the server withdraws the provider', async () => {
    const bridge = new LocalAIBridge()
    await bridge.registerServer(LAN_SERVER)
    expect(getProviderRegistry().get(LAN_ID)).toBeDefined()

    bridge.unregisterServer(LAN_SERVER.id)

    // Leaving the entry would keep the policy routing to an endpoint nobody
    // stands behind any more — the reason ProviderRegistry.remove() exists.
    expect(getProviderRegistry().get(LAN_ID)).toBeUndefined()
  })

  it('registering twice leaves one entry, not two', async () => {
    // refreshAll() re-registers every 60 seconds.
    const bridge = new LocalAIBridge()
    await bridge.registerServer(LAN_SERVER)
    await bridge.registerServer(LAN_SERVER)

    expect(getProviderRegistry().all().filter((e) => e.config.id === LAN_ID)).toHaveLength(1)
  })
})

describe('the registered LAN server gains nothing it cannot prove', () => {
  let savedProductId: string | undefined

  beforeEach(() => {
    savedProductId = process.env.INFOMANIAK_PRODUCT_ID
    delete process.env.INFOMANIAK_PRODUCT_ID
    setProviderRegistry(null)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('no network in this test')
    }))
  })

  afterEach(() => {
    if (savedProductId === undefined) delete process.env.INFOMANIAK_PRODUCT_ID
    else process.env.INFOMANIAK_PRODUCT_ID = savedProductId
    setProviderRegistry(null)
    getOllamaLoadBalancer().shutdown()
    vi.unstubAllGlobals()
  })

  it('confidential content is still refused: we cannot verify who runs that machine', async () => {
    await new LocalAIBridge().registerServer(LAN_SERVER)

    const routing = getGuardDeps().checkRouting(CONFIDENTIAL, LAN_ID, 'conv_control')

    expect(routing.allowed).toBe(false)
    expect(['ollama', 'local']).toContain(routing.suggestedProvider)
  })

  it('it still counts as cloud, so the sensitive-scan and consent branch runs', async () => {
    // residencyIsCloud('unknown') is true. Content leaves the device, so the
    // branch request-guard.ts:78 skips for on-device providers must run here.
    await new LocalAIBridge().registerServer(LAN_SERVER)

    expect(getGuardDeps().isCloudProvider(LAN_ID)).toBe(true)
  })

  it('trust stays at PUBLIC, the lowest level', async () => {
    await new LocalAIBridge().registerServer(LAN_SERVER)

    expect(trustForProvider(LAN_ID)).toBe(DataSensitivity.PUBLIC)
  })

  it('the LAN host still does not enter the on-device pool', async () => {
    // PR #54 narrowed that pool to loopback. Registering the server as its own
    // provider must not put it back in through the side door.
    await new LocalAIBridge().registerServer(LAN_SERVER)

    expect(getOllamaLoadBalancer().getBackends()).toHaveLength(0)
  })

  it('positive control: ollama may still carry confidential content', () => {
    expect(getGuardDeps().checkRouting(CONFIDENTIAL, 'ollama', 'conv_control').allowed).toBe(true)
  })

  it('positive control: an id nobody registered is still refused, even for harmless text', () => {
    // The wrong fix is to let unknown ids through. An invented endpoint must
    // stay refused, or this bug would have been closed by opening a hole for
    // every typo.
    expect(getGuardDeps().checkRouting(HARMLESS, 'network:totally-made-up', 'conv_control').allowed).toBe(false)
  })
})
