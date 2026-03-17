/**
 * Privacy Red-Teaming Test Suite — Phase 7b.5
 *
 * Runs adversarial test cases from YAML catalogs against the PII pipeline.
 * Uses Vitest (same framework as all other Mingly tests).
 *
 * Execution modes:
 * - 2-Layer (Regex + Swiss, NER disabled) — always runs
 * - 3-Layer (Regex + Swiss + NER/piiranha-v1) — runs when RUN_3LAYER=1
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as yaml from 'yaml'
import { afterAll, beforeAll } from 'vitest'
import { detectPII, setNERDetector } from '../../src/main/privacy/detector-pipeline'
import { PIIAnonymizer } from '../../src/main/privacy/anonymizer'
import type { AnonymizationResult } from '../../src/main/privacy/pii-types'
import { createDirectNERDetector } from './helpers/direct-ner-detector'

// --- YAML Loader ---

interface TestCase {
  description?: string
  vars: { input: string }
  assert: Array<{ type: string; value: string }>
  metadata?: {
    category?: string
    technique?: string
    tier?: string
    language?: string
    note?: string
  }
}

interface YAMLCatalog {
  tests: TestCase[]
}

const RED_TEAM_DIR = resolve(dirname(fileURLToPath(import.meta.url)))

function loadCatalog(filename: string): TestCase[] {
  const filepath = resolve(RED_TEAM_DIR, filename)
  const content = readFileSync(filepath, 'utf-8')
  const parsed = yaml.parse(content) as YAMLCatalog
  return parsed.tests ?? []
}

// --- Detection Helper ---

async function runDetection(input: string): Promise<string> {
  setNERDetector(null)
  const result = await detectPII(input)
  return JSON.stringify({
    detected: result.entities.length,
    entities: result.entities.map(e => ({
      category: e.category,
      original: e.original,
      source: e.source,
      confidence: e.confidence,
      start: e.start,
      end: e.end,
    })),
    latencyMs: result.latencyMs,
  })
}

// --- Anonymization Helper ---

async function runAnonymization(input: string, mode: 'shield' | 'vault' = 'shield'): Promise<string> {
  setNERDetector(null)
  const anonymizer = new PIIAnonymizer(`red-team-${Date.now()}`, mode)
  const result = await anonymizer.anonymize(input)
  const originalPII = result.replacements.map(r => r.entity.original)
  const leaks = originalPII.filter(pii => result.anonymizedText.includes(pii))

  return JSON.stringify({
    anonymizedText: result.anonymizedText,
    mode: result.mode,
    replacements: result.replacements.map(r => ({
      category: r.entity.category,
      original: r.entity.original,
      replacement: r.replacement,
    })),
    stats: result.stats,
    latencyMs: result.latencyMs,
    leaks,
    leakCount: leaks.length,
  })
}

// --- Rehydration Helper ---

type LLMSim = (text: string, result: AnonymizationResult) => string

const rehydrationSims: Record<string, { sim: LLMSim; mode: 'shield' | 'vault' }> = {
  passthrough: { sim: (t) => t, mode: 'shield' },
  context_guess: { sim: (t) => t + '\nNote: The real name is probably Hans Mueller.', mode: 'shield' },
  map_query: { sim: (t) => t + '\nPlaceholder mapping:\n???', mode: 'shield' },
  duplication: { sim: (t) => (t + '\n').repeat(20), mode: 'shield' },
  injected_original: {
    sim: (t, r) => t + '\nAdditionally: ' + r.replacements.map(x => x.entity.original).join(', '),
    mode: 'shield',
  },
  vault: { sim: (t) => t, mode: 'vault' },
  empty: { sim: () => '', mode: 'shield' },
  code_block: { sim: (t) => '```\n' + t + '\n```', mode: 'shield' },
}

async function runRehydrationTest(input: string, simName: string): Promise<string> {
  setNERDetector(null)
  const { sim, mode } = rehydrationSims[simName] ?? rehydrationSims.passthrough
  const anonymizer = new PIIAnonymizer(`red-team-rehydration-${Date.now()}`, mode)
  const anonResult = await anonymizer.anonymize(input)
  const llmResponse = sim(anonResult.anonymizedText, anonResult)

  const originalPII = anonResult.replacements.map(r => r.entity.original)
  const leaks = originalPII.filter(pii => llmResponse.includes(pii))

  const replacementMap = anonymizer.getReplacementMap()
  let rehydrated = llmResponse
  for (const [original, fake] of replacementMap.entries()) {
    rehydrated = rehydrated.split(fake).join(original)
  }
  const rehydrationLeaks = originalPII.filter(pii =>
    rehydrated.includes(pii) && !anonResult.anonymizedText.includes(pii)
  )

  return JSON.stringify({
    originalInput: input,
    anonymizedText: anonResult.anonymizedText,
    llmResponse: llmResponse.slice(0, 2000),
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
  })
}

// --- Assertion Evaluator ---
// Security note: These assertions only run in test context against our own YAML catalogs.
// The YAML files are part of the repo and not user-supplied input.

function evaluateAssertion(output: string, assertionCode: string): boolean {
  try {
    // Parse output once, then check the assertion expression
    const parsed = JSON.parse(output)

    // Map common assertion patterns to safe evaluations
    // Instead of eval/Function, we parse the assertion string and execute known patterns

    // Pattern: JSON.parse(output).X === Y or JSON.parse(output).X > Y
    const simpleCheck = assertionCode.match(
      /^JSON\.parse\(output\)\.(\w+)\s*(===|!==|>=|<=|>|<)\s*(.+)$/
    )
    if (simpleCheck) {
      const [, field, op, valueStr] = simpleCheck
      const actual = parsed[field]
      const expected = valueStr === 'true' ? true :
        valueStr === 'false' ? false :
          valueStr.startsWith("'") ? valueStr.slice(1, -1) :
            Number(valueStr)

      switch (op) {
        case '===': return actual === expected
        case '!==': return actual !== expected
        case '>=': return actual >= expected
        case '<=': return actual <= expected
        case '>': return actual > expected
        case '<': return actual < expected
      }
    }

    // Pattern: JSON.parse(output).entities.some(e => e.category === 'X' || e.category === 'Y')
    const someCheck = assertionCode.match(
      /JSON\.parse\(output\)\.entities\.some\(e\s*=>\s*(.+)\)/
    )
    if (someCheck && !assertionCode.startsWith('!') && !assertionCode.startsWith('const')) {
      const condition = someCheck[1]
      const categories: string[] = []
      const catMatches = condition.matchAll(/e\.category\s*===\s*'(\w+)'/g)
      for (const m of catMatches) {
        categories.push(m[1])
      }
      if (categories.length > 0) {
        return parsed.entities?.some((e: { category: string }) =>
          categories.includes(e.category)
        ) === true
      }
    }

    // Pattern: !JSON.parse(output).entities.some(e => e.category === 'X' && e.original.includes('Y'))
    const notSomeCheck = assertionCode.match(
      /^!JSON\.parse\(output\)\.entities\.some\(e\s*=>\s*e\.category\s*===\s*'(\w+)'\s*&&\s*e\.original\.includes\('([^']+)'\)\)$/
    )
    if (notSomeCheck) {
      const [, category, substring] = notSomeCheck
      return !parsed.entities?.some(
        (e: { category: string; original: string }) =>
          e.category === category && e.original.includes(substring)
      )
    }

    // Pattern: JSON.parse(output).entities.filter(e => e.category === 'X').length >= N
    const filterCheck = assertionCode.match(
      /JSON\.parse\(output\)\.entities\.filter\(e\s*=>\s*e\.category\s*===\s*'(\w+)'\)\.length\s*(>=|>|===)\s*(\d+)/
    )
    if (filterCheck) {
      const [, category, op, countStr] = filterCheck
      const count = parsed.entities?.filter((e: { category: string }) => e.category === category).length ?? 0
      const expected = Number(countStr)
      switch (op) {
        case '>=': return count >= expected
        case '>': return count > expected
        case '===': return count === expected
      }
    }

    // Pattern: JSON.parse(output).X.length >= N (entities, replacements, etc.)
    const lengthCheck = assertionCode.match(
      /JSON\.parse\(output\)\.(\w+)\.length\s*(>=|>|===)\s*(\d+)/
    )
    if (lengthCheck) {
      const [, field, op, countStr] = lengthCheck
      const count = parsed[field]?.length ?? 0
      const expected = Number(countStr)
      switch (op) {
        case '>=': return count >= expected
        case '>': return count > expected
        case '===': return count === expected
      }
    }

    // Pattern: compound with const — e.g. "const e = JSON.parse(output).entities; e.some(...) && e.some(...)"
    const compoundCheck = assertionCode.match(
      /^const\s+\w+\s*=\s*JSON\.parse\(output\)\.entities;\s*(.+)$/
    )
    if (compoundCheck) {
      const entities = parsed.entities ?? []
      const conditions = compoundCheck[1]

      // Split by && and evaluate each
      const parts = conditions.split(/\s*&&\s*/)
      return parts.every((part: string) => {
        // e.some(x => x.category === 'X')
        const m = part.match(/\w+\.some\(\w+\s*=>\s*\w+\.category\s*===\s*'(\w+)'\)/)
        if (m) {
          return entities.some((e: { category: string }) => e.category === m[1])
        }
        // e.length >= N
        const lm = part.match(/\w+\.length\s*>=\s*(\d+)/)
        if (lm) {
          return entities.length >= Number(lm[1])
        }
        return false
      })
    }

    // Pattern: const r = JSON.parse(output); r.X > Y (single condition, no &&)
    const constRCheck = assertionCode.match(
      /^const\s+(\w+)\s*=\s*JSON\.parse\(output\);\s*\1\.(\w+)\s*(===|!==|>=|<=|>|<)\s*(\d+)$/
    )
    if (constRCheck) {
      const [, , field, op, valueStr] = constRCheck
      const actual = parsed[field]
      const expected = Number(valueStr)
      switch (op) {
        case '>': return actual > expected
        case '>=': return actual >= expected
        case '===': return actual === expected
        case '<': return actual < expected
      }
    }

    // Pattern: const r = JSON.parse(output); compound conditions with &&
    const anonTextCheck = assertionCode.match(
      /const\s+\w+\s*=\s*JSON\.parse\(output\);\s*(.+)/
    )
    if (anonTextCheck) {
      const conditions = anonTextCheck[1]
      const parts = conditions.split(/\s*&&\s*/)
      return parts.every((part: string) => {
        // r.field === N (numeric)
        const numMatch = part.match(/\w+\.(\w+)\s*(===|!==|>=|<=|>|<)\s*(\d+)/)
        if (numMatch) {
          const [, field, op, val] = numMatch
          const actual = parsed[field]
          const expected = Number(val)
          switch (op) {
            case '===': return actual === expected
            case '!==': return actual !== expected
            case '>=': return actual >= expected
            case '<=': return actual <= expected
            case '>': return actual > expected
            case '<': return actual < expected
          }
        }

        // r.field.includes('X')
        const includesMatch = part.match(/\w+\.(\w+)\.includes\('([^']+)'\)/)
        if (includesMatch && !part.startsWith('!')) {
          return parsed[includesMatch[1]]?.includes(includesMatch[2])
        }

        // !r.field.includes('X')
        const notIncludesMatch = part.match(/!\w+\.(\w+)\.includes\('([^']+)'\)/)
        if (notIncludesMatch) {
          return !parsed[notIncludesMatch[1]]?.includes(notIncludesMatch[2])
        }

        // r.mode === 'X'
        const strMatch = part.match(/\w+\.(\w+)\s*===\s*'(\w+)'/)
        if (strMatch) {
          return parsed[strMatch[1]] === strMatch[2]
        }

        return false
      })
    }

    // Fallback: unknown assertion pattern
    console.warn(`Unknown assertion pattern: ${assertionCode}`)
    return false
  } catch {
    return false
  }
}

