# CH-Gateway: Policy-Kern — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mingly routet nach Schutzbedarf statt nur nach Aufgabentyp — eine Policy entscheidet, welche Anbieter eine Anfrage ueberhaupt bearbeiten duerfen, der bestehende Router waehlt innerhalb dieser Menge, und jede Entscheidung landet nachweisbar im Audit-Log.

**Architecture:** Vier neue Einheiten unter `src/main/policy/` plus eine Provider-Registry unter `src/main/routing/`. Die Registry traegt die Herkunft eines Endpunkts (Land, Betreiber, Lizenz, Hosting-Art, Auftragsverarbeitung) und seine Faehigkeiten; der Klassifikator leitet aus den vorhandenen PII-Befunden und der Arbeitsbereichsklasse einen Schutzbedarf ab; die Policy-Engine filtert die Anbietermenge; der bestehende `IntelligentRouter` waehlt darin. Kein Modell, keine neue Laufzeit — reine Regellogik.

**Tech Stack:** TypeScript (strict), Vitest 4, Electron-Hauptprozess. Keine neuen Abhaengigkeiten.

**Spec:** `docs/superpowers/specs/2026-08-26-ch-gateway-design.md`

## Global Constraints

- **Invariante I1 (Reihenfolge):** Policy filtert zuerst, der Router waehlt innerhalb der zulaessigen Menge. Der Router darf nie einen Anbieter sehen, den die Policy ausgeschlossen hat. Spec §4.2.
- **Invariante I2 (Residenz):** `residency` wird von uns gesetzt, nie vom Mandanten. Mandantenseitig eingetragene Endpunkte erhalten zwingend `residency: 'unknown'`. Spec §4.2.
- **Invariante I3 (Herkunftsschicht):** Die Detektorschicht (`PIIEntity.source`) ist Teil des Befunds. Trefferzahlen werden je `source` gefuehrt, nicht nur je Kategorie. Spec §4.2.
- **Audit ohne Inhalte.** Nie Prompt- oder Antworttext ins Log. Spec §4.7.
- **Kein `any`.** TypeScript strict, camelCase fuer Werte, PascalCase fuer Typen.
- **Bestehende Typen wiederverwenden.** `PIISensitivity` (`src/main/privacy/pii-types.ts:25`) ist die Schutzbedarfsskala; kein Parallel-Typ.
- **Testbefehl fuer eine Datei:** `npm test -- tests/unit/<name>.test.ts`. Gesamtlauf: `npm test`.
- **Voraussetzung im frischen Worktree:** `npm run prebuild:main` einmal ausfuehren, sonst schlagen Typecheck und `license-activation.test.ts` mangels `_license-secret.ts` fehl.
- **Conventional Commits**, Feature-Branch, kein Push auf main.

---

## File Structure

**Neu:**

| Datei | Verantwortung |
|---|---|
| `src/main/policy/policy-types.ts` | Typen und Ordnungsrelation fuer Schutzbedarf, Policy-Regeln, Entscheide |
| `src/main/policy/sensitivity-classifier.ts` | PII-Befunde + Arbeitsbereichsklasse → Schutzbedarf, mit Trefferzahlen je `source` |
| `src/main/policy/policy-engine.ts` | Regelsatz auswerten → zulaessige Anbietermenge |
| `src/main/policy/audit-writer.ts` | Routing-Entscheid ins `activity_log`, ohne Inhalte |
| `src/main/routing/provider-registry.ts` | Anbieter mit Herkunft und Faehigkeiten; erzwingt I2 |

**Geaendert:**

| Datei | Aenderung |
|---|---|
| `src/shared/provider-types.ts` | `ProviderOrigin`, `ProviderCapabilities`, Erweiterung von `ProviderConfig` |
| `src/main/routing/intelligent-router.ts` | Faehigkeiten aus der Registry statt hart verdrahtet; `selectProvider` ohne `\|\| 0.5`-Fallback |
| `src/main/services/service-layer.ts` | Verdrahtung: klassifizieren → Policy → Router |

**Tests:** je Einheit eine Datei unter `tests/unit/`, plus `tests/unit/policy-invariants.test.ts` fuer I1–I3.

---

## Task 1: Herkunftstypen und Provider-Registry

