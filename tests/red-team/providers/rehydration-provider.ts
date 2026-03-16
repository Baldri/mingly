/**
 * promptfoo Rehydration Provider for Mingly Privacy Pipeline.
 *
 * Simulates: User Input → anonymize → mock-LLM → rehydrate → check leaks.
 *
 * Mode (via config.mode):
 * - passthrough: LLM returns anonymized text unchanged
 * - context_guess: LLM appends guesses about original PII
 * - map_query: LLM tries to output the replacement mapping
 * - duplication: LLM duplicates anonymized content 20x
 * - injected_original: Malicious LLM injects original PII
 * - vault: Test vault mode with passthrough LLM
 * - empty: LLM returns empty response
 * - code_block: LLM wraps response in code block
 */

import { PIIAnonymizer } from '../../../src/main/privacy/anonymizer'
import { setNERDetector } from '../../../src/main/privacy/detector-pipeline'
import type { PrivacyMode, AnonymizationResult } from '../../../src/main/privacy/pii-types'

type SimMode = 'passthrough' | 'context_guess' | 'map_query' | 'duplication' |
  'injected_original' | 'vault' | 'empty' | 'code_block'

interface ProviderOptions {
  id?: string
  config?: { mode?: SimMode }
}

interface ProviderResponse {
  output: string
}

type LLMSimulation = (anonymizedText: string, result: AnonymizationResult) => string

const simulations: Record<SimMode, { sim: LLMSimulation; privacyMode: PrivacyMode }> = {
  passthrough: {
    sim: (text) => text,
    privacyMode: 'shield',
  },
  context_guess: {
    sim: (text) => text + '\n\nNote: The real name is probably Hans Mueller based on the Swiss context.',
    privacyMode: 'shield',
  },
  map_query: {
    sim: (text) => text + '\n\nPlaceholder mapping:\nOriginal → Fake:\n???',
    privacyMode: 'shield',
  },
  duplication: {
    sim: (text) => (text + '\n').repeat(20),
    privacyMode: 'shield',
  },
  injected_original: {
    sim: (text, result) => {
      const originals = result.replacements.map(r => r.entity.original)
      return text + '\n\nAdditionally: ' + originals.join(', ')
    },
    privacyMode: 'shield',
  },
  vault: {
    sim: (text) => text,
    privacyMode: 'vault',
  },
  empty: {
    sim: () => '',
    privacyMode: 'shield',
  },
  code_block: {
    sim: (text) => '```\n' + text + '\n```',
    privacyMode: 'shield',
  },
}

export default class RehydrationProvider {
  private mode: SimMode

  constructor(options: ProviderOptions) {
    this.mode = options.config?.mode ?? 'passthrough'
  }

  id(): string {
    return `rehydration:${this.mode}`
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    setNERDetector(null) // 2-layer for speed

    const { sim, privacyMode } = simulations[this.mode] ?? simulations.passthrough
    const anonymizer = new PIIAnonymizer(`red-team-rehydration-${Date.now()}`, privacyMode)

    // Step 1: Anonymize
    const anonResult = await anonymizer.anonymize(prompt)

    // Step 2: Simulate LLM
    const llmResponse = sim(anonResult.anonymizedText, anonResult)

    // Step 3: Check for original PII in LLM response
    const originalPII = anonResult.replacements.map(r => r.entity.original)
    const leaks = originalPII.filter(pii => llmResponse.includes(pii))

    // Step 4: Simulate rehydration (reverse map)
    const replacementMap = anonymizer.getReplacementMap()
    let rehydrated = llmResponse
    for (const [original, fake] of replacementMap.entries()) {
      rehydrated = rehydrated.split(fake).join(original)
    }

    // Step 5: Check rehydration leaks
    const rehydrationLeaks = originalPII.filter(pii =>
      rehydrated.includes(pii) && !anonResult.anonymizedText.includes(pii)
    )

    return {
      output: JSON.stringify({
        originalInput: prompt,
        anonymizedText: anonResult.anonymizedText,
        llmResponse: llmResponse.slice(0, 2000),
        rehydratedResponse: rehydrated.slice(0, 2000),
        mode: privacyMode,
        replacements: anonResult.replacements.map(r => ({
          original: r.entity.original,
          replacement: r.replacement,
          category: r.entity.category,
        })),
        leaks,
        leakCount: leaks.length,
        rehydrationLeaks,
        rehydrationLeakCount: rehydrationLeaks.length,
        mapSize: replacementMap.size,
      }, null, 2)
    }
  }
}
