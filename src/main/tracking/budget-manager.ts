/**
 * Budget Manager - Monthly spending limits and alerts per provider.
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { getTrackingEngine } from './tracking-engine'

export interface ProviderBudget {
  monthlyLimit: number  // USD
  warningThreshold: number  // 0-1 (e.g. 0.8 = 80%)
  autoFallback: boolean
  fallbackProvider?: string
}

export interface BudgetConfig {
  enabled: boolean
  globalMonthlyLimit: number  // USD, 0 = unlimited
  providers: Record<string, ProviderBudget>
}

export interface BudgetStatus {
  config: BudgetConfig
  currentMonth: {
    totalSpent: number
    byProvider: Record<string, { spent: number; limit: number; percentage: number; warning: boolean; exceeded: boolean }>
    globalPercentage: number
    globalWarning: boolean
    globalExceeded: boolean
  }
}

const DEFAULT_CONFIG: BudgetConfig = {
  enabled: false,
  globalMonthlyLimit: 50,
  providers: {
    anthropic: { monthlyLimit: 25, warningThreshold: 0.8, autoFallback: false },
    openai: { monthlyLimit: 25, warningThreshold: 0.8, autoFallback: false },
    google: { monthlyLimit: 10, warningThreshold: 0.8, autoFallback: false }
  }
}

export class BudgetManager {
  private configPath: string
  private config: BudgetConfig

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'budget-config.json')
    this.config = this.loadConfig()
  }

  private loadConfig(): BudgetConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) }
      }
    } catch (error) {
      console.error('Failed to load budget config:', error)
    }
    return { ...DEFAULT_CONFIG }
  }

  private saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    } catch (error) {
      console.error('Failed to save budget config:', error)
    }
  }

  getConfig(): BudgetConfig {
    return { ...this.config }
  }

  updateConfig(updates: Partial<BudgetConfig>): { success: boolean } {
    this.config = { ...this.config, ...updates }
    if (updates.providers) {
      this.config.providers = { ...this.config.providers, ...updates.providers }
    }
    this.saveConfig()
    return { success: true }
  }

  async getStatus(): Promise<BudgetStatus> {
    // Get current month's start timestamp
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

    const tracking = getTrackingEngine()
    const summary = await tracking.getSummary(monthStart)

    // Build per-provider status
    const byProvider: Record<string, { spent: number; limit: number; percentage: number; warning: boolean; exceeded: boolean }> = {}
    let totalSpent = 0

    if (summary.byProvider) {
      for (const [provider, data] of Object.entries(summary.byProvider)) {
        const provData = data as any
        const spent = provData.totalCost || 0
        totalSpent += spent
        const budget = this.config.providers[provider]
        const limit = budget?.monthlyLimit || 0
        const percentage = limit > 0 ? spent / limit : 0
        byProvider[provider] = {
          spent,
          limit,
          percentage,
          warning: budget ? percentage >= budget.warningThreshold : false,
          exceeded: limit > 0 && spent >= limit
        }
      }
    }

    const globalPercentage = this.config.globalMonthlyLimit > 0
      ? totalSpent / this.config.globalMonthlyLimit
      : 0

    return {
      config: this.config,
      currentMonth: {
        totalSpent,
        byProvider,
        globalPercentage,
        globalWarning: globalPercentage >= 0.8,
        globalExceeded: this.config.globalMonthlyLimit > 0 && totalSpent >= this.config.globalMonthlyLimit
      }
    }
  }

  /**
   * Check if sending a message with the given provider is within budget.
   * Returns the provider to use (may fallback if budget exceeded).
   */
  checkBudget(provider: string): { allowed: boolean; fallbackProvider?: string; reason?: string } {
    if (!this.config.enabled) return { allowed: true }

    const budget = this.config.providers[provider]
    if (!budget) return { allowed: true }

    // We'd need synchronous cost tracking here - for now, always allow
    // Budget checks happen post-hoc in the analytics dashboard
    return { allowed: true }
  }
}

let instance: BudgetManager | null = null
export function getBudgetManager(): BudgetManager {
  if (!instance) instance = new BudgetManager()
  return instance
}