**Files:**
- Modify: `src/shared/provider-types.ts`
- Create: `src/main/routing/provider-registry.ts`
- Test: `tests/unit/provider-registry.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` aus `src/shared/provider-types.ts`
- Produces: `Residency`, `HostingMode`, `WeightsLicense`, `DpaStatus`, `ProviderOrigin`, `ProviderCapabilities`, `RegistryEntry`, `ProviderRegistry` mit `registerVerified(config, origin, capabilities)`, `registerTenant(config)`, `get(id): RegistryEntry | undefined`, `all(): RegistryEntry[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/provider-registry.test.ts
/**
 * ProviderRegistry Tests
 * Deckt Invariante I2 ab: Residenz setzen wir, nie der Mandant.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ProviderRegistry } from '../../src/main/routing/provider-registry'
import type { ProviderConfig } from '../../src/shared/provider-types'

const chConfig: ProviderConfig = {
  id: 'infomaniak',
  name: 'Infomaniak AI Tools',
  type: 'custom',
  apiBase: 'https://api.infomaniak.com/1/ai/v1',
  apiKeyRequired: true,
  supportsStreaming: true,
  models: [{ id: 'apertus', name: 'Apertus' }]
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
  })

  it('keeps the origin we declare for a verified provider', () => {
    registry.registerVerified(
      chConfig,
      {
        residency: 'CH',
        operator: 'Infomaniak SA',
        weightsLicense: 'open',
        hostingMode: 'rented',
        dpaStatus: 'signed'
      },
      { code: 0.7, creative: 0.6, analysis: 0.7, conversation: 0.7 }
    )

    expect(registry.get('infomaniak')?.origin.residency).toBe('CH')
    expect(registry.get('infomaniak')?.origin.operator).toBe('Infomaniak SA')
  })

  it('forces residency to unknown for a tenant-registered provider (I2)', () => {
    registry.registerTenant({ ...chConfig, id: 'tenant-endpoint' })

    const entry = registry.get('tenant-endpoint')
    expect(entry?.origin.residency).toBe('unknown')
    expect(entry?.origin.dpaStatus).toBe('none')
  })

  it('cannot be tricked by a tenant config that claims CH residency (I2)', () => {
    const claiming = { ...chConfig, id: 'liar' } as ProviderConfig & {
      origin: { residency: string }
    }
    claiming.origin = { residency: 'CH' }

    registry.registerTenant(claiming)

    expect(registry.get('liar')?.origin.residency).toBe('unknown')
  })

  it('returns undefined for an unregistered id', () => {
    expect(registry.get('nope')).toBeUndefined()
  })

  it('lists every registered entry', () => {
    registry.registerTenant({ ...chConfig, id: 'a' })
    registry.registerTenant({ ...chConfig, id: 'b' })

    expect(registry.all().map((e) => e.config.id).sort()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/provider-registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/routing/provider-registry'`

- [ ] **Step 3: Add the origin types**

Am Ende von `src/shared/provider-types.ts` anfuegen:

```typescript
/** Where a provider's inference physically runs. Set by us, never by a tenant (I2). */
export type Residency = 'CH' | 'EU' | 'US' | 'unknown'

/** How the endpoint is operated. */
export type HostingMode = 'rented' | 'self-hosted' | 'local'

/** Whether the model weights are openly licensed. */
export type WeightsLicense = 'open' | 'closed'

/** State of the data processing agreement covering this endpoint. */
export type DpaStatus = 'signed' | 'byok-tenant' | 'none'

/** Origin of a provider — the axis the policy engine decides on. */
export interface ProviderOrigin {
  residency: Residency
  operator: string
  weightsLicense: WeightsLicense
  hostingMode: HostingMode
  dpaStatus: DpaStatus
}

/** Task-fitness scores, 0..1. Read from the registry, never hardwired. */
export interface ProviderCapabilities {
  code: number
  creative: number
  analysis: number
  conversation: number
}
```

- [ ] **Step 4: Write the registry**

```typescript
// src/main/routing/provider-registry.ts
/**
 * ProviderRegistry — providers with their origin and task fitness.
 *
 * Invariant I2: residency is ours to declare. A tenant may register an
 * endpoint, but never its origin — registerTenant overwrites whatever the
 * config claims. Without that, one mislabelled endpoint defeats the whole
 * residency promise while the audit trail records the breach as compliant.
 */

import type {
  ProviderConfig,
  ProviderOrigin,
  ProviderCapabilities
} from '../../shared/provider-types'

export interface RegistryEntry {
  config: ProviderConfig
  origin: ProviderOrigin
  capabilities: ProviderCapabilities
}

/** Fitness assumed for an endpoint we have not measured. */
const UNMEASURED_CAPABILITIES: ProviderCapabilities = {
  code: 0.5,
  creative: 0.5,
  analysis: 0.5,
  conversation: 0.5
}

/** Origin forced onto anything a tenant registers itself. */
const TENANT_ORIGIN: ProviderOrigin = {
  residency: 'unknown',
  operator: 'tenant-supplied',
  weightsLicense: 'closed',
  hostingMode: 'rented',
  dpaStatus: 'none'
}

export class ProviderRegistry {
  private entries: Map<string, RegistryEntry> = new Map()

  /** Register a provider whose origin we have verified ourselves. */
  registerVerified(
    config: ProviderConfig,
    origin: ProviderOrigin,
    capabilities: ProviderCapabilities
  ): void {
    this.entries.set(config.id, { config, origin, capabilities })
  }

  /**
   * Register a tenant-supplied endpoint. Origin is forced (I2) — any origin
   * on the incoming config is discarded, not merged.
   */
  registerTenant(config: ProviderConfig): void {
    this.entries.set(config.id, {
      config,
      origin: { ...TENANT_ORIGIN },
      capabilities: { ...UNMEASURED_CAPABILITIES }
    })
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id)
  }

  all(): RegistryEntry[] {
    return Array.from(this.entries.values())
  }
}

let registryInstance: ProviderRegistry | null = null

export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry()
  }
  return registryInstance
}

/** Test seam — reset the singleton between test cases. */
export function setProviderRegistry(registry: ProviderRegistry | null): void {
  registryInstance = registry
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/unit/provider-registry.test.ts`
Expected: PASS, 5 Tests

