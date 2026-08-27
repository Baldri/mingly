/**
 * Evaluates a versioned rule set against one classification and returns the
 * providers the router may choose from.
 *
 * An empty result is a valid outcome and must stay one: falling back to "any
 * provider" when nothing qualifies would turn the strictest case into the
 * most permissive.
 */

import type { RegistryEntry } from '../routing/provider-registry'
import { atLeast, SENSITIVITY_ORDER } from './policy-types'
import type { Classification, PolicySet, PolicyDecision, PolicyRule } from './policy-types'

/**
 * The first rule set. One substantive rule plus the unknown-residency floor.
 * Rules are checked from the highest minSensitivity downward; the first match
 * wins, so ordering here is part of the definition.
 */
export const DEFAULT_POLICY: PolicySet = {
  version: '2026-08-26.1',
  rules: [
    {
      id: 'sensitive-stays-ch',
      minSensitivity: 'high',
      allowedResidency: ['CH']
    },
    {
      id: 'no-unverified-endpoints',
      minSensitivity: 'medium',
      allowedResidency: ['CH', 'EU', 'US']
    }
  ]
}

export function evaluate(
  policy: PolicySet,
  classification: Classification,
  candidates: RegistryEntry[]
): PolicyDecision {
  // Of the rules that apply, the one with the highest threshold wins — that
  // is the strictest. Never resolve this by list order or by counting
  // allowedResidency entries; both make the outcome depend on how the rule
  // set happens to be written.
  const rule = policy.rules
    .filter((candidate) => atLeast(classification.level, candidate.minSensitivity))
    .reduce<PolicyRule | null>(
      (strictest, current) =>
        strictest === null ||
        SENSITIVITY_ORDER[current.minSensitivity] > SENSITIVITY_ORDER[strictest.minSensitivity]
          ? current
          : strictest,
      null
    )

  if (!rule) {
    return {
      allowed: candidates.map((c) => c.config.id),
      appliedRule: null,
      policyVersion: policy.version
    }
  }

  return {
    allowed: candidates
      .filter((c) => rule.allowedResidency.includes(c.origin.residency))
      .map((c) => c.config.id),
    appliedRule: rule.id,
    policyVersion: policy.version
  }
}
