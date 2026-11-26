/**
 * A conversation on `provider: 'local'` must not be rerouted to a cloud
 * provider — and WHICH guard branch did it.
 *
 * Measured, not derived. A coding run stored as `provider: 'local'` /
 * `model: 'ollama:qwen2.5:14b-instruct-q4_K_M'` failed with "API key not set
 * for provider: anthropic" (26.11.2026). agent-executor.ts:219 replaces the
 * conversation's provider with `preflight.provider`, and guardDispatch has two
 * branches that can switch it:
 *
 *   A  checkBudget  -> budget.fallbackProvider   (warning type budget_fallback)
 *   B  checkRouting -> routing.suggestedProvider (warning type routing_fallback)
 *
 * Measured before the fix: branch B, to `anthropic`, with the reason naming
 * residency. Cause: `local` is an alias for ollama in the client layer
 * (client-manager.ts:76-77) but was absent from the provider registry, so
 * `applyResidencyPolicy` compared it against a candidate list that could never
 * contain it and reached for the first trusted alternative instead.
 *
 * The branch is read by warning TYPE, never by the resulting provider name —
 * two branches agreeing on the destination would otherwise be
 * indistinguishable.
 *
 * Deps are the production wiring (getGuardDeps). Only the two things that
 * cannot run in a unit test are replaced: the audit DB and Electron's
 * userData path. The provider registry is the REAL seeding
 * (seedBuiltInProviders), because the registry's id vocabulary is the thing
 * under test.
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

// BudgetManager's constructor resolves app.getPath('userData'). Pointing it at
// a tmpdir with no budget-config.json means the REAL default config is loaded
// (enabled: false) — the state a fresh install is in.
vi.mock('electron', () => ({
  app: { getPath: () => nodePath.join(tmpdir(), 'mingly-preflight-branch-test-' + process.pid) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { preflightGuard, guardInput, type GuardDeps, type SensitiveScan } from '../../src/main/security/request-guard'
import { getGuardDeps } from '../../src/main/security/request-guard-deps'
import { setProviderRegistry } from '../../src/main/routing/provider-registry'
import { getDataClassifier, DataSensitivity } from '../../src/main/security/data-classifier'

/** What a coding run sends, and nothing that could classify as PII. */
const HARMLESS_TASK = 'Wie ist das Wetter?'
/** Content the residency policy must keep off US soil. */
const CONFIDENTIAL = 'Der Patient hat Diagnose X und braucht eine Therapie.'

/** The provider id the renderer stores for a local Ollama conversation. */
const STORED_PROVIDER = 'local'
const STORED_MODEL = 'ollama:qwen2.5:14b-instruct-q4_K_M'

function warningTypes(result: { warnings: { type: string }[] }): string[] {
  return result.warnings.map((w) => w.type)
}