- [ ] **Step 6: Commit**

```bash
git add src/shared/provider-types.ts src/main/routing/provider-registry.ts tests/unit/provider-registry.test.ts
git commit -m "feat(routing): add provider registry with declared origin

Residency, operator, weights licence, hosting mode and DPA status become
properties of a provider. registerTenant forces residency to unknown so a
tenant-supplied endpoint cannot claim Swiss processing (invariant I2)."
```

---

## Task 2: Schutzbedarf-Typen und Ordnungsrelation

**Files:**
- Create: `src/main/policy/policy-types.ts`
- Test: `tests/unit/policy-types.test.ts`

**Interfaces:**
- Consumes: `PIISensitivity` aus `src/main/privacy/pii-types.ts`, `Residency` aus `src/shared/provider-types.ts`
- Produces: `SENSITIVITY_ORDER`, `atLeast(a, b): boolean`, `maxSensitivity(levels): PIISensitivity`, `PolicyRule`, `PolicySet`, `PolicyDecision`, `Classification`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/policy-types.test.ts
import { describe, it, expect } from 'vitest'
import { atLeast, maxSensitivity, SENSITIVITY_ORDER } from '../../src/main/policy/policy-types'

describe('sensitivity ordering', () => {
  it('orders low < medium < high < critical', () => {
    expect(SENSITIVITY_ORDER.low).toBeLessThan(SENSITIVITY_ORDER.medium)
    expect(SENSITIVITY_ORDER.medium).toBeLessThan(SENSITIVITY_ORDER.high)
    expect(SENSITIVITY_ORDER.high).toBeLessThan(SENSITIVITY_ORDER.critical)
  })

  it('atLeast is true when the first level reaches the threshold', () => {
    expect(atLeast('high', 'high')).toBe(true)
    expect(atLeast('critical', 'high')).toBe(true)
  })

  it('atLeast is false below the threshold', () => {
    expect(atLeast('medium', 'high')).toBe(false)
    expect(atLeast('low', 'medium')).toBe(false)
  })

  it('maxSensitivity returns the highest level present', () => {
    expect(maxSensitivity(['low', 'critical', 'medium'])).toBe('critical')
    expect(maxSensitivity(['low', 'medium'])).toBe('medium')
  })

  it('maxSensitivity returns low for an empty list', () => {
    expect(maxSensitivity([])).toBe('low')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/policy-types.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/policy/policy-types'`

- [ ] **Step 3: Write the types**

```typescript
// src/main/policy/policy-types.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/policy-types.test.ts`
Expected: PASS, 5 Tests

- [ ] **Step 5: Commit**

```bash
git add src/main/policy/policy-types.ts tests/unit/policy-types.test.ts
git commit -m "feat(policy): add sensitivity ordering and policy vocabulary

Reuses PIISensitivity as the scale so a PII finding and a workspace class
compare without a translation table that could drift."
```

---

## Task 3: Sensitivitaets-Klassifikator

**Files:**
- Create: `src/main/policy/sensitivity-classifier.ts`
- Test: `tests/unit/sensitivity-classifier.test.ts`

**Interfaces:**
- Consumes: `PIIEntity`, `DetectionSource` aus `src/main/privacy/pii-types.ts`; `maxSensitivity`, `Classification` aus Task 2
- Produces: `classify(entities: PIIEntity[], workspaceClass: PIISensitivity): Classification`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sensitivity-classifier.test.ts
/**
 * Deckt Invariante I3 ab: Trefferzahlen je Detektorschicht, nicht nur je Kategorie.
 */

import { describe, it, expect } from 'vitest'
import { classify } from '../../src/main/policy/sensitivity-classifier'
import type { PIIEntity } from '../../src/main/privacy/pii-types'

function entity(partial: Partial<PIIEntity>): PIIEntity {
  return {
    category: 'PERSON',
    original: 'Muster',
    start: 0,
    end: 6,
    confidence: 1,
    source: 'ner',
    sensitivity: 'high',
    ...partial
  }
}

describe('classify', () => {
  it('takes the highest entity sensitivity when it exceeds the workspace class', () => {
    const result = classify([entity({ sensitivity: 'critical', category: 'AHV' })], 'low')
    expect(result.level).toBe('critical')
  })

  it('takes the workspace class when no finding exceeds it', () => {
    const result = classify([entity({ sensitivity: 'medium' })], 'high')
    expect(result.level).toBe('high')
  })

  it('returns the workspace class when nothing was found', () => {
    const result = classify([], 'medium')
    expect(result.level).toBe('medium')
  })

  it('counts hits per detector source (I3)', () => {
    const result = classify(
      [
        entity({ source: 'swiss', category: 'AHV', sensitivity: 'critical' }),
        entity({ source: 'swiss', category: 'ADDRESS', sensitivity: 'medium' }),
        entity({ source: 'regex', category: 'EMAIL', sensitivity: 'high' }),
        entity({ source: 'ner', category: 'PERSON', sensitivity: 'high' })
      ],
      'low'
    )

    expect(result.bySource).toEqual({ regex: 1, swiss: 2, ner: 1, custom: 0 })
  })

  it('distinguishes the same category coming from two layers (I3)', () => {
    const result = classify(
      [
        entity({ source: 'swiss', category: 'ADDRESS', sensitivity: 'medium' }),
        entity({ source: 'ner', category: 'ADDRESS', sensitivity: 'medium' })
      ],
      'low'
    )

    expect(result.bySource.swiss).toBe(1)
    expect(result.bySource.ner).toBe(1)
  })

  it('states the reason for the audit entry', () => {
    const result = classify([entity({ sensitivity: 'critical', category: 'AHV' })], 'low')
    expect(result.reason).toContain('AHV')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/sensitivity-classifier.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/policy/sensitivity-classifier'`

- [ ] **Step 3: Write the classifier**

```typescript
// src/main/policy/sensitivity-classifier.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/sensitivity-classifier.test.ts`
Expected: PASS, 6 Tests

- [ ] **Step 5: Commit**

```bash
git add src/main/policy/sensitivity-classifier.ts tests/unit/sensitivity-classifier.test.ts
git commit -m "feat(policy): derive protection level from PII findings and workspace class

Counts hits per DetectionSource rather than per category (invariant I3):
the same category reaches us from layers with different reach and different
processing location."
```

---

## Task 4: Policy-Engine

**Files:**
- Create: `src/main/policy/policy-engine.ts`
- Test: `tests/unit/policy-engine.test.ts`

**Interfaces:**
- Consumes: `RegistryEntry` aus Task 1; `Classification`, `PolicySet`, `PolicyDecision`, `atLeast` aus Task 2
- Produces: `evaluate(policy: PolicySet, classification: Classification, candidates: RegistryEntry[]): PolicyDecision`, `DEFAULT_POLICY: PolicySet`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/policy-engine.test.ts
import { describe, it, expect } from 'vitest'
import { evaluate, DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import type { RegistryEntry } from '../../src/main/routing/provider-registry'
import type { Classification } from '../../src/main/policy/policy-types'
import type { Residency } from '../../src/shared/provider-types'

function candidate(id: string, residency: Residency): RegistryEntry {
  return {
    config: {
      id,
      name: id,
      type: 'custom',
      apiKeyRequired: true,
      supportsStreaming: true,
      models: []
    },
    origin: {
      residency,
      operator: 'test',
      weightsLicense: 'open',
      hostingMode: 'rented',
      dpaStatus: 'signed'
    },
    capabilities: { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
  }
}

function classification(level: Classification['level']): Classification {
  return {
    level,
    reason: 'test',
    bySource: { regex: 0, ner: 0, swiss: 0, custom: 0 }
  }
}

const CANDIDATES = [
  candidate('infomaniak', 'CH'),
  candidate('anthropic', 'US'),
  candidate('tenant', 'unknown')
]

describe('evaluate', () => {
  it('restricts a high-sensitivity request to Swiss endpoints', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('high'), CANDIDATES)
    expect(decision.allowed).toEqual(['infomaniak'])
  })

  it('restricts a critical request to Swiss endpoints too', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('critical'), CANDIDATES)
    expect(decision.allowed).toEqual(['infomaniak'])
  })

  it('excludes unknown residency above the lowest level (I2)', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('medium'), CANDIDATES)
    expect(decision.allowed).not.toContain('tenant')
  })

  it('permits every verified residency at the lowest level', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('low'), CANDIDATES)
    expect(decision.allowed).toContain('infomaniak')
    expect(decision.allowed).toContain('anthropic')
  })

  it('names the rule that applied', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('high'), CANDIDATES)
    expect(decision.appliedRule).toBe('sensitive-stays-ch')
  })

  it('carries the policy version into the decision', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('low'), CANDIDATES)
    expect(decision.policyVersion).toBe(DEFAULT_POLICY.version)
  })

  it('returns an empty set rather than falling back when nothing qualifies', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('critical'), [
      candidate('anthropic', 'US')
    ])
    expect(decision.allowed).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/policy-engine.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/policy/policy-engine'`

