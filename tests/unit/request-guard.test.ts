import { describe, it, expect } from 'vitest'
import { preflightGuard, postflightGuard, type GuardDeps } from '../../src/main/security/request-guard'

// Fakes for the guard components — the whole point of extracting request-guard
// is that it is testable without the Electron/model module graph.
function deps(overrides: Partial<GuardDeps> = {}): GuardDeps {
  return {
    sanitize: () => ({ safe: true, riskScore: 0, warnings: [] }),
    scanSensitive: () => ({ hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }),
    checkUploadPermission: async () => ({ decision: 'allowed', requiresUserConsent: false }),
    checkBudget: () => ({ allowed: true }),
    checkRouting: () => ({ allowed: true }),
    isCloudProvider: (p) => p === 'anthropic' || p === 'openai' || p === 'google',
    scanOutput: () => ({ violations: [] }),
    ...overrides,
  }
}
const input = (over: Partial<{ texts: string[]; provider: string; model: string }> = {}) => ({
  texts: ['hello'], provider: 'anthropic', model: 'm', ...over,
})

describe('preflightGuard', () => {
  it('blocks high-risk prompt injection (score >= 80)', async () => {
    const r = await preflightGuard(input(), deps({ sanitize: () => ({ safe: false, riskScore: 90, warnings: [{ type: 'inj', severity: 'high' }] }) }))
    expect(r.ok).toBe(false)
    expect(r.blockedKind).toBe('injection')
  })
  it('blocks sensitive data to a cloud provider when upload is denied', async () => {
    const r = await preflightGuard(input({ provider: 'anthropic' }), deps({
      scanSensitive: () => ({ hasSensitiveData: true, matches: [{ type: 'iban', value: 'x', riskLevel: 'high' }], overallRiskLevel: 'high' }),
      checkUploadPermission: async () => ({ decision: 'denied', reason: 'PII' }),
    }))
    expect(r.ok).toBe(false)
    expect(r.blockedKind).toBe('sensitive')
  })
  it('requires consent (fail-closed here) when sensitive data needs user consent', async () => {
    const r = await preflightGuard(input({ provider: 'anthropic' }), deps({
      scanSensitive: () => ({ hasSensitiveData: true, matches: [], overallRiskLevel: 'medium' }),
      checkUploadPermission: async () => ({ decision: 'allowed', requiresUserConsent: true }),
    }))
    expect(r.ok).toBe(false)
    expect(r.requiresConsent).toBe(true)
  })
  it('does NOT scan for cloud upload on a local provider', async () => {
    let scanned = false
    const r = await preflightGuard(input({ provider: 'local' }), deps({
      scanSensitive: () => { scanned = true; return { hasSensitiveData: true, matches: [], overallRiskLevel: 'high' } },
    }))
    expect(r.ok).toBe(true)
    expect(scanned).toBe(false)
  })
  it('switches provider on a budget fallback instead of blocking', async () => {
    const r = await preflightGuard(input({ provider: 'anthropic' }), deps({ checkBudget: () => ({ allowed: false, fallbackProvider: 'local' }) }))
    expect(r.ok).toBe(true)
    expect(r.provider).toBe('local')
  })
  it('blocks when budget is exceeded and no fallback exists', async () => {
    const r = await preflightGuard(input(), deps({ checkBudget: () => ({ allowed: false, reason: 'over budget' }) }))
    expect(r.ok).toBe(false)
    expect(r.blockedKind).toBe('budget')
  })
  it('routes to a safer provider when the classifier suggests one', async () => {
    const r = await preflightGuard(input({ provider: 'anthropic' }), deps({ checkRouting: () => ({ allowed: false, suggestedProvider: 'local' }) }))
    expect(r.ok).toBe(true)
    expect(r.provider).toBe('local')
  })
  it('passes a clean request', async () => {
    const r = await preflightGuard(input(), deps())
    expect(r.ok).toBe(true)
  })
})

describe('postflightGuard', () => {
  it('flags a critical output-guardrail violation', () => {
    const r = postflightGuard('leaked', 'sys', deps({ scanOutput: () => ({ violations: [{ type: 'secret', severity: 'critical', description: 'leak' }] }) }))
    expect(r.ok).toBe(false)
  })
  it('passes clean output', () => {
    expect(postflightGuard('fine', 'sys', deps()).ok).toBe(true)
  })
})

