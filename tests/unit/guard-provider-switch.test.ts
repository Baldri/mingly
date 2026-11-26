/**
 * The dispatch guard may REPLACE the provider the user chose. This pins down
 * that the replacement is reported, and that one shape of it ends the call.
 *
 * Why it ends the call: `guardInput` runs the sensitive-data scan and the
 * upload-permission branch only `if (deps.isCloudProvider(input.provider))` —
 * against the provider the caller ASKED for (request-guard.ts:64). A run on an
 * on-device provider therefore skips that branch entirely. If `guardDispatch`
 * then falls back to a cloud provider, content that was never checked against
 * its recipient is shipped to it, under a UI that says "Running locally — no
 * data leaves your machine" (NewConversationModal.tsx:338).
 *
 * That is the same hole `loop-guard.ts:209-227` closed mid-run ("the run ends
 * instead of switching providers mid-run"). It was open in the preflight.
 *
 * The switch is read from the WARNINGS, never from comparing provider names:
 * guardDispatch pushes a warning only for budget_fallback and routing_fallback
 * (request-guard.ts:106, :117) and both mean the original dispatch was refused.
 * A budget fallback that a routing suggestion sends back to the starting
 * provider has identical names in and out, yet its budget verdict was "not
 * allowed" — comparing names would miss it. Same reasoning as the loop guard's.
 */

import { describe, it, expect } from 'vitest'
import {
  guardDispatch,
  preflightGuard,
  type GuardDeps,
  type PreflightInput
} from '../../src/main/security/request-guard'

/** The ids this test treats as off-device. Everything else runs on the machine. */
const CLOUD = new Set(['anthropic', 'openai'])

const ON_DEVICE = 'ollama'
const CLOUD_PROVIDER = 'anthropic'
const OTHER_CLOUD = 'openai'

function makeDeps(overrides: Partial<GuardDeps> = {}): GuardDeps {
  return {
    sanitize: () => ({ safe: true, riskScore: 0, warnings: [] }),
    scanSensitive: () => ({ hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }),
    checkUploadPermission: async () => ({ decision: 'allowed' }),
    checkBudget: () => ({ allowed: true }),
    checkRouting: () => ({ allowed: true }),
    isCloudProvider: (provider: string) => CLOUD.has(provider),
    scanOutput: () => ({ violations: [] }),
    ...overrides
  }
}

function input(provider: string): PreflightInput {
  return { texts: ['Wie ist das Wetter?'], provider, model: 'test-model', conversationId: 'conv_switch' }
}

describe('guardDispatch reports a provider replacement', () => {
  it('positive control: no fallback, so nothing is reported as switched', () => {
    const result = guardDispatch(input(ON_DEVICE), makeDeps())

    expect(result.ok).toBe(true)
    expect(result.provider).toBe(ON_DEVICE)
    expect(result.warnings).toEqual([])
    expect(result.switched).toBeUndefined()
  })

  it('names both providers and the cause of a budget fallback', () => {
    const result = guardDispatch(
      input(ON_DEVICE),
      makeDeps({ checkBudget: () => ({ allowed: false, fallbackProvider: CLOUD_PROVIDER }) })
    )

    expect(result.switched).toEqual({
      from: ON_DEVICE,
      to: CLOUD_PROVIDER,
      causes: ['budget'],
      leavesDevice: true
    })
  })

  it('names both providers and the cause of a routing fallback', () => {
    const result = guardDispatch(
      input(ON_DEVICE),
      makeDeps({
        checkRouting: () => ({
          allowed: false,
          suggestedProvider: CLOUD_PROVIDER,
          classification: { sensitivity: 'internal', reasons: ['forced for the test'] }
        })
      })
    )

    expect(result.switched).toEqual({
      from: ON_DEVICE,
      to: CLOUD_PROVIDER,
      causes: ['routing'],
      leavesDevice: true
    })
  })

  it('a cloud-to-cloud fallback is reported, but it does not leave the device', () => {
    const result = guardDispatch(
      input(CLOUD_PROVIDER),
      makeDeps({ checkBudget: () => ({ allowed: false, fallbackProvider: OTHER_CLOUD }) })
    )

    expect(result.switched).toMatchObject({
      from: CLOUD_PROVIDER,
      to: OTHER_CLOUD,
      leavesDevice: false
    })
  })

  it('reports a fallback that came back to the starting provider — the names agree, the verdict did not', () => {
    // Budget refuses ollama and offers anthropic; routing then refuses
    // anthropic for this content and sends it back to ollama. In and out are
    // both `ollama`, so a name comparison would see no switch at all.
    const result = guardDispatch(
      input(ON_DEVICE),
      makeDeps({
        checkBudget: () => ({ allowed: false, fallbackProvider: CLOUD_PROVIDER }),
        checkRouting: () => ({ allowed: false, suggestedProvider: ON_DEVICE })
      })
    )

    expect(result.provider).toBe(ON_DEVICE)
    expect(result.switched).toEqual({
      from: ON_DEVICE,
      to: ON_DEVICE,
      causes: ['budget', 'routing'],
      leavesDevice: false
    })
  })
})