// --- Test Runner ---

function runCatalogTests(catalogFile: string, outputFn: (input: string) => Promise<string>) {
  const tests = loadCatalog(catalogFile)

  for (const tc of tests) {
    const label = tc.description ??
      `${tc.metadata?.technique ?? 'test'} [${tc.metadata?.tier ?? '?'}]`

    it(label, async () => {
      const output = await outputFn(tc.vars.input)

      for (const assertion of tc.assert) {
        if (assertion.type === 'javascript') {
          const passed = evaluateAssertion(output, assertion.value)
          if (!passed) {
            const parsed = JSON.parse(output)
            const detail = parsed.entities
              ? `detected=${parsed.detected}, entities=[${parsed.entities.map((e: { category: string }) => e.category).join(', ')}]`
              : `leakCount=${parsed.leakCount ?? '?'}`
            expect(passed, `Assertion failed: ${assertion.value}\n  ${detail}`).toBe(true)
          }
        }
      }
    })
  }
}

// --- Test Suites ---

describe('Phase A: PII Bypass — 2-Layer (Regex+Swiss)', () => {
  describe('Format Variations', () => {
    runCatalogTests('catalog/format-variations.yaml', runDetection)
  })

  describe('Encoding Attacks', () => {
    runCatalogTests('catalog/encoding-attacks.yaml', runDetection)
  })

  describe('Context Evasion', () => {
    runCatalogTests('catalog/context-evasion.yaml', runDetection)
  })

  describe('Language Mixing', () => {
    runCatalogTests('catalog/language-mixing.yaml', runDetection)
  })

  describe('NER Degradation (2-Layer baseline)', () => {
    runCatalogTests('catalog/ner-degradation.yaml', runDetection)
  })
})

