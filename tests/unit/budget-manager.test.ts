/**
 * BudgetManager Tests
 * Tests budget configuration, status, and check logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import nodePath from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => nodePath.join(tmpdir(), 'mingly-budget-test-' + process.pid)
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn()
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn()
}))

vi.mock('../../src/main/tracking/tracking-engine', () => ({
  getTrackingEngine: vi.fn().mockReturnValue({
    getSummary: vi.fn().mockResolvedValue({
      byProvider: {
        anthropic: { totalCost: 10.5 },
        openai: { totalCost: 5.0 }
      }
    })
  })
}))

import { BudgetManager } from '../../src/main/tracking/budget-manager'

describe('BudgetManager', () => {
  let manager: BudgetManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new BudgetManager()
  })

  describe('getConfig', () => {
    it('should return default config', () => {
      const config = manager.getConfig()
      expect(config.enabled).toBe(false)
      expect(config.globalMonthlyLimit).toBe(50)
    })

    it('should have default provider budgets', () => {
      const config = manager.getConfig()
      expect(config.providers.anthropic).toBeDefined()
      expect(config.providers.openai).toBeDefined()
      expect(config.providers.google).toBeDefined()
    })

    it('should have warning thresholds', () => {
      const config = manager.getConfig()
      expect(config.providers.anthropic.warningThreshold).toBe(0.8)
    })
  })

  describe('updateConfig', () => {
    it('should update global settings', () => {
      manager.updateConfig({ enabled: true, globalMonthlyLimit: 100 })
      const config = manager.getConfig()
      expect(config.enabled).toBe(true)
      expect(config.globalMonthlyLimit).toBe(100)
    })

    it('should update provider budgets', () => {
      manager.updateConfig({
        providers: {
          anthropic: { monthlyLimit: 50, warningThreshold: 0.9, autoFallback: true }
        }
      })
      const config = manager.getConfig()
      expect(config.providers.anthropic.monthlyLimit).toBe(50)
      expect(config.providers.anthropic.autoFallback).toBe(true)
    })

    it('should return success', () => {
      const result = manager.updateConfig({ enabled: true })
      expect(result.success).toBe(true)
    })
  })

  describe('checkBudget', () => {
    it('should always allow when disabled', () => {
      const result = manager.checkBudget('anthropic')
      expect(result.allowed).toBe(true)
    })

    it('should allow when enabled (current implementation)', () => {
      manager.updateConfig({ enabled: true })
      const result = manager.checkBudget('anthropic')
      expect(result.allowed).toBe(true)
    })

    it('should allow for unknown provider', () => {
      manager.updateConfig({ enabled: true })
      const result = manager.checkBudget('unknown-provider')
      expect(result.allowed).toBe(true)
    })
  })

  describe('getStatus', () => {
    it('should return budget status with spending data', async () => {
      const status = await manager.getStatus()

      expect(status.config).toBeDefined()
      expect(status.currentMonth).toBeDefined()
      expect(status.currentMonth.totalSpent).toBeGreaterThan(0)
    })

    it('should calculate per-provider status', async () => {
      const status = await manager.getStatus()

      expect(status.currentMonth.byProvider.anthropic).toBeDefined()
      expect(status.currentMonth.byProvider.anthropic.spent).toBe(10.5)
      expect(status.currentMonth.byProvider.openai.spent).toBe(5.0)
    })

    it('should calculate global percentage', async () => {
      const status = await manager.getStatus()

      // Total spent = 15.5, limit = 50, percentage = 0.31
      expect(status.currentMonth.globalPercentage).toBeCloseTo(0.31, 1)
      expect(status.currentMonth.globalWarning).toBe(false) // 31% < 80%
      expect(status.currentMonth.globalExceeded).toBe(false)
    })

    it('should detect per-provider warnings', async () => {
      const status = await manager.getStatus()

      // anthropic: spent 10.5, limit 25, pct = 0.42 < 0.8 threshold
      expect(status.currentMonth.byProvider.anthropic.warning).toBe(false)
    })
  })
})