// ── Two-phase guards the chat IPC path now reuses (single source) ──────
import { guardInput, guardDispatch } from '../../src/main/security/request-guard'

describe('guardInput (chat phase 1)', () => {
  it('reports injection with score and warnings', async () => {
    const r = await guardInput(input(), deps({ sanitize: () => ({ safe: false, riskScore: 92, warnings: [{ type: 'inj', severity: 'high' }] }) }))
    expect(r.kind).toBe('injection')
    if (r.kind === 'injection') { expect(r.riskScore).toBe(92); expect(r.warnings).toHaveLength(1) }
  })
  it('reports sensitive-denied with the scan result', async () => {
    const scan = { hasSensitiveData: true, matches: [{ type: 'iban', value: 'CH..', riskLevel: 'high' }], overallRiskLevel: 'high' }
    const r = await guardInput(input({ provider: 'anthropic' }), deps({ scanSensitive: () => scan, checkUploadPermission: async () => ({ decision: 'denied', reason: 'PII' }) }))
    expect(r.kind).toBe('sensitive-denied')
    if (r.kind === 'sensitive-denied') { expect(r.reason).toBe('PII'); expect(r.scanResult.matches).toHaveLength(1) }
  })
  it('surfaces consent with scanResult, request and response (for the IPC dialog)', async () => {
    const scan = { hasSensitiveData: true, matches: [{ type: 'iban', value: 'x', riskLevel: 'high' }], overallRiskLevel: 'high' }
    const r = await guardInput(input({ provider: 'anthropic' }), deps({
      scanSensitive: () => scan,
      checkUploadPermission: async () => ({ decision: 'pending', requiresUserConsent: true, request: { fileId: 'abc' }, reason: 'r' }),
    }))
    expect(r.kind).toBe('consent')
    if (r.kind === 'consent') {
      expect(r.scanResult.matches).toHaveLength(1)
      expect((r.request as { fileId: string }).fileId).toBe('abc')
      expect(r.response.requiresUserConsent).toBe(true)
    }
  })
  it('is ok for a clean cloud prompt and skips the scan for local', async () => {
    expect((await guardInput(input({ provider: 'anthropic' }), deps())).kind).toBe('ok')
    let scanned = false
    const r = await guardInput(input({ provider: 'local' }), deps({ scanSensitive: () => { scanned = true; return { hasSensitiveData: true, matches: [], overallRiskLevel: 'high' } } }))
    expect(r.kind).toBe('ok'); expect(scanned).toBe(false)
  })
})

describe('guardDispatch (chat phase 2)', () => {
  it('switches provider on a budget fallback', () => {
    const r = guardDispatch(input({ provider: 'anthropic' }), deps({ checkBudget: () => ({ allowed: false, fallbackProvider: 'local' }) }))
    expect(r.ok).toBe(true); expect(r.provider).toBe('local')
  })
  it('blocks when the budget is exhausted with no fallback', () => {
    const r = guardDispatch(input(), deps({ checkBudget: () => ({ allowed: false, reason: 'over' }) }))
    expect(r.ok).toBe(false); expect(r.blockedKind).toBe('budget'); expect(r.reason).toBe('over')
  })
  it('routes to a safer provider and surfaces sensitivity + reasons for the safety-warning', () => {
    const r = guardDispatch(input({ provider: 'anthropic' }), deps({
      checkRouting: () => ({ allowed: false, suggestedProvider: 'local', classification: { sensitivity: 'confidential', reasons: ['iban'] } }),
    }))
    expect(r.ok).toBe(true); expect(r.provider).toBe('local')
    const w = r.warnings.find((x) => x.type === 'routing_fallback')
    expect(w?.sensitivity).toBe('confidential'); expect(w?.reasons).toEqual(['iban'])
  })
  it('blocks when routing finds no safe provider', () => {
    const r = guardDispatch(input(), deps({ checkRouting: () => ({ allowed: false, reason: 'no safe provider' }) }))
    expect(r.ok).toBe(false); expect(r.blockedKind).toBe('routing')
  })
})