- [ ] **Step 3: Write the engine**

```typescript
// src/main/policy/policy-engine.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/policy-engine.test.ts`
Expected: PASS, 7 Tests

- [ ] **Step 5: Commit**

```bash
git add src/main/policy/policy-engine.ts tests/unit/policy-engine.test.ts
git commit -m "feat(policy): evaluate a versioned rule set into a permitted provider set

An empty permitted set stays empty — falling back to any provider would turn
the strictest case into the most permissive one."
```

---

## Task 5: Router liest Faehigkeiten aus der Registry

**Files:**
- Modify: `src/main/routing/intelligent-router.ts`
- Test: `tests/unit/intelligent-router.test.ts` (bestehend, erweitern)

**Interfaces:**
- Consumes: `getProviderRegistry` aus Task 1
- Produces: `IntelligentRouter.selectProvider` waehlt nur aus uebergebenen Ids und bewertet ueber `RegistryEntry.capabilities`

- [ ] **Step 1: Write the failing test**

An `tests/unit/intelligent-router.test.ts` anfuegen:

```typescript
describe('capabilities from the registry', () => {
  it('scores a registered custom provider by its declared capabilities', async () => {
    const registry = new ProviderRegistry()
    registry.registerVerified(
      {
        id: 'infomaniak',
        name: 'Infomaniak',
        type: 'custom',
        apiBase: 'https://example.invalid/v1',
        apiKeyRequired: true,
        supportsStreaming: true,
        models: []
      },
      {
        residency: 'CH',
        operator: 'Infomaniak SA',
        weightsLicense: 'open',
        hostingMode: 'rented',
        dpaStatus: 'signed'
      },
      { code: 0.95, creative: 0.2, analysis: 0.4, conversation: 0.4 }
    )
    registry.registerVerified(
      {
        id: 'other',
        name: 'Other',
        type: 'custom',
        apiBase: 'https://example.invalid/v2',
        apiKeyRequired: true,
        supportsStreaming: true,
        models: []
      },
      {
        residency: 'CH',
        operator: 'Other',
        weightsLicense: 'open',
        hostingMode: 'rented',
        dpaStatus: 'signed'
      },
      { code: 0.1, creative: 0.9, analysis: 0.4, conversation: 0.4 }
    )
    setProviderRegistry(registry)

    const router = new IntelligentRouter()
    const result = await router.route('Bitte diese Funktion refactoren und den Bug fixen', [
      'infomaniak',
      'other'
    ])

    expect(result.suggestedProvider).toBe('infomaniak')
    setProviderRegistry(null)
  })
})
```

