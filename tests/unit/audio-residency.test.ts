import { describe, it, expect } from 'vitest'
import { DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import type { PolicySet } from '../../src/main/policy/policy-types'
import type { PIISensitivity } from '../../src/main/privacy/pii-types'
import { resolveTarget } from '../../src/main/transcription/audio-residency'
import { TRANSCRIPTION_TARGETS } from '../../src/main/transcription/transcription-targets'

/** Whatever the level, only a US target qualifies. Neither declared target is one. */
const POLICY_NUR_US: PolicySet = {
  version: 'test-us-only.1',
  rules: [{ id: 'us-only', minSensitivity: 'low', allowedResidency: ['US'] }]
}

/**
 * Differs from DEFAULT_POLICY exactly where the difference can be observed:
 * at `critical` the on-device target is NOT permitted, below it every target is.
 *
 * Under DEFAULT_POLICY both `low` and `critical` resolve to 'local', so a test
 * against it alone cannot tell a fallback to `critical` from one to `low`.
 */
const POLICY_CRITICAL_NUR_CH: PolicySet = {
  version: 'test-critical-ch-only.1',
  rules: [{ id: 'critical-ch-only', minSensitivity: 'critical', allowedResidency: ['CH'] }]
}

/** The reason of a refusal; fails loudly if the call was permitted instead. */
function refusalReason(res: ReturnType<typeof resolveTarget>): string {
  if (res.allowed) throw new Error(`expected a refusal, got target "${res.targetId}"`)
  return res.reason
}

describe('resolveTarget', () => {
  it('erlaubt das lokale Ziel fuer critical', () => {
    expect(resolveTarget('critical', DEFAULT_POLICY)).toEqual({ allowed: true, targetId: 'local' })
  })

  it('faellt ohne erklaerte Stufe auf critical, nicht auf low', () => {
    // Review-Focus 2: Voreinstellung auf der strengen Seite
    expect(resolveTarget(undefined, DEFAULT_POLICY)).toEqual({ allowed: true, targetId: 'local' })
  })

  it('faellt ohne erklaerte Stufe auf critical: nur dort schliesst die Policy das lokale Ziel aus', () => {
    // Control: a declared `low` is not narrowed, so the policy really does
    // distinguish the two levels. Without this the next two lines prove nothing.
    expect(resolveTarget('low', POLICY_CRITICAL_NUR_CH)).toEqual({
      allowed: true,
      targetId: 'local'
    })
    expect(resolveTarget('critical', POLICY_CRITICAL_NUR_CH)).toEqual({
      allowed: true,
      targetId: 'ch-endpoint'
    })
    expect(resolveTarget(undefined, POLICY_CRITICAL_NUR_CH)).toEqual({
      allowed: true,
      targetId: 'ch-endpoint'
    })
  })

  // A stored workspace setting arrives as NULL or free text, not as a typed
  // level. The policy core treats any level it does not know as "no rule
  // applies" and permits every candidate, so these must not reach it as-is.
  it.each([
    ['null', null],
    ['die Schreibweise CRITICAL', 'CRITICAL'],
    ['den Wert secret', 'secret'],
    ['eine leere Zeichenkette', '']
  ])('behandelt %s wie eine fehlende Stufe', (_label, stored) => {
    expect(resolveTarget(stored as unknown as PIISensitivity, POLICY_CRITICAL_NUR_CH)).toEqual({
      allowed: true,
      targetId: 'ch-endpoint'
    })
  })

  it('nennt bei verbotenem Ziel einen Grund mit Policy-Version', () => {
    const res = resolveTarget('critical', POLICY_NUR_US)
    expect(res.allowed).toBe(false)
    expect(refusalReason(res)).toContain(POLICY_NUR_US.version)
  })

  it('nennt in der Absage Stufe, Herkunft der Stufe und angewandte Regel', () => {
    const reason = refusalReason(resolveTarget('high', POLICY_NUR_US))
    expect(reason).toContain('"high"')
    expect(reason).toContain('declared by workspace')
    expect(reason).toContain('"us-only"')
  })

  it('sagt in der Absage, dass die Stufe nicht erklaert war und als critical gilt', () => {
    const reason = refusalReason(resolveTarget(undefined, POLICY_NUR_US))
    expect(reason).toContain('"critical"')
    expect(reason).toContain('no valid level declared')
  })
})

describe('TRANSCRIPTION_TARGETS', () => {
  it('deklariert das lokale Ziel als on-device und den Endpunkt als CH', () => {
    // These two claims are the product's residency promise. They are ours to
    // make (I2): nothing a workspace stores may change them.
    const residencyById = Object.fromEntries(
      TRANSCRIPTION_TARGETS.map((target) => [target.config.id, target.origin.residency])
    )
    expect(residencyById).toEqual({ local: 'on-device', 'ch-endpoint': 'CH' })
  })
})
