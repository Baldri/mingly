// Shared privacy/security guard for every path that sends content to an LLM.
//
// The pre-flight chain (prompt-injection scan, sensitive-data + cloud-upload
// consent, budget, sensitivity routing) and the post-flight output guardrails
// used to live ONLY on the chat IPC path, so the agent, comparison and HTTP/WS
// paths reached cloud providers unguarded (security audit 2026-08-21).
//
// This module is pure orchestration and imports only types, so it is unit-
// testable without the Electron/model module graph. Concrete components are
// injected as GuardDeps (see request-guard-deps.ts for the real wiring).

export interface SanitizeResult { safe: boolean; riskScore: number; warnings: { type: string; severity: string }[] }
export interface SensitiveScan { hasSensitiveData: boolean; matches: { type: string; value: string; riskLevel: string }[]; overallRiskLevel: string }
export interface UploadDecision { decision: string; reason?: string; requiresUserConsent?: boolean }
export interface BudgetCheck { allowed: boolean; fallbackProvider?: string; reason?: string }
export interface RoutingDecision { allowed: boolean; suggestedProvider?: string; reason?: string }
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

export type BlockedKind = 'injection' | 'sensitive' | 'budget' | 'routing'

export interface PreflightResult {
  ok: boolean
  /** The provider to actually use — may be switched by a budget/routing fallback. */
  provider: string
  blockedKind?: BlockedKind
  reason?: string
  requiresConsent?: boolean
  warnings: { type: string; message?: string }[]
}

const INJECTION_BLOCK_SCORE = 80

/**
 * Run the pre-flight guard chain before any LLM call. Non-interactive callers
 * (agent, comparison, HTTP) should treat `ok === false` as fail-closed: refuse
 * the call. `requiresConsent` means a human decision is needed and there is no
 * consent channel on this path, so it is also fail-closed.
 */
export async function preflightGuard(input: PreflightInput, deps: GuardDeps): Promise<PreflightResult> {
  const warnings: { type: string; message?: string }[] = []
  const texts = input.texts.filter((t) => typeof t === 'string')
  const full = texts.join('\n')
  const last = texts[texts.length - 1] ?? ''
  let provider = input.provider

  // 1. Prompt-injection defence — block only high-risk (mirrors the chat path).
  const san = deps.sanitize(last)
  if (!san.safe && san.riskScore >= INJECTION_BLOCK_SCORE) {
    return { ok: false, provider, blockedKind: 'injection', reason: 'High-risk content detected. Please rephrase.', warnings }
  }
  if (!san.safe) warnings.push({ type: 'injection_warning', message: `riskScore ${san.riskScore}` })

  // 2. Sensitive data → cloud requires an upload decision.
  if (deps.isCloudProvider(provider)) {
    const scan = deps.scanSensitive(full)
    if (scan.hasSensitiveData) {
      const perm = await deps.checkUploadPermission({ fullContent: full, provider, scan })
      if (perm.decision === 'denied') {
        return { ok: false, provider, blockedKind: 'sensitive', reason: perm.reason ?? 'Sensitive data upload denied.', warnings }
      }
      if (perm.requiresUserConsent) {
        return { ok: false, provider, blockedKind: 'sensitive', reason: 'User consent required for sensitive data upload.', requiresConsent: true, warnings }
      }
    }
  }

  // 3. Budget enforcement — switch to a fallback provider or block.
  const budget = deps.checkBudget(provider)
  if (!budget.allowed) {
    if (budget.fallbackProvider) {
      warnings.push({ type: 'budget_fallback', message: `${provider} -> ${budget.fallbackProvider}` })
      provider = budget.fallbackProvider
    } else {
      return { ok: false, provider, blockedKind: 'budget', reason: budget.reason ?? 'Budget exceeded for this provider.', warnings }
    }
  }

  // 4. Sensitivity routing — switch to a safer provider or block.
  const routing = deps.checkRouting(full, provider)
  if (!routing.allowed) {
    if (routing.suggestedProvider) {
      warnings.push({ type: 'routing_fallback', message: `${provider} -> ${routing.suggestedProvider}` })
      provider = routing.suggestedProvider
    } else {
      return { ok: false, provider, blockedKind: 'routing', reason: routing.reason ?? 'No safe provider available for this content.', warnings }
    }
  }

  return { ok: true, provider, warnings }
}

export interface PostflightResult {
  ok: boolean
  violations: { type: string; severity: string; description: string }[]
}

/**
 * Scan a completion with the output guardrails. `ok === false` when a critical
 * or high-severity violation is present (e.g. a leaked secret / canary).
 */
export function postflightGuard(output: string, systemPrompt: string, deps: GuardDeps): PostflightResult {
  const scan = deps.scanOutput(output, systemPrompt)
  const blocking = scan.violations.filter((v) => v.severity === 'critical' || v.severity === 'high')
  return { ok: blocking.length === 0, violations: scan.violations }
}
