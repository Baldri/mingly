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

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'google'])

export function getGuardDeps(): GuardDeps {
  return {
    sanitize: (text) => getInputSanitizer().sanitize(text),
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
    checkRouting: (text, provider) => getDataClassifier().checkRouting(text, provider),
    isCloudProvider: (provider) => CLOUD_PROVIDERS.has(provider),
    scanOutput: (output, systemPrompt) => getOutputGuardrails().scan(output, systemPrompt),
  }
}
