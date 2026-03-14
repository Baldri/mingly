/**
 * PII Rehydrator
 * Reverses anonymization in LLM responses by replacing fake data
 * back with original PII values using the session map.
 *
 * Example:
 *   Anonymized prompt: "Thomas, hier sind Empfehlungen für Luzern..."
 *   Rehydrated:        "Holger, hier sind Empfehlungen für Basel..."
 */

import type { PrivacyMode } from './pii-types'
import type { PrivacySessionMap } from './session-map'

/** Result of rehydration */
export interface RehydrationResult {
  /** Text with fake data replaced by original PII */
  rehydratedText: string
  /** Number of replacements made */
  replacementCount: number
  /** Whether rehydration was attempted */
  attempted: boolean
  /** Processing time in ms */
  latencyMs: number
}

/**
 * Rehydrate LLM response text by reversing anonymization.
 *
 * Strategy: Replace longest matches first to avoid partial replacement
 * issues (e.g., "Thomas Müller" before "Thomas").
 *
 * Only applies in Shield mode — Vault mode uses [CATEGORY] markers
 * which are intentionally not reversed (user sees redacted output).
 */
export function rehydrate(
  text: string,
  sessionMap: PrivacySessionMap,
  mode: PrivacyMode
): RehydrationResult {
  const start = performance.now()

  // Only rehydrate in Shield mode (fake data → real data)
  // Vault mode keeps [CATEGORY] markers visible to user
  // Transparent mode had no replacements
  if (mode !== 'shield' || sessionMap.size === 0) {
    return {
      rehydratedText: text,
      replacementCount: 0,
      attempted: false,
      latencyMs: Math.round(performance.now() - start)
    }
  }

  // Get replacements sorted longest-first to avoid partial matches
  const replacements = sessionMap.getReplacementsSortedByLength()

  let result = text
  let count = 0

  for (const fakeValue of replacements) {
    const original = sessionMap.getOriginal(fakeValue)
    if (!original) continue

    // Case-insensitive search to handle LLM reformulations
    const escapedFake = escapeRegExp(fakeValue)
    const regex = new RegExp(escapedFake, 'gi')

    const before = result
    result = result.replace(regex, original)

    if (result !== before) {
      count++
    }
  }

  return {
    rehydratedText: result,
    replacementCount: count,
    attempted: true,
    latencyMs: Math.round(performance.now() - start)
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
