/**
 * FeatureGateManager Tests
 * Tests tier-based feature gating, conversation limits, and subscription management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { FeatureGateManager } from '../../src/main/services/feature-gate-manager'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-feature-gate')
  }
}))

describe('FeatureGateManager', () => {
  const testDir = '/tmp/test-feature-gate-' + Date.now()
  let manager: FeatureGateManager

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
    fs.mkdirSync(testDir, { recursive: true })
    manager = new FeatureGateManager(testDir)
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  // ── Default state ──────────────────────────────────────────────

  describe('default state', () => {
    it('should default to free tier', () => {
      expect(manager.getTier()).toBe('free')
    })

    it('should return subscription info', () => {
      const sub = manager.getSubscription()
      expect(sub.tier).toBe('free')
      expect(sub.activatedAt).toBeGreaterThan(0)
      expect(sub.licenseKey).toBeUndefined()
    })

    it('should return free tier limits', () => {
      const limits = manager.getLimits()
      expect(limits.maxConversationsPerDay).toBe(3)
      expect(limits.builtinTemplatesOnly).toBe(true)
      expect(limits.maxComparisonModels).toBe(0)
    })
  })

  // ── Tier management ────────────────────────────────────────────

  describe('tier management', () => {
    it('should set tier to pro', () => {
      manager.setTier('pro', 'license-key-123')
      expect(manager.getTier()).toBe('pro')
      expect(manager.getSubscription().licenseKey).toBe('license-key-123')
    })

    it('should set tier to team with maxUsers', () => {
      manager.setTier('team', 'team-key', undefined, 10)
      expect(manager.getTier()).toBe('team')
      expect(manager.getSubscription().maxUsers).toBe(10)
    })

    it('should set tier to enterprise', () => {
      manager.setTier('enterprise')
      expect(manager.getTier()).toBe('enterprise')
    })

    it('should persist tier across instances', () => {
      manager.setTier('pro', 'persist-key')
      const manager2 = new FeatureGateManager(testDir)
      expect(manager2.getTier()).toBe('pro')
      expect(manager2.getSubscription().licenseKey).toBe('persist-key')
    })

    it('should fall back to free on expired subscription', () => {
      const pastTime = Date.now() - 1000
      manager.setTier('pro', 'key', pastTime)
      expect(manager.getTier()).toBe('free')
    })

    it('should allow non-expired subscription', () => {
      const futureTime = Date.now() + 86400000 // +1 day
      manager.setTier('pro', 'key', futureTime)
      expect(manager.getTier()).toBe('pro')
    })
  })

  // ── Feature checking (Free tier) ──────────────────────────────

  describe('feature checking - free tier', () => {
    it('should deny cloud_apis', () => {
      const result = manager.checkFeature('cloud_apis')
      expect(result.allowed).toBe(false)
      expect(result.requiredTier).toBe('pro')
    })

    it('should deny multimodal', () => {
      const result = manager.checkFeature('multimodal')
      expect(result.allowed).toBe(false)
      expect(result.requiredTier).toBe('pro')
    })

    it('should deny export', () => {
      const result = manager.checkFeature('export')
      expect(result.allowed).toBe(false)
    })

    it('should deny comparison', () => {
      const result = manager.checkFeature('comparison')
      expect(result.allowed).toBe(false)
    })

    it('should deny agents', () => {
      const result = manager.checkFeature('agents')
      expect(result.allowed).toBe(false)
    })

    it('should deny templates_custom', () => {
      const result = manager.checkFeature('templates_custom')
      expect(result.allowed).toBe(false)
    })

    it('should deny team_workspaces', () => {
      const result = manager.checkFeature('team_workspaces')
      expect(result.allowed).toBe(false)
      expect(result.requiredTier).toBe('team')
    })

    it('should deny sso_saml_ldap', () => {
      const result = manager.checkFeature('sso_saml_ldap')
      expect(result.allowed).toBe(false)
      expect(result.requiredTier).toBe('enterprise')
    })

    it('should include reason message', () => {
      const result = manager.checkFeature('export')
      expect(result.reason).toContain('Pro')
      expect(result.reason).toContain('required')
    })
  })

  // ── Feature checking (Pro tier) ───────────────────────────────

  describe('feature checking - pro tier', () => {
    beforeEach(() => {
      manager.setTier('pro')
    })

    it('should allow cloud_apis', () => {
      expect(manager.checkFeature('cloud_apis').allowed).toBe(true)
    })

    it('should allow multimodal', () => {
      expect(manager.checkFeature('multimodal').allowed).toBe(true)
    })

    it('should allow export', () => {
      expect(manager.checkFeature('export').allowed).toBe(true)
    })

    it('should allow comparison', () => {
      expect(manager.checkFeature('comparison').allowed).toBe(true)
    })

    it('should allow agents', () => {
      expect(manager.checkFeature('agents').allowed).toBe(true)
    })

    it('should allow templates_custom', () => {
      expect(manager.checkFeature('templates_custom').allowed).toBe(true)
    })

    it('should allow auto_update', () => {
      expect(manager.checkFeature('auto_update').allowed).toBe(true)
    })

    it('should allow unlimited_conversations', () => {
      expect(manager.checkFeature('unlimited_conversations').allowed).toBe(true)
    })

    it('should deny team_workspaces', () => {
      expect(manager.checkFeature('team_workspaces').allowed).toBe(false)
      expect(manager.checkFeature('team_workspaces').requiredTier).toBe('team')
    })

    it('should deny sso_saml_ldap', () => {
      expect(manager.checkFeature('sso_saml_ldap').allowed).toBe(false)
      expect(manager.checkFeature('sso_saml_ldap').requiredTier).toBe('enterprise')
    })

    it('should return pro limits', () => {
      const limits = manager.getLimits()
      expect(limits.maxConversationsPerDay).toBe(0) // unlimited
      expect(limits.builtinTemplatesOnly).toBe(false)
      expect(limits.maxComparisonModels).toBe(3)
    })
  })

  // ── Feature checking (Team tier) ──────────────────────────────

  describe('feature checking - team tier', () => {
    beforeEach(() => {
      manager.setTier('team')
    })

    it('should allow all pro features', () => {
      expect(manager.checkFeature('cloud_apis').allowed).toBe(true)
      expect(manager.checkFeature('multimodal').allowed).toBe(true)
      expect(manager.checkFeature('export').allowed).toBe(true)
      expect(manager.checkFeature('comparison').allowed).toBe(true)
    })

    it('should allow team_workspaces', () => {
      expect(manager.checkFeature('team_workspaces').allowed).toBe(true)
    })

    it('should allow shared_rag', () => {
      expect(manager.checkFeature('shared_rag').allowed).toBe(true)
    })

    it('should allow team_rbac', () => {
      expect(manager.checkFeature('team_rbac').allowed).toBe(true)
    })

    it('should allow usage_tracking', () => {
      expect(manager.checkFeature('usage_tracking').allowed).toBe(true)
    })

    it('should allow audit_logs', () => {
      expect(manager.checkFeature('audit_logs').allowed).toBe(true)
    })

    it('should allow sso_oauth', () => {
      expect(manager.checkFeature('sso_oauth').allowed).toBe(true)
    })

    it('should deny sso_saml_ldap', () => {
      expect(manager.checkFeature('sso_saml_ldap').allowed).toBe(false)
      expect(manager.checkFeature('sso_saml_ldap').requiredTier).toBe('enterprise')
    })

    it('should deny on_premise', () => {
      expect(manager.checkFeature('on_premise').allowed).toBe(false)
    })
  })

  // ── Feature checking (Enterprise tier) ────────────────────────

  describe('feature checking - enterprise tier', () => {
    beforeEach(() => {
      manager.setTier('enterprise')
    })

    it('should allow all features', () => {
      const features = manager.getAllFeatures()
      for (const [_, result] of Object.entries(features)) {
        expect(result.allowed).toBe(true)
      }
    })

    it('should allow sso_saml_ldap', () => {
      expect(manager.checkFeature('sso_saml_ldap').allowed).toBe(true)
    })

    it('should allow on_premise', () => {
      expect(manager.checkFeature('on_premise').allowed).toBe(true)
    })

    it('should allow compliance_dashboard', () => {
      expect(manager.checkFeature('compliance_dashboard').allowed).toBe(true)
    })

    it('should allow priority_sla', () => {
      expect(manager.checkFeature('priority_sla').allowed).toBe(true)
    })

    it('should allow custom_integrations', () => {
      expect(manager.checkFeature('custom_integrations').allowed).toBe(true)
    })
  })

  // ── Conversation limit (Free tier) ────────────────────────────

  describe('conversation limit', () => {
    it('should allow 3 conversations on free tier', () => {
      expect(manager.checkConversationLimit().allowed).toBe(true)
      expect(manager.checkConversationLimit().remaining).toBe(3)
    })

    it('should count down remaining conversations', () => {
      manager.recordConversation()
      expect(manager.checkConversationLimit().remaining).toBe(2)

      manager.recordConversation()
      expect(manager.checkConversationLimit().remaining).toBe(1)
    })

    it('should deny after 3 conversations', () => {
      manager.recordConversation()
      manager.recordConversation()
      manager.recordConversation()

      const result = manager.checkConversationLimit()
      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.reason).toContain('limit')
    })

    it('should not limit pro tier', () => {
      manager.setTier('pro')
      for (let i = 0; i < 100; i++) {
        manager.recordConversation()
      }
      expect(manager.checkConversationLimit().allowed).toBe(true)
    })
  })

  // ── getAllFeatures ─────────────────────────────────────────────

  describe('getAllFeatures', () => {
    it('should return all features with status', () => {
      const features = manager.getAllFeatures()
      expect(Object.keys(features).length).toBeGreaterThan(10)
      expect(features.cloud_apis).toBeDefined()
      expect(features.cloud_apis.allowed).toBe(false)
    })

    it('should show all allowed for enterprise', () => {
      manager.setTier('enterprise')
      const features = manager.getAllFeatures()
      const denied = Object.values(features).filter(f => !f.allowed)
      expect(denied).toHaveLength(0)
    })
  })

  // ── Static helpers ─────────────────────────────────────────────

  describe('static helpers', () => {
    it('tierAtLeast should compare tiers correctly', () => {
      expect(FeatureGateManager.tierAtLeast('pro', 'free')).toBe(true)
      expect(FeatureGateManager.tierAtLeast('free', 'pro')).toBe(false)
      expect(FeatureGateManager.tierAtLeast('team', 'team')).toBe(true)
      expect(FeatureGateManager.tierAtLeast('enterprise', 'free')).toBe(true)
    })

    it('getRequiredTier should return correct tier', () => {
      expect(FeatureGateManager.getRequiredTier('multimodal')).toBe('pro')
      expect(FeatureGateManager.getRequiredTier('team_workspaces')).toBe('team')
      expect(FeatureGateManager.getRequiredTier('sso_saml_ldap')).toBe('enterprise')
    })
  })

  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle corrupted subscription file gracefully', () => {
      fs.writeFileSync(path.join(testDir, 'subscription.json'), 'not json')
      const m = new FeatureGateManager(testDir)
      expect(m.getTier()).toBe('free')
    })

    it('should handle missing config directory gracefully', () => {
      const nonExistentDir = path.join(testDir, 'deep', 'nested', 'dir')
      const m = new FeatureGateManager(nonExistentDir)
      expect(m.getTier()).toBe('free')
      // Setting tier should create the directory
      m.setTier('pro')
      expect(m.getTier()).toBe('pro')
    })
  })
})
