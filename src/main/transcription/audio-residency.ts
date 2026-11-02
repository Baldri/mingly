/**
 * Declared residency for audio.
 *
 * Mingly's request guard works on text. An audio file has none, and the
 * classification that would decide where it may go needs the transcript that
 * only the destination produces. So for audio the protection level is
 * DECLARED — a workspace setting — rather than classified from content.
 *
 * This is the bridge: the declared level goes in as a `Classification`, the
 * UNCHANGED policy core evaluates it over the transcription targets, and a
 * permitted target comes out. Only the finished transcript then takes the
 * normal content-based route.
 */

import { evaluate } from '../policy/policy-engine'
import { SENSITIVITY_ORDER } from '../policy/policy-types'
import type { Classification, PolicySet } from '../policy/policy-types'
import type { PIISensitivity } from '../privacy/pii-types'
import { TRANSCRIPTION_TARGETS } from './transcription-targets'

export type TargetResolution =
  | { allowed: true; targetId: string }
  | { allowed: false; reason: string }

/**
 * Level assumed for a workspace that has declared none. The default sits on
 * the strict side: a missing declaration must narrow where audio may go, not
 * widen it.
 */
const UNDECLARED_LEVEL: PIISensitivity = 'critical'

/**
 * The level is declared, not detected, so no detector layer ran and none
 * reports a hit. They stay zero rather than being invented, as in
 * residency-guard.ts for levels it derives.
 */
const NO_DETECTOR_HITS: Classification['bySource'] = { regex: 0, ner: 0, swiss: 0, custom: 0 }

/**
 * A workspace setting reaches us as stored data — NULL, or free text — not
 * as a typed level, and the policy core treats a level it does not know as
 * "no rule applies" and permits every candidate. Measured on 2026-10-25:
 * `evaluate` with 'CRITICAL', 'foo' or null returns all candidates, with
 * `appliedRule: null`. Such a value must never reach it.
 */
function isProtectionLevel(value: unknown): value is PIISensitivity {
  return typeof value === 'string' && Object.keys(SENSITIVITY_ORDER).includes(value)
}

/**
 * Pick the transcription target a workspace's declared level permits.
 *
 * Targets are tried in the order of TRANSCRIPTION_TARGETS and the first one
 * the policy permits wins. No permitted target is a refusal, never a fallback
 * to "any target" — that would turn the strictest case into the most
 * permissive one.
 */
export function resolveTarget(
  declaredLevel: PIISensitivity | undefined,
  policy: PolicySet
): TargetResolution {
  const classification: Classification = isProtectionLevel(declaredLevel)
    ? { level: declaredLevel, reason: 'declared by workspace', bySource: NO_DETECTOR_HITS }
    : {
        level: UNDECLARED_LEVEL,
        reason: `no valid level declared by workspace, treated as ${UNDECLARED_LEVEL}`,
        bySource: NO_DETECTOR_HITS
      }

  const decision = evaluate(policy, classification, TRANSCRIPTION_TARGETS)

  const [targetId] = decision.allowed
  if (targetId !== undefined) return { allowed: true, targetId }

  return {
    allowed: false,
    reason:
      `Audio at protection level "${classification.level}" (${classification.reason}) cannot be ` +
      `transcribed: no transcription target is permitted by policy ${decision.policyVersion}` +
      (decision.appliedRule ? ` (rule "${decision.appliedRule}")` : '') +
      '.'
  }
}
