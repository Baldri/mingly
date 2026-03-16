/**
 * promptfoo Custom Provider for Mingly PII Pipeline.
 *
 * Uses the promptfoo ApiProvider class interface (default export).
 * Mode is configured via the `config.mode` option in promptfooconfig.yaml.
 *
 * Supported modes:
 * - detect_2layer: Regex + Swiss only (NER disabled)
 * - detect_3layer: Regex + Swiss + NER (requires model on disk)
 * - anonymize_shield: Full anonymization with fake CH data
 * - anonymize_vault: Full anonymization with [CATEGORY] markers
 */

import { detectPII, setNERDetector } from '../../../src/main/privacy/detector-pipeline'
import { PIIAnonymizer } from '../../../src/main/privacy/anonymizer'
import type { PIIEntity, DetectionResult, AnonymizationResult } from '../../../src/main/privacy/pii-types'

type Mode = 'detect_2layer' | 'detect_3layer' | 'anonymize_shield' | 'anonymize_vault'

interface ProviderOptions {
  id?: string
  config?: { mode?: Mode }
}

interface ProviderResponse {
  output: string
  tokenUsage?: { total: number }
}

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

export default class PiiPipelineProvider {
  private mode: Mode

  constructor(options: ProviderOptions) {
    this.mode = options.config?.mode ?? 'detect_2layer'
  }

  id(): string {
    return `pii-pipeline:${this.mode}`
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    switch (this.mode) {
      case 'detect_2layer': {
        setNERDetector(null)
        const result = await detectPII(prompt)
        return { output: formatDetectionResult(result) }
      }

      case 'detect_3layer': {
        const result = await detectPII(prompt)
        return { output: formatDetectionResult(result) }
      }

      case 'anonymize_shield': {
        setNERDetector(null)
        const anonymizer = new PIIAnonymizer(`red-team-${Date.now()}`, 'shield')
        const result = await anonymizer.anonymize(prompt)
        const originalPII = result.replacements.map(r => r.entity.original)
        return { output: formatAnonymizationResult(result, originalPII) }
      }

      case 'anonymize_vault': {
        setNERDetector(null)
        const anonymizer = new PIIAnonymizer(`red-team-${Date.now()}`, 'vault')
        const result = await anonymizer.anonymize(prompt)
        const originalPII = result.replacements.map(r => r.entity.original)
        return { output: formatAnonymizationResult(result, originalPII) }
      }

      default:
        return { output: JSON.stringify({ error: `Unknown mode: ${this.mode}` }) }
    }
  }
}
