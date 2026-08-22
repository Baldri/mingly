// Shared privacy/security guard for every path that sends content to an LLM.
//
// Split into two phases so the chat IPC path — which interleaves command
// handling between them — can reuse the SAME logic at its two positions:
//   guardInput    : prompt-injection scan + sensitive-data/upload consent
//   guardDispatch : budget enforcement + sensitivity routing
// preflightGuard composes both for the non-interactive callers (agent,
// comparison, HTTP), which run them back-to-back.
//
// Pure orchestration, imports only types → unit-testable without the
// Electron/model module graph (concrete components injected as GuardDeps).

export interface SanitizeResult { safe: boolean; riskScore: number; warnings: { type: string; severity: string }[] }
export interface SensitiveScan { hasSensitiveData: boolean; matches: { type: string; value: string; riskLevel: string }[]; overallRiskLevel: string }
export interface UploadDecision { decision: string; reason?: string; requiresUserConsent?: boolean; request?: unknown }
export interface BudgetCheck { allowed: boolean; fallbackProvider?: string; reason?: string }
export interface RoutingDecision { allowed: boolean; suggestedProvider?: string; reason?: string; classification?: { sensitivity: string; reasons: string[] } }
export interface OutputScan { violations: { type: string; severity: string; description: string }[] }

export interface GuardDeps {
  sanitize(text: string): SanitizeResult
  scanSensitive(text: string): SensitiveScan
  checkUploadPermission(args: { fullContent: string; provider: string; scan: SensitiveScan }): Promise<UploadDecision>
  checkBudget(provider: string): BudgetCheck
  checkRouting(text: string, provider: string): RoutingDecision
  isCloudProvider(provider: string): boolean
  scanOutput(output: string, systemPrompt: string): OutputScan
}

export interface PreflightInput {
  /** All message contents (used for the sensitive-data + routing scans). */
  texts: string[]
  provider: string
  model: string
  conversationId?: string
}

const INJECTION_BLOCK_SCORE = 80

// ── Phase 1: input guards (injection + sensitive-data/consent) ─────────

export type InputGuardOutcome =
  | { kind: 'ok' }
  | { kind: 'injection'; riskScore: number; warnings: { type: string; severity: string }[] }
  | { kind: 'sensitive-denied'; reason: string; scanResult: SensitiveScan }
  | { kind: 'consent'; scanResult: SensitiveScan; request: unknown; response: UploadDecision }

export async function guardInput(input: PreflightInput, deps: GuardDeps): Promise<InputGuardOutcome> {
  const texts = input.texts.filter((t) => typeof t === 'string')
  const full = texts.join('\n')
  const last = texts[texts.length - 1] ?? ''

  const san = deps.sanitize(last)
  if (!san.safe && san.riskScore >= INJECTION_BLOCK_SCORE) {
    return { kind: 'injection', riskScore: san.riskScore, warnings: san.warnings }
  }

  if (deps.isCloudProvider(input.provider)) {
    const scanResult = deps.scanSensitive(full)
    if (scanResult.hasSensitiveData) {
      const perm = await deps.checkUploadPermission({ fullContent: full, provider: input.provider, scan: scanResult })
      if (perm.decision === 'denied') {
        return { kind: 'sensitive-denied', reason: perm.reason ?? 'Sensitive data upload denied.', scanResult }
      }
      if (perm.requiresUserConsent) {
        return { kind: 'consent', scanResult, request: perm.request, response: perm }
      }
    }
  }

  return { kind: 'ok' }
}

// ── Phase 2: dispatch guards (budget + routing) ────────────────────────

export interface GuardWarning {
  type: string
  message?: string
  /** routing-fallback extras (so the chat path can build its safety-warning). */
  provider?: string
  sensitivity?: string
  reasons?: string[]
}

export interface DispatchResult {
  ok: boolean
  /** The provider to actually use — may be switched by a budget/routing fallback. */
  provider: string
  blockedKind?: 'budget' | 'routing'
  reason?: string
  warnings: GuardWarning[]
}

export function guardDispatch(input: PreflightInput, deps: GuardDeps): DispatchResult {
  const full = input.texts.filter((t) => typeof t === 'string').join('\n')
  let provider = input.provider
  const warnings: GuardWarning[] = []

  const budget = deps.checkBudget(provider)
  if (!budget.allowed) {
    if (budget.fallbackProvider) {
      warnings.push({ type: 'budget_fallback', message: `${provider} -> ${budget.fallbackProvider}` })
      provider = budget.fallbackProvider
    } else {
      return { ok: false, provider, blockedKind: 'budget', reason: budget.reason ?? 'Budget exceeded for this provider.', warnings }
    }
  }

  const routing = deps.checkRouting(full, provider)
  if (!routing.allowed) {
    if (routing.suggestedProvider) {
      provider = routing.suggestedProvider
      warnings.push({
        type: 'routing_fallback',
        provider,
        sensitivity: routing.classification?.sensitivity,
        reasons: routing.classification?.reasons,
        message: `Content classified as "${routing.classification?.sensitivity}" — routed to ${provider}.`,
      })
    } else {
      return { ok: false, provider, blockedKind: 'routing', reason: routing.reason ?? 'No safe provider available for this content.', warnings }
    }
  }

  return { ok: true, provider, warnings }
}

// ── Composition for non-interactive callers ────────────────────────────

export type BlockedKind = 'injection' | 'sensitive' | 'budget' | 'routing'

export interface PreflightResult {
  ok: boolean
  provider: string
  blockedKind?: BlockedKind
  reason?: string
  requiresConsent?: boolean
  warnings: { type: string; message?: string }[]
}

/**
 * Run both guard phases before an LLM call. Non-interactive callers (agent,
 * comparison, HTTP) treat `ok === false` as fail-closed. `requiresConsent`
 * needs a human decision and there is no consent channel here, so it is also
 * fail-closed.
 */
export async function preflightGuard(input: PreflightInput, deps: GuardDeps): Promise<PreflightResult> {
  const inGuard = await guardInput(input, deps)
  if (inGuard.kind === 'injection') {
    return { ok: false, provider: input.provider, blockedKind: 'injection', reason: 'High-risk content detected. Please rephrase.', warnings: [] }
  }
  if (inGuard.kind === 'sensitive-denied') {
    return { ok: false, provider: input.provider, blockedKind: 'sensitive', reason: inGuard.reason, warnings: [] }
  }
  if (inGuard.kind === 'consent') {
    return { ok: false, provider: input.provider, blockedKind: 'sensitive', reason: 'User consent required for sensitive data upload.', requiresConsent: true, warnings: [] }
  }

  const disp = guardDispatch(input, deps)
  return {
    ok: disp.ok,
    provider: disp.provider,
    blockedKind: disp.blockedKind,
    reason: disp.reason,
    warnings: disp.warnings.map((w) => ({ type: w.type, message: w.message })),
  }
}

// ── Post-flight output guardrails ──────────────────────────────────────

export interface PostflightResult {
  ok: boolean
  violations: { type: string; severity: string; description: string }[]
}

export function postflightGuard(output: string, systemPrompt: string, deps: GuardDeps): PostflightResult {
  const scan = deps.scanOutput(output, systemPrompt)
  const blocking = scan.violations.filter((v) => v.severity === 'critical' || v.severity === 'high')
  return { ok: blocking.length === 0, violations: scan.violations }
}
