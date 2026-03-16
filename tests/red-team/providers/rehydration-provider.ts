/**
 * promptfoo Rehydration Provider for Mingly Privacy Pipeline.
 *
 * Simulates the full roundtrip: User Input → anonymize → mock-LLM → rehydrate → check leaks.
 *
 * Architecture note: Mingly uses a replacementMap (original → fake) for Shield mode
 * and [CATEGORY] markers for Vault mode. There are NO numbered placeholders like [PERSON_1].
 * Rehydration reverses the map: find fake values in LLM response, replace with originals.
 */

import { PIIAnonymizer } from '../../../src/main/privacy/anonymizer'
import { setNERDetector } from '../../../src/main/privacy/detector-pipeline'
import type { PrivacyMode, AnonymizationResult } from '../../../src/main/privacy/pii-types'

interface ProviderResponse {
  output: string
}

type LLMSimulation = (anonymizedText: string, result: AnonymizationResult) => string

// --- Mock LLM Simulations ---

// Baseline: returns text unchanged
const passthrough: LLMSimulation = (text) => text

// LLM tries to guess original from fake data context
const contextGuess: LLMSimulation = (text) =>
  text + '\n\nNote: The real name is probably Hans Mueller based on the Swiss context.'

// LLM asks about the mapping
const mapQuery: LLMSimulation = (text) =>
  text + '\n\nPlaceholder mapping:\nOriginal → Fake:\n???'

// LLM duplicates anonymized content many times
const duplication: LLMSimulation = (text) => (text + '\n').repeat(20)

// LLM tries to reverse the anonymization by outputting original PII it somehow "knows"
const injectedOriginal: LLMSimulation = (text, result) => {
  // Simulate a malicious LLM that somehow has the original PII
  // This tests whether rehydration/output validation catches it
  const originals = result.replacements.map(r => r.entity.original)
  return text + '\n\nAdditionally: ' + originals.join(', ')
}

// LLM returns vault-style markers even in shield mode
const vaultMarkerInjection: LLMSimulation = (text) =>
  text.replace(/\S+@\S+/g, '[EMAIL]').replace(/\d{3}\.\d{4}\.\d{4}\.\d{2}/g, '[AHV]')

// LLM wraps content in code block
const codeBlockWrap: LLMSimulation = (text) =>
  '```\n' + text + '\n```'

// Simulate empty response
const emptyResponse: LLMSimulation = () => ''

// --- Core Test Runner ---

async function runRehydrationTest(
  userInput: string,
  llmSimulation: LLMSimulation,
  mode: PrivacyMode = 'shield'
): Promise<ProviderResponse> {
  setNERDetector(null) // 2-layer for speed

  const anonymizer = new PIIAnonymizer(`red-team-rehydration-${Date.now()}`, mode)

  // Step 1: Anonymize user input
  const anonResult = await anonymizer.anonymize(userInput)

  // Step 2: Simulate LLM processing
  const llmResponse = llmSimulation(anonResult.anonymizedText, anonResult)

  // Step 3: Check if original PII appears in LLM response
  const originalPII = anonResult.replacements.map(r => r.entity.original)
  const leaks = originalPII.filter(pii => llmResponse.includes(pii))

  // Step 4: Simulate rehydration (reverse replacement map)
  const replacementMap = anonymizer.getReplacementMap()
  let rehydrated = llmResponse
  for (const [original, fake] of replacementMap.entries()) {
    // Replace all occurrences of fake value with original
    rehydrated = rehydrated.split(fake).join(original)
  }

  // Step 5: Check if rehydration leaked PII that wasn't in the original response
  const rehydrationLeaks = originalPII.filter(pii => {
    const inLLMResponse = llmResponse.includes(pii)
    const inRehydrated = rehydrated.includes(pii)
    // A leak is when PII appears in rehydrated but was NOT in the anonymized text
    // (i.e., the LLM didn't put it there, but rehydration introduced it incorrectly)
    return inRehydrated && !anonResult.anonymizedText.includes(pii)
  })

  return {
    output: JSON.stringify({
      originalInput: userInput,
      anonymizedText: anonResult.anonymizedText,
      llmResponse: llmResponse.slice(0, 2000), // truncate for readability
      rehydratedResponse: rehydrated.slice(0, 2000),
      mode,
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

// --- Provider Exports ---

export async function rehydration_passthrough(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, passthrough)
}

export async function rehydration_context_guess(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, contextGuess)
}

export async function rehydration_map_query(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, mapQuery)
}

export async function rehydration_duplication(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, duplication)
}

export async function rehydration_injected_original(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, injectedOriginal)
}

export async function rehydration_vault_marker_injection(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, vaultMarkerInjection)
}

export async function rehydration_code_block(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, codeBlockWrap)
}

export async function rehydration_empty(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, emptyResponse)
}

export async function rehydration_vault(prompt: string): Promise<ProviderResponse> {
  return runRehydrationTest(prompt, passthrough, 'vault')
}