Am Kopf derselben Datei ergaenzen:

```typescript
import { ProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/intelligent-router.test.ts`
Expected: FAIL — `infomaniak` und `other` erhalten beide `0.5` aus dem Fallback, die Auswahl ist willkuerlich

- [ ] **Step 3: Replace the hardwired capability table**

In `src/main/routing/intelligent-router.ts`: `PROVIDER_CAPABILITIES` loeschen und `selectProvider` ersetzen durch:

```typescript
  /**
   * Select the best provider from an already-permitted set.
   *
   * The caller has run the policy first (invariant I1) — this method must
   * never widen the set it was handed. Capabilities come from the registry,
   * so adding a European model is a registry entry, not a code change.
   */
  private selectProvider(
    category: RequestCategory,
    availableProviders: LLMProvider[],
    method: string
  ): RoutingResult {
    if (availableProviders.length === 0) {
      return {
        category,
        suggestedProvider: '',
        confidence: 0,
        reasoning: `No provider permitted for this request (classified as: ${category} via ${method})`
      }
    }

    if (availableProviders.length === 1) {
      return {
        category,
        suggestedProvider: availableProviders[0],
        confidence: 0.5,
        reasoning: `Only permitted provider (classified as: ${category} via ${method})`
      }
    }

    const registry = getProviderRegistry()
    const key = category === 'general' ? 'conversation' : category

    const scores = availableProviders.map((provider) => ({
      provider,
      score: registry.get(provider)?.capabilities[key] ?? 0
    }))

    scores.sort((a, b) => b.score - a.score)
    const best = scores[0]

    return {
      category,
      suggestedProvider: best.provider,
      confidence: best.score,
      reasoning: `Best permitted provider for ${category} (classified via ${method})`
    }
  }
```

Import am Dateikopf ergaenzen:

```typescript
import { getProviderRegistry } from './provider-registry'
```

- [ ] **Step 4: Seed the built-in providers into the registry**

In `src/main/routing/provider-registry.ts` anfuegen und in `getProviderRegistry()` beim ersten Aufruf ausfuehren:

```typescript
/** Origin and measured fitness of the providers we ship with. */
export function seedBuiltInProviders(registry: ProviderRegistry): void {
  const closedUs = {
    weightsLicense: 'closed' as const,
    hostingMode: 'rented' as const,
    dpaStatus: 'signed' as const,
    residency: 'US' as const
  }

  registry.registerVerified(
    BUILT_IN_PROVIDERS.anthropic,
    { ...closedUs, operator: 'Anthropic PBC' },
    { code: 0.95, creative: 0.85, analysis: 0.9, conversation: 0.95 }
  )
  registry.registerVerified(
    BUILT_IN_PROVIDERS.openai,
    { ...closedUs, operator: 'OpenAI' },
    { code: 0.85, creative: 0.95, analysis: 0.85, conversation: 0.9 }
  )
  registry.registerVerified(
    BUILT_IN_PROVIDERS.google,
    { ...closedUs, operator: 'Google LLC' },
    { code: 0.8, creative: 0.75, analysis: 0.95, conversation: 0.8 }
  )
  registry.registerVerified(
    BUILT_IN_PROVIDERS.ollama,
    {
      residency: 'CH',
      operator: 'on-device',
      weightsLicense: 'open',
      hostingMode: 'local',
      dpaStatus: 'signed'
    },
    { code: 0.6, creative: 0.6, analysis: 0.6, conversation: 0.65 }
  )
}
```

Import ergaenzen: `import { BUILT_IN_PROVIDERS } from '../../shared/provider-types'`

Und `getProviderRegistry()` anpassen:

```typescript
export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry()
    seedBuiltInProviders(registryInstance)
  }
  return registryInstance
}
```

