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

export interface SanitizeResult { safe: boolean; riskScore: number; warnings: { type: string; severity: string }[]; sanitized?: string }
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
  /** conversationId is optional so existing test doubles keep type-checking; the
   *  real implementation needs it for the audit entry. */
  checkRouting(text: string, provider: string, conversationId?: string): RoutingDecision
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

/**
 * What the sanitizer said about the text it was given, on the two outcomes that
 * do NOT end the call.
 *
 * `sanitizedText` is the cleaned string. Whether a caller forwards it is the
 * caller's decision and the two differ on purpose: the chat path sends the
 * cleaned text, the agent loop forwards the original bytes because
 * mingly_edit_file matches its `oldText` against the real file. `warnings`
 * exists so the loop path can RECORD that difference instead of leaving it
 * silent — it never carries a found value, only the type names.
 */
export interface SanitizerReport {
  sanitizedText?: string
  warnings?: { type: string; severity: string }[]
}

export type InputGuardOutcome =
  | ({ kind: 'ok' } & SanitizerReport)
  | { kind: 'injection'; riskScore: number; warnings: { type: string; severity: string }[] }
  | { kind: 'sensitive-denied'; reason: string; scanResult: SensitiveScan }
  | ({ kind: 'consent'; scanResult: SensitiveScan; request: unknown; response: UploadDecision } & SanitizerReport)

export async function guardInput(input: PreflightInput, deps: GuardDeps): Promise<InputGuardOutcome> {
  const texts = input.texts.filter((t) => typeof t === 'string')
  const full = texts.join('\n')
  const last = texts[texts.length - 1] ?? ''

  const san = deps.sanitize(last)
  const sanitizedText = san.sanitized
  const warnings = san.warnings
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
        // The report travels with a consent outcome too: that result is still
        // forwarded (as it was, anonymised or withheld) and the caller moves
        // past it, so a report left out here would be lost for good.
        return { kind: 'consent', scanResult, request: perm.request, response: perm, sanitizedText, warnings }
      }
    }
  }

  return { kind: 'ok', sanitizedText, warnings }
}

// ── Phase 2: dispatch guards (budget + routing) ────────────────────────

export interface GuardWarning {
  type: string
  message?: string
  /** The provider the CALLER asked for, on both fallback warnings. */
  requestedProvider?: string
  /** routing-fallback extras (so the chat path can build its safety-warning). */
  provider?: string
  sensitivity?: string
  reasons?: string[]
}

/** Which guard branch refused the provider the caller asked for. */
export type SwitchCause = 'budget' | 'routing'

/**
 * A dispatch that did not accept the provider it was given.
 *
 * Present whenever a fallback was TAKEN, not whenever the names differ: a
 * budget fallback that a routing suggestion sends back to the starting provider
 * has identical names in and out, yet its budget verdict was "not allowed".
 * Same reasoning as the loop guard's (loop-guard.ts:204-209) — the names are a
 * worse signal than the verdicts that produced them.
 */
export interface ProviderSwitch {
  /** The provider the caller asked for. */
  from: string
  /** The provider dispatch settled on. */
  to: string
  /** The refusals that led here, in the order they happened. */
  causes: SwitchCause[]
  /**
   * `from` runs on this machine and `to` does not.
   *
   * This is the shape that cannot be allowed to happen quietly: `guardInput`
   * runs the sensitive-data scan and the upload-permission branch only when the
   * provider it was GIVEN is a cloud provider, so an on-device run skips that
   * branch entirely. Shipping that content to a cloud provider afterwards sends
   * it to a recipient it was never checked against.
   */
  leavesDevice: boolean
}

export interface DispatchResult {
  ok: boolean
  /** The provider to actually use — may be switched by a budget/routing fallback. */
  provider: string
  blockedKind?: 'budget' | 'routing'
  reason?: string
  warnings: GuardWarning[]
  /** Set when a fallback was taken; absent when dispatch accepted the provider. */
  switched?: ProviderSwitch
}

export function guardDispatch(input: PreflightInput, deps: GuardDeps): DispatchResult {
  const full = input.texts.filter((t) => typeof t === 'string').join('\n')
  const requestedProvider = input.provider
  let provider = requestedProvider
  const warnings: GuardWarning[] = []
  const causes: SwitchCause[] = []

  const budget = deps.checkBudget(provider)
  if (!budget.allowed) {
    if (budget.fallbackProvider) {
      warnings.push({
        type: 'budget_fallback',
        requestedProvider,
        provider: budget.fallbackProvider,
        message: `${provider} -> ${budget.fallbackProvider}`,
      })
      causes.push('budget')
      provider = budget.fallbackProvider
    } else {
      return { ok: false, provider, blockedKind: 'budget', reason: budget.reason ?? 'Budget exceeded for this provider.', warnings }
    }
  }

  const routing = deps.checkRouting(full, provider, input.conversationId)
  if (!routing.allowed) {
    if (routing.suggestedProvider) {
      provider = routing.suggestedProvider
      causes.push('routing')
      warnings.push({
        type: 'routing_fallback',
        requestedProvider,
        provider,
        sensitivity: routing.classification?.sensitivity,
        reasons: routing.classification?.reasons,
        message: `Content classified as "${routing.classification?.sensitivity}" — routed to ${provider}.`,
      })
    } else {
      return { ok: false, provider, blockedKind: 'routing', reason: routing.reason ?? 'No safe provider available for this content.', warnings }
    }
  }

  if (causes.length === 0) return { ok: true, provider, warnings }

  return {
    ok: true,
    provider,
    warnings,
    switched: {
      from: requestedProvider,
      to: provider,
      causes,
      leavesDevice: !deps.isCloudProvider(requestedProvider) && deps.isCloudProvider(provider),
    },
  }
}