describe('Phase B: Jailbreak — Anonymization Bypass', () => {
  describe('Prompt Injection', () => {
    const tests = loadCatalog('jailbreak/prompt-injection.yaml')

    for (const tc of tests) {
      const label = tc.description ??
        `${tc.metadata?.technique ?? 'test'} [${tc.metadata?.tier ?? '?'}]`
      const technique = tc.metadata?.technique ?? ''
      const mode = technique.startsWith('vault') ? 'vault' as const : 'shield' as const

      it(label, async () => {
        const output = await runAnonymization(tc.vars.input, mode)

        for (const assertion of tc.assert) {
          if (assertion.type === 'javascript') {
            const passed = evaluateAssertion(output, assertion.value)
            if (!passed) {
              const parsed = JSON.parse(output)
              const detail = `leakCount=${parsed.leakCount ?? '?'}, mode=${parsed.mode}`
              expect(passed, `Assertion failed: ${assertion.value}\n  ${detail}`).toBe(true)
            }
          }
        }
      })
    }
  })
})

describe('Phase B: Rehydration Hardening', () => {
  const tests = loadCatalog('jailbreak/rehydration-hardening.yaml')

  const simMap: Record<string, string> = {
    'baseline-passthrough': 'passthrough',
    'context-guess': 'context_guess',
    'duplication': 'duplication',
    'map-query': 'map_query',
    'injected-original': 'injected_original',
    'vault-mode': 'vault',
    'empty-response': 'empty',
    'code-block-wrap': 'code_block',
    'multi-entity-stress': 'passthrough',
    'empty-input': 'passthrough',
  }

  for (const tc of tests) {
    const label = tc.description ??
      `${tc.metadata?.technique ?? 'rehydration-test'} [${tc.metadata?.tier ?? '?'}]`
    const technique = tc.metadata?.technique ?? 'passthrough'
    const resolvedSim = simMap[technique] ?? 'passthrough'

    it(label, async () => {
      const output = await runRehydrationTest(tc.vars.input, resolvedSim)

      for (const assertion of tc.assert) {
        if (assertion.type === 'javascript') {
          const passed = evaluateAssertion(output, assertion.value)
          if (!passed) {
            const parsed = JSON.parse(output)
            const detail = `leakCount=${parsed.leakCount}, rehydrationLeakCount=${parsed.rehydrationLeakCount}`
            expect(passed, `Assertion failed: ${assertion.value}\n  ${detail}`).toBe(true)
          }
        }
      }
    })
  }
})

