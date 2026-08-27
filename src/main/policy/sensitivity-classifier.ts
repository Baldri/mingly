/**
 * Turns PII findings plus the workspace's own data class into one protection
 * level.
 *
 * Invariant I3: the counts are kept per DetectionSource, not per category.
 * The same category arrives from layers with different reach and, in the web
 * deployment, a different processing location — ADDRESS comes from the Swiss
 * regex layer for Swiss forms and from NER for everything else. Collapsing
 * them would make the §4.4 privacy claim unprovable per request.
 */

import type { PIIEntity, PIISensitivity, DetectionSource } from '../privacy/pii-types'
import { maxSensitivity } from './policy-types'
import type { Classification } from './policy-types'

const EMPTY_BY_SOURCE: Record<DetectionSource, number> = {
  regex: 0,
  ner: 0,
  swiss: 0,
  custom: 0
}

export function classify(
  entities: PIIEntity[],
  workspaceClass: PIISensitivity
): Classification {
  const bySource: Record<DetectionSource, number> = { ...EMPTY_BY_SOURCE }
  for (const entity of entities) {
    bySource[entity.source] += 1
  }

  const findingLevel = maxSensitivity(entities.map((e) => e.sensitivity))
  const level = maxSensitivity([findingLevel, workspaceClass])

  const driver = entities.find((e) => e.sensitivity === level)
  const reason = driver
    ? `${driver.category} (${driver.source}) at ${level}`
    : `workspace class ${workspaceClass}`

  return { level, reason, bySource }
}