**Hinweis zur `ollama`-Residenz:** lokale Ausfuehrung auf dem Geraet des Nutzers ist der strengste Fall, nicht ein Sonderfall — sie erfuellt jede Residenzanforderung. `hostingMode: 'local'` haelt den Unterschied fest, damit ein spaeterer Bericht «CH-Endpunkt» und «auf dem Geraet» nicht vermischt.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/unit/intelligent-router.test.ts`
Expected: PASS, alle bestehenden Tests plus der neue

- [ ] **Step 6: Commit**

```bash
git add src/main/routing/intelligent-router.ts src/main/routing/provider-registry.ts tests/unit/intelligent-router.test.ts
git commit -m "refactor(routing): read provider capabilities from the registry

PROVIDER_CAPABILITIES was hardwired to anthropic/openai/google and every
other provider fell back to 0.5 — a Swiss endpoint was a provider without
properties. Adding a European model is now a registry entry, not a code
change. An empty permitted set no longer resolves to a provider."
```

---

## Task 6: Audit-Schreiber

**Files:**
- Create: `src/main/policy/audit-writer.ts`
- Test: `tests/unit/policy-audit-writer.test.ts`

**Interfaces:**
- Consumes: `getActivityLogger` aus `src/main/audit/activity-logger`; `Classification`, `PolicyDecision` aus Task 2
- Produces: `logRoutingDecision(record: RoutingDecisionRecord): void`, `RoutingDecisionRecord`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/policy-audit-writer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn()
}))

import { logRoutingDecision } from '../../src/main/policy/audit-writer'
import { dbRun } from '../../src/main/database/index'

describe('logRoutingDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a routing.decision row', () => {
    logRoutingDecision({
      actorId: 'local',
      conversationId: 'conv_1',
      level: 'critical',
      reason: 'AHV (swiss) at critical',
      bySource: { regex: 1, swiss: 2, ner: 0, custom: 0 },
      policyVersion: '2026-08-26.1',
      appliedRule: 'sensitive-stays-ch',
      allowedProviders: ['infomaniak'],
      chosenProvider: 'infomaniak',
      residency: 'CH',
      model: 'apertus'
    })

    expect(dbRun).toHaveBeenCalledOnce()
    const [sql] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sql).toContain('INSERT INTO activity_log')
  })

  it('records hit counts per detector source (I3)', () => {
    logRoutingDecision({
      actorId: 'local',
      conversationId: 'conv_1',
      level: 'high',
      reason: 'PERSON (ner) at high',
      bySource: { regex: 0, swiss: 1, ner: 3, custom: 0 },
      policyVersion: '2026-08-26.1',
      appliedRule: 'sensitive-stays-ch',
      allowedProviders: ['infomaniak'],
      chosenProvider: 'infomaniak',
      residency: 'CH',
      model: 'apertus'
    })

    const [, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    const details = JSON.parse(params[6] as string)
    expect(details.bySource).toEqual({ regex: 0, swiss: 1, ner: 3, custom: 0 })
  })

  it('never writes prompt or response text', () => {
    logRoutingDecision({
      actorId: 'local',
      conversationId: 'conv_1',
      level: 'low',
      reason: 'workspace class low',
      bySource: { regex: 0, swiss: 0, ner: 0, custom: 0 },
      policyVersion: '2026-08-26.1',
      appliedRule: null,
      allowedProviders: ['anthropic'],
      chosenProvider: 'anthropic',
      residency: 'US',
      model: 'claude-sonnet-4-6'
    })

    const [, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    const serialised = JSON.stringify(params)
    expect(serialised).not.toContain('content')
    expect(serialised).not.toContain('prompt')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/policy-audit-writer.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/policy/audit-writer'`

- [ ] **Step 3: Write the audit writer**

```typescript
// src/main/policy/audit-writer.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/policy-audit-writer.test.ts`
Expected: PASS, 3 Tests

- [ ] **Step 5: Commit**

```bash
git add src/main/policy/audit-writer.ts tests/unit/policy-audit-writer.test.ts
git commit -m "feat(policy): write routing decisions to the activity log

First production caller of ActivityLogger, which until now was imported only
by its own unit test. Records level, applied rule, policy version, permitted
set, chosen provider, residency and per-source hit counts — never content."
```

---

## Task 7: Verdrahtung und Invariantentests

**Files:**
- Modify: `src/main/services/service-layer.ts`
- Create: `tests/unit/policy-invariants.test.ts`

**Interfaces:**
- Consumes: alles aus Task 1–6
- Produces: `ServiceLayer.routeWithPolicy(message, entities, workspaceClass, actorId, conversationId): Promise<RoutingResult>`

- [ ] **Step 1: Write the failing invariant test**

