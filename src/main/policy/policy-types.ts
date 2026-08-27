/**
 * Policy vocabulary.
 *
 * The sensitivity scale is PIISensitivity — deliberately reused rather than
 * duplicated, so a PII finding and a workspace class are comparable without
 * a translation table that could drift.
 */

import type { PIISensitivity, DetectionSource } from '../privacy/pii-types'
import type { Residency } from '../../shared/provider-types'

/** Rank of each level. Only meaningful through atLeast/maxSensitivity. */
export const SENSITIVITY_ORDER: Record<PIISensitivity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
}

/** True when `level` reaches or exceeds `threshold`. */
export function atLeast(level: PIISensitivity, threshold: PIISensitivity): boolean {
  return SENSITIVITY_ORDER[level] >= SENSITIVITY_ORDER[threshold]
}

/** Highest level in the list; `low` when the list is empty. */
export function maxSensitivity(levels: PIISensitivity[]): PIISensitivity {
  return levels.reduce<PIISensitivity>(
    (highest, current) =>
      SENSITIVITY_ORDER[current] > SENSITIVITY_ORDER[highest] ? current : highest,
    'low'
  )
}

/** Result of classifying one request. */
export interface Classification {
  /** Protection level driving the policy decision. */
  level: PIISensitivity
  /** Why this level — for the audit entry, never for the user-facing text. */
  reason: string
  /**
   * Hit counts per detector layer (I3). Carries where each finding was
   * replaced, which the category alone cannot express.
   */
  bySource: Record<DetectionSource, number>
}

/** One declarative rule. Rules are evaluated most-specific-first. */
export interface PolicyRule {
  id: string
  /** Rule applies from this level upward. */
  minSensitivity: PIISensitivity
  /** Residencies permitted at that level. */
  allowedResidency: Residency[]
}

/** A versioned rule set. The version travels into every audit entry. */
export interface PolicySet {
  version: string
  rules: PolicyRule[]
}

/** Outcome of evaluating a policy set against one classification. */
export interface PolicyDecision {
  /** Provider ids the router may choose from. Possibly empty. */
  allowed: string[]
  /** Id of the rule that narrowed the set, or null when none applied. */
  appliedRule: string | null
  policyVersion: string
}