describe('preflightGuard ends a run that would leave the device', () => {
  it('blocks a budget fallback from an on-device provider to a cloud one', async () => {
    const result = await preflightGuard(
      input(ON_DEVICE),
      makeDeps({ checkBudget: () => ({ allowed: false, fallbackProvider: CLOUD_PROVIDER }) })
    )

    expect(result.ok).toBe(false)
    expect(result.blockedKind).toBe('budget')
    // The caller must not adopt the cloud provider from a blocked result.
    expect(result.provider).toBe(ON_DEVICE)
    expect(result.reason).toContain(ON_DEVICE)
    expect(result.reason).toContain(CLOUD_PROVIDER)
  })

  it('blocks a routing fallback from an on-device provider to a cloud one', async () => {
    const result = await preflightGuard(
      input(ON_DEVICE),
      makeDeps({
        checkRouting: () => ({
          allowed: false,
          suggestedProvider: CLOUD_PROVIDER,
          classification: { sensitivity: 'internal', reasons: ['forced for the test'] }
        })
      })
    )

    expect(result.ok).toBe(false)
    expect(result.blockedKind).toBe('routing')
    expect(result.switched?.leavesDevice).toBe(true)
  })

  it('says WHY in words a user can act on, naming the unchecked upload', async () => {
    const result = await preflightGuard(
      input(ON_DEVICE),
      makeDeps({ checkRouting: () => ({ allowed: false, suggestedProvider: CLOUD_PROVIDER }) })
    )

    expect(result.reason).toMatch(/on-device|on this machine|leaves/i)
  })

  it('lets a cloud-to-cloud fallback through, and reports it instead of swallowing it', async () => {
    const result = await preflightGuard(
      input(CLOUD_PROVIDER),
      makeDeps({
        checkRouting: () => ({
          allowed: false,
          suggestedProvider: OTHER_CLOUD,
          classification: { sensitivity: 'internal', reasons: ['residency'] }
        })
      })
    )

    expect(result.ok).toBe(true)
    expect(result.provider).toBe(OTHER_CLOUD)
    expect(result.switched).toMatchObject({ from: CLOUD_PROVIDER, to: OTHER_CLOUD, leavesDevice: false })
    expect(result.requestedProvider).toBe(CLOUD_PROVIDER)
  })

  it('keeps the routing warning intact — provider and reasons used to be dropped in the mapping', async () => {
    const result = await preflightGuard(
      input(CLOUD_PROVIDER),
      makeDeps({
        checkRouting: () => ({
          allowed: false,
          suggestedProvider: OTHER_CLOUD,
          classification: { sensitivity: 'internal', reasons: ['residency'] }
        })
      })
    )

    const routing = result.warnings.find((w) => w.type === 'routing_fallback')
    expect(routing).toBeDefined()
    expect(routing?.provider).toBe(OTHER_CLOUD)
    expect(routing?.reasons).toEqual(['residency'])
  })

  it('positive control: an unswitched preflight still reports ok with no switch', async () => {
    const result = await preflightGuard(input(ON_DEVICE), makeDeps())

    expect(result.ok).toBe(true)
    expect(result.provider).toBe(ON_DEVICE)
    expect(result.requestedProvider).toBe(ON_DEVICE)
    expect(result.switched).toBeUndefined()
  })
})