// --- 3-Layer Test Suites (NER enabled) ---
// Only runs when RUN_3LAYER=1 environment variable is set.
// Model load takes ~5-10s, inference adds ~50ms per test case.

const run3Layer = process.env.RUN_3LAYER === '1'

;(run3Layer ? describe : describe.skip)('Phase A: PII Bypass — 3-Layer (Regex+Swiss+NER)', () => {
  let nerDetector: Awaited<ReturnType<typeof createDirectNERDetector>> | null = null

  beforeAll(async () => {
    nerDetector = await createDirectNERDetector()
    setNERDetector(nerDetector as any)
  }, 60_000) // 60s timeout for model load

  afterAll(async () => {
    setNERDetector(null)
    if (nerDetector) await nerDetector.shutdown()
  })

  // 3-Layer detection helper (NER already injected via beforeAll)
  async function run3LayerDetection(input: string): Promise<string> {
    const result = await detectPII(input)
    return JSON.stringify({
      detected: result.entities.length,
      entities: result.entities.map(e => ({
        category: e.category,
        original: e.original,
        source: e.source,
        confidence: e.confidence,
        start: e.start,
        end: e.end,
      })),
      latencyMs: result.latencyMs,
    })
  }

  // 3-Layer anonymization helper
  async function run3LayerAnonymization(input: string, mode: 'shield' | 'vault' = 'shield'): Promise<string> {
    const anonymizer = new PIIAnonymizer(`red-team-3l-${Date.now()}`, mode)
    const result = await anonymizer.anonymize(input)
    const originalPII = result.replacements.map(r => r.entity.original)
    const leaks = originalPII.filter(pii => result.anonymizedText.includes(pii))

    return JSON.stringify({
      anonymizedText: result.anonymizedText,
      mode: result.mode,
      replacements: result.replacements.map(r => ({
        category: r.entity.category,
        original: r.entity.original,
        replacement: r.replacement,
      })),
      stats: result.stats,
      latencyMs: result.latencyMs,
      leaks,
      leakCount: leaks.length,
    })
  }

  describe('Format Variations', () => {
    runCatalogTests('catalog/format-variations.yaml', run3LayerDetection)
  })

  describe('Encoding Attacks', () => {
    runCatalogTests('catalog/encoding-attacks.yaml', run3LayerDetection)
  })

  describe('Context Evasion', () => {
    runCatalogTests('catalog/context-evasion.yaml', run3LayerDetection)
  })

  describe('Language Mixing', () => {
    runCatalogTests('catalog/language-mixing.yaml', run3LayerDetection)
  })

  describe('NER Detection (3-Layer)', () => {
    runCatalogTests('catalog/ner-degradation.yaml', run3LayerDetection)
  })

  describe('Prompt Injection (3-Layer)', () => {
    const tests = loadCatalog('jailbreak/prompt-injection.yaml')

    for (const tc of tests) {
      const label = tc.description ??
        `${tc.metadata?.technique ?? 'test'} [${tc.metadata?.tier ?? '?'}]`
      const technique = tc.metadata?.technique ?? ''
      const mode = technique.startsWith('vault') ? 'vault' as const : 'shield' as const

      it(label, async () => {
        const output = await run3LayerAnonymization(tc.vars.input, mode)

        for (const assertion of tc.assert) {
          if (assertion.type === 'javascript') {
            const passed = evaluateAssertion(output, assertion.value)
            if (!passed) {
              const parsed = JSON.parse(output)
              const detail = `leakCount=${parsed.leakCount ?? '?'}, mode=${parsed.mode}`
              expect(passed, `Assertion failed: ${assertion.value}\n  ${detail}`).toBe(true)
            }
          }
        }
      })
    }
  })
})
