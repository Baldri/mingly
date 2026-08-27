/**
 * Chains the residency policy onto the existing trust guard.
 *
 * Mingly already answered one routing question: is this provider TRUSTED
 * enough for this content? (DataClassifier, via GuardDeps.checkRouting.)
 * The policy core answers a second, independent one: does this provider sit
 * in an acceptable JURISDICTION?
 *
 * Both must pass. They are kept separate on purpose — the trust levels
 * distinguish providers the registry cannot (Google is treated as less
 * trustworthy than Anthropic, though both are `residency: 'US'`), and the
 * residency axis expresses something no trust level can. Folding either into
 * the other would silently drop a distinction the product currently makes.
 */

import { DataSensitivity } from '../security/data-classifier'
import type { RoutingDecision } from '../security/data-classifier'
import type { RegistryEntry } from '../routing/provider-registry'
import type { PIISensitivity } from '../privacy/pii-types'
import type { PolicySet } from './policy-types'
import { evaluate } from './policy-engine'

/**
 * The trust scale and the protection scale are both four ordered levels
 * meaning "how much care does this content need". They are mapped rather
 * than merged so each side keeps its own vocabulary.
 */
export const DATA_SENSITIVITY_TO_PII: Record<DataSensitivity, PIISensitivity> = {
  [DataSensitivity.PUBLIC]: 'low',
  [DataSensitivity.INTERNAL]: 'medium',
  [DataSensitivity.CONFIDENTIAL]: 'high',
  [DataSensitivity.RESTRICTED]: 'critical'
}

/**
 * Narrow a trust decision by the residency policy.
 *
 * `isTrusted` exists because guardDispatch switches to a `suggestedProvider`
 * WITHOUT re-running the trust guard. A suggestion made here must therefore
 * already satisfy it, or this function would become a way around the very
 * guard it is chained onto.
 *
 * A decision that is already blocked is returned untouched: it carries a
 * reason and a suggestion produced from evidence this function does not have.
 */
export function applyResidencyPolicy(
  trust: RoutingDecision,
  provider: string,
  candidates: RegistryEntry[],
  policy: PolicySet,
  isTrusted: (provider: string) => boolean
): RoutingDecision {
  if (!trust.allowed) return trust

  const level = DATA_SENSITIVITY_TO_PII[trust.classification.sensitivity]
  const decision = evaluate(
    policy,
    { level, reason: `trust level ${trust.classification.sensitivity}`, bySource: EMPTY_BY_SOURCE },
    candidates
  )

  if (decision.allowed.includes(provider)) return trust

  const alternative = decision.allowed.find(isTrusted)
  const permitted = decision.allowed.length > 0 ? decision.allowed.join(', ') : 'none'

  return {
    ...trust,
    allowed: false,
    suggestedProvider: alternative,
    reason:
      `Content at protection level "${level}" may not go to "${provider}": its residency is ` +
      `not permitted by policy ${decision.policyVersion}` +
      (decision.appliedRule ? ` (rule "${decision.appliedRule}")` : '') +
      `. Permitted providers: ${permitted}.`
  }
}

/**
 * This path derives its level from the trust classifier, which does not
 * report per-detector-layer counts. They stay zero here rather than being
 * invented — invariant I3 is carried by the policy core's own classifier,
 * not by this bridge.
 */
const EMPTY_BY_SOURCE = { regex: 0, ner: 0, swiss: 0, custom: 0 } as const
