// Real GuardDeps wiring for request-guard. Imports the concrete security /
// tracking singletons — kept OUT of request-guard.ts so that stays unit-
// testable without this module graph. Casts are localized to this boundary.
import { createHash } from 'crypto'
import { getInputSanitizer } from './input-sanitizer'
import { getSensitiveDataDetector } from './sensitive-data-detector'
import { getUploadPermissionManager, type UploadPermissionRequest } from './upload-permission-manager'
import { getDataClassifier } from './data-classifier'
import { getOutputGuardrails } from './output-guardrails'
import { getBudgetManager } from '../tracking/budget-manager'
import type { GuardDeps, SensitiveScan } from './request-guard'
import { getProviderRegistry } from '../routing/provider-registry'
import { DEFAULT_POLICY } from '../policy/policy-engine'
import { applyResidencyPolicy, DATA_SENSITIVITY_TO_PII } from '../policy/residency-guard'
import { logRoutingDecision } from '../policy/audit-writer'
import { trustForProvider, knownProviderIds } from './provider-trust'

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'google'])

export function getGuardDeps(): GuardDeps {
  return {
    sanitize: (text) => {
      const r = getInputSanitizer().sanitize(text)
      return { safe: r.safe, riskScore: r.riskScore, warnings: r.warnings, sanitized: r.sanitized }
    },
    scanSensitive: (text) => getSensitiveDataDetector().scan(text) as unknown as SensitiveScan,
    checkUploadPermission: async ({ fullContent, provider, scan }) => {
      const request: UploadPermissionRequest = {
        fileId: createHash('sha256').update(fullContent).digest('hex'),
        filePath: '<message-content>',
        directoryId: 'conversation',
        destination: 'cloud',
        provider,
        // scan is the real SensitiveDataScanResult at runtime (see scanSensitive).
        scanResult: scan as unknown as UploadPermissionRequest['scanResult'],
        timestamp: Date.now(),
      }
      const res = await getUploadPermissionManager().checkUploadPermission(request)
      // Return the full response (decision/reason/requiresUserConsent/policy/…)
      // plus the request, so the chat consent event is byte-identical to before.
      return { ...res, request }
    },
    checkBudget: (provider) => getBudgetManager().checkBudget(provider),
    // Two independent questions, chained: is this provider TRUSTED enough for
    // the content (DataClassifier), and does it sit in an acceptable
    // JURISDICTION (policy core)? Both must pass.
    //
    // The trust resolver consults the registry, so a provider we verified
    // ourselves earns trust from its origin instead of falling to the lowest
    // level for not being in a hardcoded list.
    checkRouting: (text, provider, conversationId) => {
      const classifier = getDataClassifier()
      const registry = getProviderRegistry()
      const known = knownProviderIds()

      const trust = classifier.checkRouting(text, provider, trustForProvider, known)
      const decision = applyResidencyPolicy(
        trust,
        provider,
        registry.all(),
        DEFAULT_POLICY,
        (candidate) => classifier.checkRouting(text, candidate, trustForProvider, known).allowed
      )

      const chosen = decision.allowed ? provider : (decision.suggestedProvider ?? '')

      // Never the message text — only what was decided about it.
      logRoutingDecision({
        actorId: 'local',
        conversationId: conversationId ?? 'unknown',
        level: DATA_SENSITIVITY_TO_PII[decision.classification.sensitivity],
        reason: decision.reason ?? `trust level ${decision.classification.sensitivity}`,
        bySource: { regex: 0, ner: 0, swiss: 0, custom: 0 },
        policyVersion: DEFAULT_POLICY.version,
        appliedRule: null,
        allowedProviders: decision.allowed ? [provider] : [],
        chosenProvider: chosen,
        residency: registry.get(chosen)?.origin.residency ?? 'unknown'
      })

      return decision
    },
    isCloudProvider: (provider) => CLOUD_PROVIDERS.has(provider),
    scanOutput: (output, systemPrompt) => getOutputGuardrails().scan(output, systemPrompt),
  }
}