```typescript
// tests/unit/policy-invariants.test.ts
/**
 * Invarianten I1 und I2 als Umgehungstests, nicht als Randfaelle.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'
import { classify } from '../../src/main/policy/sensitivity-classifier'
import { evaluate, DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import { IntelligentRouter } from '../../src/main/routing/intelligent-router'
import type { PIIEntity } from '../../src/main/privacy/pii-types'

const ahv: PIIEntity = {
  category: 'AHV',
  original: '756.1234.5678.90',
  start: 0,
  end: 16,
  confidence: 1,
  source: 'swiss',
  sensitivity: 'critical'
}

describe('policy invariants', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
    registry.registerVerified(
      { id: 'ch', name: 'CH', type: 'custom', apiBase: 'https://x.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'Infomaniak SA', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    registry.registerVerified(
      { id: 'us', name: 'US', type: 'custom', apiBase: 'https://y.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Frontier Inc', weightsLicense: 'closed', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.99, creative: 0.99, analysis: 0.99, conversation: 0.99 }
    )
    setProviderRegistry(registry)
  })

  it('I1: the best-scoring provider loses to the policy', async () => {
    const classification = classify([ahv], 'low')
    const decision = evaluate(DEFAULT_POLICY, classification, registry.all())

    expect(decision.allowed).toEqual(['ch'])

    const router = new IntelligentRouter()
    const result = await router.route('Bitte diesen Code refactoren', decision.allowed)

    expect(result.suggestedProvider).toBe('ch')
  })

  it('I1: a permitted set of zero does not resolve to a provider', async () => {
    const onlyUs = new ProviderRegistry()
    onlyUs.registerVerified(
      { id: 'us', name: 'US', type: 'custom', apiBase: 'https://y.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Frontier Inc', weightsLicense: 'closed', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.99, creative: 0.99, analysis: 0.99, conversation: 0.99 }
    )
    setProviderRegistry(onlyUs)

    const decision = evaluate(DEFAULT_POLICY, classify([ahv], 'low'), onlyUs.all())
    expect(decision.allowed).toEqual([])

    const router = new IntelligentRouter()
    const result = await router.route('Egal was', decision.allowed)
    expect(result.suggestedProvider).toBe('')
    expect(result.confidence).toBe(0)
  })

  it('I2: a tenant endpoint claiming CH cannot receive a sensitive request', () => {
    registry.registerTenant({
      id: 'liar',
      name: 'Angeblich Schweiz',
      type: 'custom',
      apiBase: 'https://somewhere.invalid/v1',
      apiKeyRequired: true,
      supportsStreaming: true,
      models: []
    })

    const decision = evaluate(DEFAULT_POLICY, classify([ahv], 'low'), registry.all())

    expect(decision.allowed).not.toContain('liar')
    expect(decision.allowed).toEqual(['ch'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/policy-invariants.test.ts`
Expected: FAIL, solange Task 5 nicht abgeschlossen ist — danach muss dieser Test gruen sein, bevor die Verdrahtung folgt

- [ ] **Step 3: Wire the pipeline in the service layer**

In `src/main/services/service-layer.ts` ergaenzen:

```typescript
import { classify } from '../policy/sensitivity-classifier'
import { evaluate, DEFAULT_POLICY } from '../policy/policy-engine'
import { getProviderRegistry } from '../routing/provider-registry'
import { logRoutingDecision } from '../policy/audit-writer'
import type { PIIEntity, PIISensitivity } from '../privacy/pii-types'
import type { RoutingResult } from '../routing/intelligent-router'
```

Und als Methode der bestehenden Klasse:

```typescript
  /**
   * Classify, filter by policy, then route — in that order (invariant I1).
   *
   * The router is handed the permitted set and can only narrow it further.
   * Reordering these three calls turns the policy into a suggestion.
   */
  async routeWithPolicy(
    message: string,
    entities: PIIEntity[],
    workspaceClass: PIISensitivity,
    actorId: string,
    conversationId: string
  ): Promise<RoutingResult> {
    const classification = classify(entities, workspaceClass)
    const decision = evaluate(DEFAULT_POLICY, classification, getProviderRegistry().all())
    const result = await this.router.route(message, decision.allowed)

    logRoutingDecision({
      actorId,
      conversationId,
      level: classification.level,
      reason: classification.reason,
      bySource: classification.bySource,
      policyVersion: decision.policyVersion,
      appliedRule: decision.appliedRule,
      allowedProviders: decision.allowed,
      chosenProvider: result.suggestedProvider,
      residency: getProviderRegistry().get(result.suggestedProvider)?.origin.residency ?? 'unknown'
    })

    return result
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; alle Tests gruen, darunter die drei Invariantentests

- [ ] **Step 5: Commit**

```bash
git add src/main/services/service-layer.ts tests/unit/policy-invariants.test.ts
git commit -m "feat(policy): wire classify -> policy -> route and lock the order

