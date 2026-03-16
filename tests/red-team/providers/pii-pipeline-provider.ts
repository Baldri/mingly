/**
 * promptfoo Custom Provider for Mingly PII Pipeline.
 *
 * Calls detectPII() and PIIAnonymizer.anonymize() directly (Node.js, no Electron).
 * Two modes: detect (entities) and anonymize (full anonymization).
 * NER toggle via setNERDetector(null) for 2-layer vs 3-layer testing.
 */

import { detectPII, setNERDetector } from '../../../src/main/privacy/detector-pipeline'
import { PIIAnonymizer } from '../../../src/main/privacy/anonymizer'
import type { PIIEntity, DetectionResult, AnonymizationResult } from '../../../src/main/privacy/pii-types'

interface ProviderResponse {
  output: string
  tokenUsage?: { total: number }
}

// --- Helpers ---

function formatDetectionResult(result: DetectionResult): string {
  return JSON.stringify({
    detected: result.entities.length,
    entities: result.entities.map((e: PIIEntity) => ({
      category: e.category,
      original: e.original,
      source: e.source,
      confidence: e.confidence,
      start: e.start,
      end: e.end,
    })),
    latencyMs: result.latencyMs,
  }, null, 2)
}

function formatAnonymizationResult(
  result: AnonymizationResult,
  originalPII: string[]
): string {
  // Check for PII leaks in anonymized output
  const leaks = originalPII.filter(pii =>
    result.anonymizedText.includes(pii)
  )

  return JSON.stringify({
    anonymizedText: result.anonymizedText,
    mode: result.mode,
    replacements: result.replacements.map(r => ({
      category: r.entity.category,
      original: r.entity.original,
      replacement: r.replacement,
    })),
    stats: result.stats,
    latencyMs: result.latencyMs,
    leaks,
    leakCount: leaks.length,
  }, null, 2)
}

// --- Provider Exports ---

/**
 * 2-Layer Detection (Regex + Swiss only, NER disabled).
 */
export async function detect_2layer(prompt: string): Promise<ProviderResponse> {
  setNERDetector(null)
  const result = await detectPII(prompt)
  return { output: formatDetectionResult(result) }
}

/**
 * 3-Layer Detection (Regex + Swiss + NER).
 * Requires piiranha-v1 model at ~/.mingly/models/.
 */
export async function detect_3layer(prompt: string): Promise<ProviderResponse> {
  // Reset to default NER singleton (will lazy-init from model on disk)
  // Note: calling setNERDetector with a fresh instance would require NERModelManager
  // For now, we rely on the default singleton behavior
  const result = await detectPII(prompt)
  return { output: formatDetectionResult(result) }
}

/**
 * Anonymize in Shield mode (fake CH data).
 */
export async function anonymize_shield(prompt: string): Promise<ProviderResponse> {
  setNERDetector(null)
  const anonymizer = new PIIAnonymizer(`red-team-${Date.now()}`, 'shield')
  const result = await anonymizer.anonymize(prompt)
  const originalPII = result.replacements.map(r => r.entity.original)
  return { output: formatAnonymizationResult(result, originalPII) }
}

/**
 * Anonymize in Vault mode ([CATEGORY] markers).
 */
export async function anonymize_vault(prompt: string): Promise<ProviderResponse> {
  setNERDetector(null)
  const anonymizer = new PIIAnonymizer(`red-team-${Date.now()}`, 'vault')
  const result = await anonymizer.anonymize(prompt)
  const originalPII = result.replacements.map(r => r.entity.original)
  return { output: formatAnonymizationResult(result, originalPII) }
}
