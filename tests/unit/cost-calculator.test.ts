/**
 * Shared Cost Calculator Tests (Paperclip Phase 4.2)
 * Tests the shared cost table loaded from llm-cost-table.json.
 */

import { describe, it, expect } from 'vitest'
import { calculateCost, getCostTable, hasModelPricing } from '../../src/main/tracking/cost-calculator'

describe('CostCalculator (Shared Cost Table)', () => {
  describe('calculateCost', () => {
    it('should calculate correct cost for Anthropic models', () => {
      const result = calculateCost('claude-3-5-sonnet-20241022', 1_000_000, 1_000_000)
      expect(result.inputCost).toBe(3)
      expect(result.outputCost).toBe(15)
      expect(result.totalCost).toBe(18)
    })

    it('should calculate correct cost for OpenAI models', () => {
      const result = calculateCost('gpt-4o', 1_000_000, 1_000_000)
      expect(result.inputCost).toBe(2.5)
      expect(result.outputCost).toBe(10)
      expect(result.totalCost).toBe(12.5)
    })

    it('should calculate correct cost for Google models', () => {
      const result = calculateCost('gemini-2.0-flash', 1_000_000, 1_000_000)
      expect(result.inputCost).toBeCloseTo(0.1)
      expect(result.outputCost).toBeCloseTo(0.4)
      expect(result.totalCost).toBeCloseTo(0.5)
    })

    it('should return zero for unknown models without error', () => {
      const result = calculateCost('unknown-model-xyz', 1000, 1000)
      expect(result.inputCost).toBe(0)
      expect(result.outputCost).toBe(0)
      expect(result.totalCost).toBe(0)
    })

    it('should handle zero tokens', () => {
      const result = calculateCost('gpt-4', 0, 0)
      expect(result.totalCost).toBe(0)
    })

    it('should handle small token counts correctly', () => {
      // 100 tokens of claude-3-haiku: (100/1M) * 0.25 = 0.000025
      const result = calculateCost('claude-3-haiku-20240307', 100, 100)
      expect(result.inputCost).toBeCloseTo(0.000025)
      expect(result.outputCost).toBeCloseTo(0.000125)
    })

    it('should calculate for newest Claude models', () => {
      const result = calculateCost('claude-opus-4-20250514', 1_000_000, 1_000_000)
      expect(result.inputCost).toBe(15)
      expect(result.outputCost).toBe(75)
      expect(result.totalCost).toBe(90)
    })
  })

  describe('getCostTable', () => {
    it('should return a non-empty flat lookup', () => {
      const table = getCostTable()
      expect(Object.keys(table).length).toBeGreaterThan(0)
    })

    it('should contain models from all 3 providers', () => {
      const table = getCostTable()
      // Anthropic
      expect(table['claude-3-5-sonnet-20241022']).toBeDefined()
      // OpenAI
      expect(table['gpt-4o']).toBeDefined()
      // Google
      expect(table['gemini-pro']).toBeDefined()
    })

    it('should NOT contain meta fields ($schema, _version, _description)', () => {
      const table = getCostTable()
      for (const key of Object.keys(table)) {
        expect(key).not.toMatch(/^\$/)
        expect(key).not.toMatch(/^_/)
      }
    })

    it('should return readonly — same reference on repeated calls', () => {
      const a = getCostTable()
      const b = getCostTable()
      expect(a).toBe(b)
    })

    it('should have input and output pricing for every model', () => {
      const table = getCostTable()
      for (const [model, pricing] of Object.entries(table)) {
        expect(pricing.input, `${model} missing input`).toBeTypeOf('number')
        expect(pricing.output, `${model} missing output`).toBeTypeOf('number')
        expect(pricing.input, `${model} input < 0`).toBeGreaterThanOrEqual(0)
        expect(pricing.output, `${model} output < 0`).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('hasModelPricing', () => {
    it('should return true for known models', () => {
      expect(hasModelPricing('gpt-4')).toBe(true)
      expect(hasModelPricing('claude-3-5-sonnet-20241022')).toBe(true)
      expect(hasModelPricing('gemini-pro')).toBe(true)
    })

    it('should return false for unknown models', () => {
      expect(hasModelPricing('nonexistent-model')).toBe(false)
      expect(hasModelPricing('')).toBe(false)
    })

    it('should return false for provider names (not model names)', () => {
      expect(hasModelPricing('anthropic')).toBe(false)
      expect(hasModelPricing('openai')).toBe(false)
    })
  })
})
