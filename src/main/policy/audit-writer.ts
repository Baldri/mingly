/**
 * Writes one routing decision into activity_log.
 *
 * Never carries prompt or response text — the log is the document a customer
 * hands to a supervisory authority, so content in it would be the data
 * protection problem rather than its proof.
 */

import { getActivityLogger } from '../audit/activity-logger'
import type { PIISensitivity, DetectionSource } from '../privacy/pii-types'
import type { Residency } from '../../shared/provider-types'

export interface RoutingDecisionRecord {
  actorId: string
  conversationId: string
  level: PIISensitivity
  reason: string
  bySource: Record<DetectionSource, number>
  policyVersion: string
  appliedRule: string | null
  allowedProviders: string[]
  chosenProvider: string
  residency: Residency
  /** Optional: the model is only known once the caller has picked one. */
  model?: string
}

export function logRoutingDecision(record: RoutingDecisionRecord): void {
  getActivityLogger().log({
    actorType: 'user',
    actorId: record.actorId,
    action: 'routing.decision',
    entityType: 'conversation',
    entityId: record.conversationId,
    details: {
      level: record.level,
      reason: record.reason,
      bySource: record.bySource,
      policyVersion: record.policyVersion,
      appliedRule: record.appliedRule,
      allowedProviders: record.allowedProviders,
      chosenProvider: record.chosenProvider,
      residency: record.residency,
      model: record.model
    }
  })
}