/** The words a user gets when an on-device run is stopped instead of uploaded. */
export function describeOffDeviceSwitch(switched: ProviderSwitch): string {
  const cause = switched.causes.map((c) => `${c} fallback`).join(' and ')
  return (
    `Dispatch refused ${switched.from} as-is for this content (${cause}), and the fallback ` +
    `${switched.to} is not on-device: the content would leave this machine. It was only ever ` +
    `checked against ${switched.from}, which skips the sensitive-data scan a cloud provider ` +
    `gets, so the run ends instead of switching to ${switched.to}.`
  )
}

// ── Composition for non-interactive callers ────────────────────────────

export type BlockedKind = 'injection' | 'sensitive' | 'budget' | 'routing'

export interface PreflightResult {
  ok: boolean
  provider: string
  /** The provider the caller asked for, whatever happened to it afterwards. */
  requestedProvider: string
  blockedKind?: BlockedKind
  reason?: string
  requiresConsent?: boolean
  sanitizedText?: string
  /**
   * Everything the dispatch guard had to say, with the routing extras intact.
   * A caller that reports the switch to a human needs `provider` and `reasons`,
   * and both used to be stripped here.
   */
  warnings: GuardWarning[]
  /** Set when dispatch did not accept the provider — on a block too. */
  switched?: ProviderSwitch
}

/**
 * Run both guard phases before an LLM call. Non-interactive callers (agent,
 * comparison, HTTP) treat `ok === false` as fail-closed. `requiresConsent`
 * needs a human decision and there is no consent channel here, so it is also
 * fail-closed.
 *
 * A dispatch fallback that moves an on-device run to a cloud provider is
 * fail-closed as well, for the reason spelled out on `ProviderSwitch
 * .leavesDevice`: it is the one switch whose content was never checked against
 * the provider that would receive it. The loop guard already ends a run for
 * exactly this mid-run (loop-guard.ts:209-227); this is the same rule applied
 * before the first call, where it was missing.
 */
export async function preflightGuard(input: PreflightInput, deps: GuardDeps): Promise<PreflightResult> {
  const requestedProvider = input.provider
  const inGuard = await guardInput(input, deps)
  if (inGuard.kind === 'injection') {
    return { ok: false, provider: requestedProvider, requestedProvider, blockedKind: 'injection', reason: 'High-risk content detected. Please rephrase.', warnings: [] }
  }
  if (inGuard.kind === 'sensitive-denied') {
    return { ok: false, provider: requestedProvider, requestedProvider, blockedKind: 'sensitive', reason: inGuard.reason, warnings: [] }
  }
  if (inGuard.kind === 'consent') {
    return { ok: false, provider: requestedProvider, requestedProvider, blockedKind: 'sensitive', reason: 'User consent required for sensitive data upload.', requiresConsent: true, warnings: [] }
  }

  const disp = guardDispatch(input, deps)

  // Fail closed on the one switch nothing re-checked. `provider` stays the
  // requested one so a caller that assigns it unconditionally cannot end up
  // holding the cloud provider this very branch refused.
  if (disp.ok && disp.switched?.leavesDevice) {
    const causes = disp.switched.causes
    return {
      ok: false,
      provider: requestedProvider,
      requestedProvider,
      blockedKind: causes[causes.length - 1],
      reason: describeOffDeviceSwitch(disp.switched),
      sanitizedText: inGuard.sanitizedText,
      warnings: disp.warnings,
      switched: disp.switched,
    }
  }

  return {
    ok: disp.ok,
    provider: disp.provider,
    requestedProvider,
    blockedKind: disp.blockedKind,
    reason: disp.reason,
    sanitizedText: inGuard.sanitizedText,
    warnings: disp.warnings,
    switched: disp.switched,
  }
}

// ── Post-flight output guardrails ──────────────────────────────────────

export interface PostflightResult {
  ok: boolean
  /** Everything the scan returned, blocking or not. */
  violations: { type: string; severity: string; description: string }[]
  /**
   * The subset that made `ok` false. This is the single answer to "which
   * severity blocks": a caller that reports WHY a run ended reads this instead
   * of filtering `violations` by severity again, because two independent
   * answers drift apart and then the message and the behaviour disagree.
   */
  blocking: { type: string; severity: string; description: string }[]
}

export function postflightGuard(output: string, systemPrompt: string, deps: GuardDeps): PostflightResult {
  const scan = deps.scanOutput(output, systemPrompt)
  const blocking = scan.violations.filter((v) => v.severity === 'critical' || v.severity === 'high')
  return { ok: blocking.length === 0, violations: scan.violations, blocking }
}