describe("provider 'local' is an on-device provider to every guard", () => {
  let savedProductId: string | undefined

  beforeEach(() => {
    // Real registry seeding. INFOMANIAK_PRODUCT_ID is cleared so the measured
    // candidate set is the default one (anthropic, openai, google, ollama,
    // local) and does not depend on this machine's environment.
    savedProductId = process.env.INFOMANIAK_PRODUCT_ID
    delete process.env.INFOMANIAK_PRODUCT_ID
    setProviderRegistry(null)
  })

  afterEach(() => {
    if (savedProductId === undefined) delete process.env.INFOMANIAK_PRODUCT_ID
    else process.env.INFOMANIAK_PRODUCT_ID = savedProductId
    setProviderRegistry(null)
  })

  it('control: the task text classifies as PUBLIC, so content sensitivity is not in play', () => {
    const classification = getDataClassifier().classify(HARMLESS_TASK)

    expect(classification.sensitivity).toBe(DataSensitivity.PUBLIC)
  })

  it('preflight leaves a local run local, and says nothing about a fallback', async () => {
    // The whole point: the UI promises "no data leaves your machine" for this
    // provider (NewConversationModal.tsx:338). Before the fix this came back
    // as 'anthropic' with a routing_fallback warning.
    const result = await preflightGuard(
      { texts: [HARMLESS_TASK], provider: STORED_PROVIDER, model: STORED_MODEL, conversationId: 'conv_measure' },
      getGuardDeps(),
    )

    expect(result.ok).toBe(true)
    expect(result.provider).toBe('local')
    expect(warningTypes(result)).toEqual([])
  })

  it('branch B: the routing guard accepts local instead of suggesting a cloud provider', () => {
    const routing = getGuardDeps().checkRouting(HARMLESS_TASK, STORED_PROVIDER, 'conv_measure')

    expect(routing.allowed).toBe(true)
    expect(routing.suggestedProvider).toBeUndefined()
  })

  it('branch A excluded: checkBudget allows local and offers no fallback', () => {
    const budget = getGuardDeps().checkBudget(STORED_PROVIDER)

    expect(budget.allowed).toBe(true)
    expect(budget.fallbackProvider).toBeUndefined()
  })

  it('local may carry confidential content, like the ollama id it aliases', () => {
    expect(getGuardDeps().checkRouting(CONFIDENTIAL, 'local', 'conv_measure').allowed).toBe(true)
    expect(getGuardDeps().checkRouting(CONFIDENTIAL, 'ollama', 'conv_measure').allowed).toBe(true)
  })

  it('a local run is not treated as a cloud upload, so it needs no consent', async () => {
    // isCloudProvider reads the registry: an id that is absent reads as cloud.
    // In the agent path `requiresConsent` is fail-closed, so an unregistered
    // 'local' turned sensitive content in a local run into a dead run.
    const IBAN_TEXT = 'IBAN CH93 0076 2011 6238 5295 7'
    const SCAN_HIT: SensitiveScan = {
      hasSensitiveData: true,
      matches: [{ type: 'iban', value: 'CH93 0076 2011 6238 5295 7', riskLevel: 'high' }],
      overallRiskLevel: 'high'
    }
    const deps: GuardDeps & { checkUploadPermission: ReturnType<typeof vi.fn> } = {
      ...getGuardDeps(),
      scanSensitive: () => SCAN_HIT,
      checkUploadPermission: vi.fn(async () => ({ decision: 'ask', requiresUserConsent: true }))
    }

    const out = await guardInput({ texts: [IBAN_TEXT], provider: 'local', model: STORED_MODEL }, deps)

    expect(out.kind).toBe('ok')
    expect(deps.checkUploadPermission).not.toHaveBeenCalled()
  })
})

describe('the fix did not weaken the residency guard', () => {
  let savedProductId: string | undefined

  beforeEach(() => {
    savedProductId = process.env.INFOMANIAK_PRODUCT_ID
    delete process.env.INFOMANIAK_PRODUCT_ID
    setProviderRegistry(null)
  })

  afterEach(() => {
    if (savedProductId === undefined) delete process.env.INFOMANIAK_PRODUCT_ID
    else process.env.INFOMANIAK_PRODUCT_ID = savedProductId
    setProviderRegistry(null)
  })

  it('a US provider is still refused confidential content and sent on-device', () => {
    // The guard whose candidate list the fix widened. Registering one more
    // on-device id must not make the policy stop refusing US soil.
    const routing = getGuardDeps().checkRouting(CONFIDENTIAL, 'anthropic', 'conv_control')

    expect(routing.allowed).toBe(false)
    expect(['ollama', 'local']).toContain(routing.suggestedProvider)
  })

  it('an id nobody registered is still refused confidential content', () => {
    // The wrong fix for this bug is to let an unknown provider through. An
    // invented name must stay refused, or the alias gap would have been closed
    // by opening a hole for every typo and every made-up endpoint.
    const routing = getGuardDeps().checkRouting(CONFIDENTIAL, 'totally-made-up', 'conv_control')

    expect(routing.allowed).toBe(false)
  })

  it("positive control: 'ollama' passes through preflight unchanged", async () => {
    const result = await preflightGuard(
      { texts: [HARMLESS_TASK], provider: 'ollama', model: STORED_MODEL, conversationId: 'conv_control' },
      getGuardDeps(),
    )

    expect(result.ok).toBe(true)
    expect(result.provider).toBe('ollama')
    expect(result.warnings).toEqual([])
  })

  it('positive control: a budget fallback would still be reported as budget_fallback', async () => {
    // Proves the branch names in this file carry information: everything real
    // except checkBudget, which is made to fall back. If this came back as
    // 'routing_fallback' too, the branch identification above would be empty.
    const deps: GuardDeps = {
      ...getGuardDeps(),
      checkBudget: () => ({ allowed: false, fallbackProvider: 'anthropic', reason: 'forced for the control' }),
    }

    const result = await preflightGuard(
      { texts: [HARMLESS_TASK], provider: STORED_PROVIDER, model: STORED_MODEL, conversationId: 'conv_control' },
      deps,
    )

    expect(warningTypes(result)).toContain('budget_fallback')
  })
})
