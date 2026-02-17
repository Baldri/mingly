/**
 * Feature Gate Manager — gates Phase 1 features by subscription tier.
 *
 * Tier hierarchy (cumulative):
 *   Free → Pro → Team → Enterprise
 *
 * Pricing (from STRATEGY.md):
 *   Free: Local models, basic chat, 3 conv/day, document context (chat uploads + shared folders)
 *   Pro (CHF 24/mo): + Cloud APIs, Multimodal, Export, Templates, Comparison, Agents, Auto-Update, Unlimited, Advanced RAG (vector DBs)
 *   Team (CHF 69/user/mo): + Team Workspaces, Shared RAG, RBAC, Usage Tracking, Audit Logs, SSO (OAuth)
 *   Enterprise (custom): + SSO/SAML/LDAP, On-Premise, Compliance Dashboard, Priority SLA, Custom Integrations
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type {
  SubscriptionTier,
  SubscriptionInfo,
  GatedFeature,
  FeatureGateResult,
  TierLimits
} from '../../shared/types'

// ---------------------------------------------------------------------------
// Feature → minimum tier mapping
// ---------------------------------------------------------------------------

const FEATURE_MIN_TIER: Record<GatedFeature, SubscriptionTier> = {
  // Pro+ features
  cloud_apis: 'pro',
  multimodal: 'pro',
  export: 'pro',
  auto_update: 'pro',
  agents: 'pro',
  templates_custom: 'pro',
  comparison: 'pro',
  unlimited_conversations: 'pro',
  advanced_rag: 'pro',

  // Team+ features
  team_workspaces: 'team',
  shared_rag: 'team',
  team_rbac: 'team',
  usage_tracking: 'team',
  audit_logs: 'team',
  sso_oauth: 'team',

  // Pro+ agentic features
  agentic_mode: 'pro',

  // Enterprise features
  sso_saml_ldap: 'enterprise',
  on_premise: 'enterprise',
  compliance_dashboard: 'enterprise',
  priority_sla: 'enterprise',
  custom_integrations: 'enterprise'
}

// Tier ordering for comparison
const TIER_LEVEL: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3
}

// Per-tier limits
const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: {
    maxConversationsPerDay: 3,
    maxTemplates: 0,           // only built-ins
    builtinTemplatesOnly: true,
    maxComparisonModels: 0     // disabled
  },
  pro: {
    maxConversationsPerDay: 0, // unlimited
    maxTemplates: 0,           // unlimited
    builtinTemplatesOnly: false,
    maxComparisonModels: 3
  },
  team: {
    maxConversationsPerDay: 0,
    maxTemplates: 0,
    builtinTemplatesOnly: false,
    maxComparisonModels: 3
  },
  enterprise: {
    maxConversationsPerDay: 0,
    maxTemplates: 0,
    builtinTemplatesOnly: false,
    maxComparisonModels: 3
  }
}

// Human-readable tier names
const TIER_NAMES: Record<SubscriptionTier, string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise'
}

// ---------------------------------------------------------------------------
// Daily usage tracker (in-memory, resets at midnight)
// ---------------------------------------------------------------------------

interface DailyUsage {
  date: string // YYYY-MM-DD
  conversationCount: number
}

// ---------------------------------------------------------------------------
// FeatureGateManager
// ---------------------------------------------------------------------------

export class FeatureGateManager {
  private configPath: string
  private subscription: SubscriptionInfo
  private dailyUsage: DailyUsage

  constructor(configDir?: string) {
    const dir = configDir || this.resolveConfigDir()
    this.configPath = path.join(dir, 'subscription.json')
    this.subscription = this.loadSubscription()
    this.dailyUsage = { date: this.todayKey(), conversationCount: 0 }
  }

  private resolveConfigDir(): string {
    try {
      return app.getPath('userData')
    } catch {
      return path.join(process.cwd(), 'data')
    }
  }

  // ---- persistence ----------------------------------------------------------

  private loadSubscription(): SubscriptionInfo {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
      }
    } catch {
      // Corrupted file → fall back to free
    }
    return this.defaultSubscription()
  }

  private defaultSubscription(): SubscriptionInfo {
    return {
      tier: 'free',
      activatedAt: Date.now()
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.subscription, null, 2))
    } catch {
      // Silently ignore save failures
    }
  }

  // ---- tier management ------------------------------------------------------

  getTier(): SubscriptionTier {
    // Check if subscription has expired
    if (this.subscription.expiresAt && Date.now() > this.subscription.expiresAt) {
      return 'free'
    }
    return this.subscription.tier
  }

  getSubscription(): SubscriptionInfo {
    return { ...this.subscription }
  }

  setTier(tier: SubscriptionTier, licenseKey?: string, expiresAt?: number, maxUsers?: number): void {
    this.subscription = {
      tier,
      activatedAt: Date.now(),
      licenseKey,
      expiresAt,
      maxUsers
    }
    this.save()
  }

  // ---- feature checking -----------------------------------------------------

  /**
   * Check if a feature is available under the current subscription tier.
   */
  checkFeature(feature: GatedFeature): FeatureGateResult {
    const currentTier = this.getTier()
    const requiredTier = FEATURE_MIN_TIER[feature]

    if (!requiredTier) {
      // Unknown feature → allow (no gate)
      return { allowed: true }
    }

    const currentLevel = TIER_LEVEL[currentTier]
    const requiredLevel = TIER_LEVEL[requiredTier]

    if (currentLevel >= requiredLevel) {
      return { allowed: true }
    }

    return {
      allowed: false,
      reason: `${TIER_NAMES[requiredTier]} plan required`,
      requiredTier
    }
  }

  /**
   * Check if the user can create another conversation today (Free tier limit).
   */
  checkConversationLimit(): FeatureGateResult {
    const tier = this.getTier()
    const limits = TIER_LIMITS[tier]

    if (limits.maxConversationsPerDay === 0) {
      // Unlimited
      return { allowed: true }
    }

    this.ensureDailyUsageReset()
    const remaining = limits.maxConversationsPerDay - this.dailyUsage.conversationCount

    if (remaining > 0) {
      return { allowed: true, remaining }
    }

    return {
      allowed: false,
      reason: `Daily conversation limit reached (${limits.maxConversationsPerDay}/day). Upgrade to Pro for unlimited.`,
      requiredTier: 'pro',
      remaining: 0
    }
  }

  /**
   * Record a conversation creation (for daily limit tracking).
   */
  recordConversation(): void {
    this.ensureDailyUsageReset()
    this.dailyUsage.conversationCount++
  }

  /**
   * Get the limits for the current tier.
   */
  getLimits(): TierLimits {
    return { ...TIER_LIMITS[this.getTier()] }
  }

  /**
   * Get all features with their availability status for the current tier.
   */
  getAllFeatures(): Record<GatedFeature, FeatureGateResult> {
    const features = Object.keys(FEATURE_MIN_TIER) as GatedFeature[]
    const result: Partial<Record<GatedFeature, FeatureGateResult>> = {}

    for (const feature of features) {
      result[feature] = this.checkFeature(feature)
    }

    return result as Record<GatedFeature, FeatureGateResult>
  }

  // ---- helpers --------------------------------------------------------------

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private ensureDailyUsageReset(): void {
    const today = this.todayKey()
    if (this.dailyUsage.date !== today) {
      this.dailyUsage = { date: today, conversationCount: 0 }
    }
  }

  /**
   * Compare two tiers. Returns true if tierA >= tierB.
   */
  static tierAtLeast(tierA: SubscriptionTier, tierB: SubscriptionTier): boolean {
    return TIER_LEVEL[tierA] >= TIER_LEVEL[tierB]
  }

  /**
   * Get the minimum tier required for a feature.
   */
  static getRequiredTier(feature: GatedFeature): SubscriptionTier {
    return FEATURE_MIN_TIER[feature]
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: FeatureGateManager | null = null

export function getFeatureGateManager(): FeatureGateManager {
  if (!instance) {
    instance = new FeatureGateManager()
  }
  return instance
}