routeWithPolicy runs the three steps in the only order that holds invariant
I1: the router receives an already-filtered set and can only narrow it.
Invariants I1 and I2 get bypass tests rather than edge-case tests — the
best-scoring provider must lose to the policy, an empty permitted set must
not resolve, and a tenant endpoint claiming CH must not receive a sensitive
request."
```

---

## Task 8: Schweizer Endpunkt eintragen

**Files:**
- Modify: `src/main/routing/provider-registry.ts`
- Test: `tests/unit/provider-registry.test.ts` (erweitern)

**Interfaces:**
- Consumes: `ProviderRegistry.registerVerified` aus Task 1
- Produces: `CH_PROVIDERS`, `seedSwissProviders(registry)`

- [ ] **Step 1: Write the failing test**

An `tests/unit/provider-registry.test.ts` anfuegen:

```typescript
describe('Swiss providers', () => {
  it('builds the account-specific base URL from the product id', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, '12345')

    expect(registry.get('infomaniak')?.config.apiBase).toBe(
      'https://api.infomaniak.com/2/ai/12345/openai/v1'
    )
  })

  it('registers Infomaniak with Swiss residency and open weights', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, '12345')

    const entry = registry.get('infomaniak')
    expect(entry?.origin.residency).toBe('CH')
    expect(entry?.origin.weightsLicense).toBe('open')
    expect(entry?.origin.hostingMode).toBe('rented')
  })

  it('registers nothing when no product id is configured', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, undefined)

    expect(registry.get('infomaniak')).toBeUndefined()
  })

  it('does not claim a task-fitness score it has not measured', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, '12345')

    const caps = registry.get('infomaniak')?.capabilities
    expect(caps).toEqual({ code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 })
  })
})
```

Import ergaenzen: `import { ProviderRegistry, seedSwissProviders } from '../../src/main/routing/provider-registry'`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/provider-registry.test.ts`
Expected: FAIL — `seedSwissProviders is not a function`

- [ ] **Step 3: Add the Swiss entries**

In `src/main/routing/provider-registry.ts` anfuegen:

```typescript
/**
 * Swiss endpoints.
 *
 * The base URL is account-specific: Infomaniak exposes one AI product per
 * organisation and the product id is part of the path
 * (`/2/ai/{product_id}/openai/v1`, verified against the developer portal on
 * 2026-08-26). It is therefore configuration, never a constant — without a
 * configured id we register nothing rather than a URL that cannot answer.
 *
 * `models` stays empty on purpose. Which models the account actually serves
 * is answered by `GET /models` against that endpoint; the claim that Apertus
 * is among them comes from a secondary source and is unverified.
 *
 * Capabilities stay at the unmeasured default: no published benchmark
 * figures exist for Apertus 1.5, and the eval-framework suitability run
 * (`examples/modell_eignungspruefung.py`) has not been run against this
 * endpoint. Claiming a score here would be an assertion where the offering
 * promises a measurement.
 */
export function seedSwissProviders(
  registry: ProviderRegistry,
  infomaniakProductId: string | undefined
): void {
  if (!infomaniakProductId) return

  registry.registerVerified(
    {
      id: 'infomaniak',
      name: 'Infomaniak (CH)',
      type: 'custom',
      apiBase: `https://api.infomaniak.com/2/ai/${infomaniakProductId}/openai/v1`,
      apiKeyRequired: true,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      models: [],
      badge: 'CH',
      color: '#0098FF'
    },
    {
      residency: 'CH',
      operator: 'Infomaniak Network SA, Genf',
      weightsLicense: 'open',
      hostingMode: 'rented',
      dpaStatus: 'signed'
    },
    { ...UNMEASURED_CAPABILITIES }
  )
}
```

Und in `getProviderRegistry()` nach `seedBuiltInProviders` aufrufen:

```typescript
    seedBuiltInProviders(registryInstance)
    seedSwissProviders(registryInstance, process.env.INFOMANIAK_PRODUCT_ID)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/provider-registry.test.ts`
Expected: PASS, 9 Tests

- [ ] **Step 5: Run the full suite and commit**

```bash
npm run typecheck && npm test
git add src/main/routing/provider-registry.ts tests/unit/provider-registry.test.ts
git commit -m "feat(routing): register Infomaniak as the first Swiss endpoint

Capabilities stay at the unmeasured default on purpose: no published
benchmark figures exist for Apertus 1.5 and the suitability run has not been
executed against this endpoint. The offering sells a measurement, so the
registry must not assert one."
```

---

## Was dieser Plan bewusst nicht enthaelt

Diese vier Teile sind eigene Plaene, weil jeder fuer sich lauffaehige, testbare Software ergibt und ihre Entscheide vom Ergebnis dieses Plans abhaengen:

| Plan | Inhalt | Warum spaeter |
|---|---|---|
| **2 — Gateway-Dienst** | Mandantenverwaltung, HTTP-API, Credential-Resolver (Pool/BYOK), Ausgabefilterkette mit AUP-Hashfilter | Die Vollform von I1 (Resolver nach Policy) ist erst hier testbar. Braucht den Policy-Kern als Fundament. |
| **3 — Guthaben-Ledger** | Buchungen, Reservieren/Buchen/Freigeben, zwei Guthabenarten | Haengt am Credential-Resolver aus Plan 2 — ohne Vertragspfad gibt es keine zwei Buchungsarten. |
| **4 — Web-Client** | Layer 1+2 im Browser, Oberflaeche fuer Chat, Guthaben und Audit | Neubau gegen die Gateway-API aus Plan 2. |
| **5 — Eignungspruefung** | `ch_kmu_v1`-Suite gegen den Infomaniak-Endpunkt fahren, Faehigkeitswerte aus dem Ergebnis in die Registry | Blockiert durch den Apertus-Zugang (Spec §11), nicht durch Code. |

**Reihenfolge-Hinweis:** Plan 5 kann parallel zu Plan 2 laufen, sobald der Zugang da ist — er braucht aus diesem Plan nur den Registry-Eintrag aus Task 8.
