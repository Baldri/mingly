/**
 * Enterprise RBAC Manager — Role-Based Access Control with Organization Hierarchy.
 *
 * Roles (ordered by privilege):
 *   super_admin > admin > manager > user > viewer > guest
 *
 * Hierarchy:
 *   Organization → Team → User
 *
 * Features:
 *   - Permission matrix (LLM-Provider, RAG, Settings, Integrations, etc.)
 *   - Token/Budget limits per user & team
 *   - GDPR-compliant audit logging
 *   - User onboarding flow support
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type Role = 'super_admin' | 'admin' | 'manager' | 'user' | 'viewer' | 'guest'

export const ROLE_HIERARCHY: Record<Role, number> = {
  super_admin: 100,
  admin: 80,
  manager: 60,
  user: 40,
  viewer: 20,
  guest: 10
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface Permission {
  id: string
  name: string
  description: string
  category: string
}

export const PERMISSIONS: Permission[] = [
  // Chat
  { id: 'chat.send', name: 'Send Messages', description: 'Send messages to LLM providers', category: 'chat' },
  { id: 'chat.view', name: 'View Conversations', description: 'View conversation history', category: 'chat' },
  { id: 'chat.delete', name: 'Delete Conversations', description: 'Delete conversation history', category: 'chat' },

  // Settings
  { id: 'settings.api_keys', name: 'Manage API Keys', description: 'Add/remove API keys', category: 'settings' },
  { id: 'settings.general', name: 'Change Settings', description: 'Modify general settings', category: 'settings' },
  { id: 'settings.security', name: 'Security Settings', description: 'Modify security and RBAC settings', category: 'settings' },

  // RAG
  { id: 'rag.search', name: 'RAG Search', description: 'Search knowledge base', category: 'rag' },
  { id: 'rag.index', name: 'RAG Index', description: 'Index documents into knowledge base', category: 'rag' },
  { id: 'rag.manage', name: 'RAG Manage', description: 'Create/delete RAG collections', category: 'rag' },

  // MCP
  { id: 'mcp.connect', name: 'MCP Connect', description: 'Connect to MCP servers', category: 'mcp' },
  { id: 'mcp.execute', name: 'MCP Execute', description: 'Execute MCP tools', category: 'mcp' },

  // Integrations
  { id: 'integrations.manage', name: 'Manage Integrations', description: 'Configure Slack, Notion, etc.', category: 'integrations' },

  // Analytics & Budget
  { id: 'analytics.view', name: 'View Analytics', description: 'View usage analytics and costs', category: 'analytics' },
  { id: 'budget.manage', name: 'Manage Budget', description: 'Set and modify budget limits', category: 'budget' },
  { id: 'budget.view', name: 'View Budget', description: 'View budget status and limits', category: 'budget' },

  // User & Org management
  { id: 'users.manage', name: 'Manage Users', description: 'Create/edit/delete user accounts', category: 'admin' },
  { id: 'teams.manage', name: 'Manage Teams', description: 'Create/edit/delete teams', category: 'admin' },
  { id: 'org.manage', name: 'Manage Organization', description: 'Configure organization settings', category: 'admin' },
  { id: 'audit.view', name: 'View Audit Log', description: 'View GDPR-compliant audit trail', category: 'admin' },

  // Export
  { id: 'export.data', name: 'Export Data', description: 'Export conversations and GDPR data', category: 'export' },

  // Deployment
  { id: 'deployment.manage', name: 'Manage Deployment', description: 'Start/stop server, manage remotes', category: 'deployment' },

  // Network AI
  { id: 'network.manage', name: 'Manage Network AI', description: 'Add/remove local AI servers', category: 'network' }
]

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  super_admin: PERMISSIONS.map(p => p.id),
  admin: PERMISSIONS.map(p => p.id).filter(id => id !== 'org.manage'),
  manager: [
    'chat.send', 'chat.view', 'chat.delete',
    'settings.general',
    'rag.search', 'rag.index', 'rag.manage',
    'mcp.connect', 'mcp.execute',
    'integrations.manage',
    'analytics.view', 'budget.manage', 'budget.view',
    'teams.manage', 'audit.view',
    'export.data',
    'network.manage'
  ],
  user: [
    'chat.send', 'chat.view',
    'settings.general',
    'rag.search', 'rag.index',
    'mcp.connect',
    'analytics.view', 'budget.view',
    'export.data'
  ],
  viewer: [
    'chat.view',
    'rag.search',
    'analytics.view', 'budget.view'
  ],
  guest: [
    'chat.view'
  ]
}

// ---------------------------------------------------------------------------
// Organization hierarchy
// ---------------------------------------------------------------------------

export interface Organization {
  id: string
  name: string
  createdAt: number
  settings: OrgSettings
}

export interface OrgSettings {
  maxUsers: number
  maxTeams: number
  allowedProviders: string[]   // e.g. ['anthropic', 'openai', 'google']
  enforceSSO: boolean
  ssoProvider?: 'saml' | 'oauth' | 'ldap'
  ssoConfig?: Record<string, string>
  dataRetentionDays: number
}

export interface Team {
  id: string
  name: string
  orgId: string
  createdAt: number
  budgetLimit?: BudgetLimit
  memberIds: string[]
  managerId?: string
}

export interface BudgetLimit {
  monthlyTokenLimit: number    // max tokens per month (0 = unlimited)
  monthlySpendLimit: number    // max spend in cents per month (0 = unlimited)
  tokensUsed: number
  spendUsed: number
  resetDate: number            // epoch ms — first day of current billing period
}

// ---------------------------------------------------------------------------
// User profile (extended)
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string
  name: string
  email?: string
  role: Role
  orgId?: string
  teamIds: string[]
  createdAt: number
  lastActive?: number
  onboardingComplete: boolean
  budgetLimit?: BudgetLimit
  allowedProviders?: string[]  // overrides team/org if set
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string
  timestamp: number
  userId: string
  userName: string
  action: string
  resource: string
  details?: string
  ip?: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RBACConfig {
  enabled: boolean
  currentUser: UserProfile
  users: UserProfile[]
  organization: Organization | null
  teams: Team[]
  auditLog: AuditEntry[]
}

// ---------------------------------------------------------------------------
// RBACManager class
// ---------------------------------------------------------------------------

export class RBACManager {
  private configPath: string
  private config: RBACConfig
  private maxAuditEntries = 10_000

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'rbac-config.json')
    this.config = this.loadConfig()
  }

  // ---- persistence --------------------------------------------------------

  private loadConfig(): RBACConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
        // Migrate old configs that lack new fields
        return this.migrateConfig(raw)
      }
    } catch (error) {
      console.error('Failed to load RBAC config:', error)
    }
    return this.defaultConfig()
  }

  private migrateConfig(raw: any): RBACConfig {
    const cfg = raw as RBACConfig
    if (!cfg.organization) cfg.organization = null
    if (!cfg.teams) cfg.teams = []
    if (!cfg.auditLog) cfg.auditLog = []
    // Ensure all users have new fields
    for (const u of cfg.users) {
      if (!Array.isArray(u.teamIds)) u.teamIds = []
      if (u.onboardingComplete === undefined) u.onboardingComplete = true
    }
    if (!Array.isArray(cfg.currentUser.teamIds)) cfg.currentUser.teamIds = []
    if (cfg.currentUser.onboardingComplete === undefined) cfg.currentUser.onboardingComplete = true
    return cfg
  }

  private defaultConfig(): RBACConfig {
    const defaultUser: UserProfile = {
      id: 'default',
      name: 'Admin',
      role: 'admin',
      teamIds: [],
      createdAt: Date.now(),
      onboardingComplete: true
    }
    return {
      enabled: false,
      currentUser: defaultUser,
      users: [defaultUser],
      organization: null,
      teams: [],
      auditLog: []
    }
  }

  private saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    } catch (error) {
      console.error('Failed to save RBAC config:', error)
    }
  }

  // ---- enable / disable ---------------------------------------------------

  isEnabled(): boolean {
    return this.config.enabled
  }

  enable(): void {
    this.config.enabled = true
    this.audit('rbac.enable', 'system', 'RBAC enabled')
    this.saveConfig()
  }

  disable(): void {
    this.config.enabled = false
    this.audit('rbac.disable', 'system', 'RBAC disabled')
    this.saveConfig()
  }

  // ---- current user -------------------------------------------------------

  getCurrentUser(): UserProfile {
    return { ...this.config.currentUser, teamIds: [...this.config.currentUser.teamIds] }
  }

  // ---- permission checking ------------------------------------------------

  hasPermission(permissionId: string): boolean {
    if (!this.config.enabled) return true
    const role = this.config.currentUser.role
    return ROLE_PERMISSIONS[role]?.includes(permissionId) || false
  }

  getPermissionsForRole(role: Role): string[] {
    return [...(ROLE_PERMISSIONS[role] || [])]
  }

  /** Check whether roleA outranks roleB (useful for preventing privilege escalation) */
  outranks(roleA: Role, roleB: Role): boolean {
    return (ROLE_HIERARCHY[roleA] || 0) > (ROLE_HIERARCHY[roleB] || 0)
  }

  // ---- user management ----------------------------------------------------

  listUsers(): UserProfile[] {
    return this.config.users.map(u => ({ ...u, teamIds: [...u.teamIds] }))
  }

  addUser(
    name: string,
    role: Role,
    email?: string,
    teamIds?: string[]
  ): { success: boolean; user?: UserProfile; error?: string } {
    if (!this.hasPermission('users.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    // Prevent privilege escalation
    if (!this.outranks(this.config.currentUser.role, role) && this.config.currentUser.role !== role) {
      return { success: false, error: 'Cannot create user with higher or equal role' }
    }

    const user: UserProfile = {
      id: `user_${Date.now()}`,
      name,
      email,
      role,
      orgId: this.config.organization?.id,
      teamIds: teamIds || [],
      createdAt: Date.now(),
      onboardingComplete: false
    }
    this.config.users.push(user)
    this.audit('user.create', `user:${user.id}`, `Created user ${name} (${role})`)
    this.saveConfig()
    return { success: true, user: { ...user, teamIds: [...user.teamIds] } }
  }

  updateUserRole(userId: string, role: Role): { success: boolean; error?: string } {
    if (!this.hasPermission('users.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found' }

    // Prevent escalation beyond own level
    if (!this.outranks(this.config.currentUser.role, role) && this.config.currentUser.role !== 'super_admin') {
      return { success: false, error: 'Cannot assign role equal to or above your own' }
    }

    const oldRole = user.role
    user.role = role
    if (this.config.currentUser.id === userId) {
      this.config.currentUser.role = role
    }
    this.audit('user.role_change', `user:${userId}`, `Role changed from ${oldRole} to ${role}`)
    this.saveConfig()
    return { success: true }
  }

  removeUser(userId: string): { success: boolean; error?: string } {
    if (!this.hasPermission('users.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    if (userId === this.config.currentUser.id) {
      return { success: false, error: 'Cannot remove current user' }
    }

    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found' }

    this.config.users = this.config.users.filter(u => u.id !== userId)
    // Also remove from all teams
    for (const team of this.config.teams) {
      team.memberIds = team.memberIds.filter(id => id !== userId)
    }
    this.audit('user.delete', `user:${userId}`, `Removed user ${user.name}`)
    this.saveConfig()
    return { success: true }
  }

  switchUser(userId: string): { success: boolean; error?: string } {
    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found' }

    this.config.currentUser = user
    user.lastActive = Date.now()
    this.audit('user.switch', `user:${userId}`, `Switched to user ${user.name}`)
    this.saveConfig()
    return { success: true }
  }

  completeOnboarding(userId: string): { success: boolean; error?: string } {
    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found' }
    user.onboardingComplete = true
    if (this.config.currentUser.id === userId) {
      this.config.currentUser.onboardingComplete = true
    }
    this.audit('user.onboarding_complete', `user:${userId}`, `Onboarding completed for ${user.name}`)
    this.saveConfig()
    return { success: true }
  }

  // ---- organization -------------------------------------------------------

  getOrganization(): Organization | null {
    return this.config.organization ? { ...this.config.organization, settings: { ...this.config.organization.settings } } : null
  }

  createOrganization(name: string, settings?: Partial<OrgSettings>): { success: boolean; org?: Organization; error?: string } {
    if (!this.hasPermission('org.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    if (this.config.organization) {
      return { success: false, error: 'Organization already exists' }
    }

    const org: Organization = {
      id: `org_${Date.now()}`,
      name,
      createdAt: Date.now(),
      settings: {
        maxUsers: 100,
        maxTeams: 20,
        allowedProviders: ['anthropic', 'openai', 'google'],
        enforceSSO: false,
        dataRetentionDays: 365,
        ...settings
      }
    }
    this.config.organization = org
    // Assign all existing users to this org
    for (const u of this.config.users) {
      u.orgId = org.id
    }
    this.config.currentUser.orgId = org.id
    this.audit('org.create', `org:${org.id}`, `Created organization ${name}`)
    this.saveConfig()
    return { success: true, org: { ...org, settings: { ...org.settings } } }
  }

  updateOrganization(updates: Partial<OrgSettings>): { success: boolean; error?: string } {
    if (!this.hasPermission('org.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    if (!this.config.organization) {
      return { success: false, error: 'No organization configured' }
    }
    this.config.organization.settings = { ...this.config.organization.settings, ...updates }
    this.audit('org.update', `org:${this.config.organization.id}`, 'Organization settings updated')
    this.saveConfig()
    return { success: true }
  }

  // ---- team management ----------------------------------------------------

  listTeams(): Team[] {
    return this.config.teams.map(t => ({ ...t, memberIds: [...t.memberIds] }))
  }

  createTeam(name: string, managerId?: string): { success: boolean; team?: Team; error?: string } {
    if (!this.hasPermission('teams.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const orgId = this.config.organization?.id || 'default'
    const team: Team = {
      id: `team_${Date.now()}`,
      name,
      orgId,
      createdAt: Date.now(),
      memberIds: [],
      managerId
    }
    this.config.teams.push(team)
    this.audit('team.create', `team:${team.id}`, `Created team ${name}`)
    this.saveConfig()
    return { success: true, team: { ...team, memberIds: [] } }
  }

  deleteTeam(teamId: string): { success: boolean; error?: string } {
    if (!this.hasPermission('teams.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const team = this.config.teams.find(t => t.id === teamId)
    if (!team) return { success: false, error: 'Team not found' }

    // Remove team reference from users
    for (const u of this.config.users) {
      u.teamIds = u.teamIds.filter(id => id !== teamId)
    }
    this.config.teams = this.config.teams.filter(t => t.id !== teamId)
    this.audit('team.delete', `team:${teamId}`, `Deleted team ${team.name}`)
    this.saveConfig()
    return { success: true }
  }

  addUserToTeam(userId: string, teamId: string): { success: boolean; error?: string } {
    if (!this.hasPermission('teams.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const team = this.config.teams.find(t => t.id === teamId)
    if (!team) return { success: false, error: 'Team not found' }
    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found' }

    if (!team.memberIds.includes(userId)) {
      team.memberIds.push(userId)
    }
    if (!user.teamIds.includes(teamId)) {
      user.teamIds.push(teamId)
    }
    if (this.config.currentUser.id === userId && !this.config.currentUser.teamIds.includes(teamId)) {
      this.config.currentUser.teamIds.push(teamId)
    }
    this.audit('team.add_member', `team:${teamId}`, `Added ${user.name} to team ${team.name}`)
    this.saveConfig()
    return { success: true }
  }

  removeUserFromTeam(userId: string, teamId: string): { success: boolean; error?: string } {
    if (!this.hasPermission('teams.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const team = this.config.teams.find(t => t.id === teamId)
    if (!team) return { success: false, error: 'Team not found' }

    team.memberIds = team.memberIds.filter(id => id !== userId)
    const user = this.config.users.find(u => u.id === userId)
    if (user) {
      user.teamIds = user.teamIds.filter(id => id !== teamId)
    }
    if (this.config.currentUser.id === userId) {
      this.config.currentUser.teamIds = this.config.currentUser.teamIds.filter(id => id !== teamId)
    }
    this.saveConfig()
    return { success: true }
  }

  // ---- budget limits ------------------------------------------------------

  setUserBudget(userId: string, limit: Partial<BudgetLimit>): { success: boolean; error?: string } {
    if (!this.hasPermission('budget.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found' }

    user.budgetLimit = {
      monthlyTokenLimit: limit.monthlyTokenLimit ?? 0,
      monthlySpendLimit: limit.monthlySpendLimit ?? 0,
      tokensUsed: user.budgetLimit?.tokensUsed ?? 0,
      spendUsed: user.budgetLimit?.spendUsed ?? 0,
      resetDate: user.budgetLimit?.resetDate ?? Date.now()
    }
    if (this.config.currentUser.id === userId) {
      this.config.currentUser.budgetLimit = user.budgetLimit
    }
    this.audit('budget.set_user', `user:${userId}`, `Budget limit set: ${limit.monthlyTokenLimit ?? 0} tokens, ${limit.monthlySpendLimit ?? 0} cents`)
    this.saveConfig()
    return { success: true }
  }

  setTeamBudget(teamId: string, limit: Partial<BudgetLimit>): { success: boolean; error?: string } {
    if (!this.hasPermission('budget.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const team = this.config.teams.find(t => t.id === teamId)
    if (!team) return { success: false, error: 'Team not found' }

    team.budgetLimit = {
      monthlyTokenLimit: limit.monthlyTokenLimit ?? 0,
      monthlySpendLimit: limit.monthlySpendLimit ?? 0,
      tokensUsed: team.budgetLimit?.tokensUsed ?? 0,
      spendUsed: team.budgetLimit?.spendUsed ?? 0,
      resetDate: team.budgetLimit?.resetDate ?? Date.now()
    }
    this.audit('budget.set_team', `team:${teamId}`, `Budget limit set: ${limit.monthlyTokenLimit ?? 0} tokens`)
    this.saveConfig()
    return { success: true }
  }

  /** Check if a usage amount would exceed user or team budget. */
  checkBudget(userId: string, tokensToUse: number, costCents: number): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true }

    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { allowed: true }

    // User-level check
    if (user.budgetLimit) {
      this.maybeResetBudget(user.budgetLimit)
      if (user.budgetLimit.monthlyTokenLimit > 0 &&
          user.budgetLimit.tokensUsed + tokensToUse > user.budgetLimit.monthlyTokenLimit) {
        return { allowed: false, reason: 'User monthly token limit exceeded' }
      }
      if (user.budgetLimit.monthlySpendLimit > 0 &&
          user.budgetLimit.spendUsed + costCents > user.budgetLimit.monthlySpendLimit) {
        return { allowed: false, reason: 'User monthly spend limit exceeded' }
      }
    }

    // Team-level check (any team the user belongs to)
    for (const teamId of user.teamIds) {
      const team = this.config.teams.find(t => t.id === teamId)
      if (team?.budgetLimit) {
        this.maybeResetBudget(team.budgetLimit)
        if (team.budgetLimit.monthlyTokenLimit > 0 &&
            team.budgetLimit.tokensUsed + tokensToUse > team.budgetLimit.monthlyTokenLimit) {
          return { allowed: false, reason: `Team "${team.name}" monthly token limit exceeded` }
        }
        if (team.budgetLimit.monthlySpendLimit > 0 &&
            team.budgetLimit.spendUsed + costCents > team.budgetLimit.monthlySpendLimit) {
          return { allowed: false, reason: `Team "${team.name}" monthly spend limit exceeded` }
        }
      }
    }

    return { allowed: true }
  }

  /** Record usage against user and team budgets. */
  recordUsage(userId: string, tokens: number, costCents: number): void {
    const user = this.config.users.find(u => u.id === userId)
    if (!user) return

    if (user.budgetLimit) {
      this.maybeResetBudget(user.budgetLimit)
      user.budgetLimit.tokensUsed += tokens
      user.budgetLimit.spendUsed += costCents
    }

    for (const teamId of user.teamIds) {
      const team = this.config.teams.find(t => t.id === teamId)
      if (team?.budgetLimit) {
        this.maybeResetBudget(team.budgetLimit)
        team.budgetLimit.tokensUsed += tokens
        team.budgetLimit.spendUsed += costCents
      }
    }

    this.saveConfig()
  }

  private maybeResetBudget(budget: BudgetLimit): void {
    const now = Date.now()
    const oneMonth = 30 * 24 * 60 * 60 * 1000
    if (now - budget.resetDate > oneMonth) {
      budget.tokensUsed = 0
      budget.spendUsed = 0
      budget.resetDate = now
    }
  }

  // ---- audit logging (GDPR-compliant) ------------------------------------

  private audit(action: string, resource: string, details?: string): void {
    const entry: AuditEntry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      userId: this.config.currentUser.id,
      userName: this.config.currentUser.name,
      action,
      resource,
      details
    }
    this.config.auditLog.push(entry)
    // Trim oldest entries in-place to prevent unbounded growth
    if (this.config.auditLog.length > this.maxAuditEntries) {
      const excess = this.config.auditLog.length - this.maxAuditEntries
      this.config.auditLog.splice(0, excess)
    }
  }

  getAuditLog(opts?: { limit?: number; userId?: string; action?: string; since?: number }): AuditEntry[] {
    if (!this.hasPermission('audit.view')) return []

    let entries = [...this.config.auditLog]
    if (opts?.userId) entries = entries.filter(e => e.userId === opts.userId)
    if (opts?.action) entries = entries.filter(e => e.action.startsWith(opts.action!))
    if (opts?.since) entries = entries.filter(e => e.timestamp >= opts.since!)
    entries.sort((a, b) => b.timestamp - a.timestamp)
    if (opts?.limit) entries = entries.slice(0, opts.limit)
    return entries
  }

  clearAuditLog(): { success: boolean; error?: string } {
    if (!this.hasPermission('org.manage')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const count = this.config.auditLog.length
    this.config.auditLog = []
    this.audit('audit.clear', 'system', `Cleared ${count} audit entries`)
    this.saveConfig()
    return { success: true }
  }

  /**
   * DSGVO/DSG Art. 17 — Right to Erasure (Recht auf Löschung).
   * Removes a user and anonymizes their audit trail.
   */
  deleteUserData(userId: string): { success: boolean; error?: string; entriesAnonymized?: number } {
    if (!this.hasPermission('users.manage') && this.config.currentUser.id !== userId) {
      return { success: false, error: 'Insufficient permissions (requires users.manage or own account)' }
    }
    if (userId === this.config.currentUser.id && this.config.users.length <= 1) {
      return { success: false, error: 'Cannot delete the only remaining user' }
    }

    // Remove user
    this.config.users = this.config.users.filter(u => u.id !== userId)
    // Remove from teams
    for (const team of this.config.teams) {
      team.memberIds = team.memberIds.filter(id => id !== userId)
    }

    // Anonymize audit entries (keep for compliance but strip PII)
    let anonymized = 0
    for (const entry of this.config.auditLog) {
      if (entry.userId === userId) {
        entry.userName = '[deleted]'
        entry.details = entry.details ? '[redacted]' : undefined
        anonymized++
      }
    }

    this.audit('gdpr.user_data_deleted', `user:${userId}`, `User data deleted, ${anonymized} audit entries anonymized`)
    this.saveConfig()
    return { success: true, entriesAnonymized: anonymized }
  }

  /**
   * DSGVO/DSG — Enforce data retention policy.
   * Removes audit entries older than the configured retention period.
   */
  enforceRetention(): { success: boolean; entriesRemoved: number } {
    const retentionDays = this.config.organization?.settings.dataRetentionDays || 365
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)
    const before = this.config.auditLog.length
    this.config.auditLog = this.config.auditLog.filter(e => e.timestamp >= cutoff)
    const removed = before - this.config.auditLog.length
    if (removed > 0) {
      this.audit('audit.retention_enforced', 'system', `Removed ${removed} entries older than ${retentionDays} days`)
      this.saveConfig()
    }
    return { success: true, entriesRemoved: removed }
  }

  /**
   * DSGVO/DSG Art. 20 — Right to Data Portability (Recht auf Datenübertragbarkeit).
   * Export all data for a specific user in a portable format.
   */
  exportUserData(userId: string): { success: boolean; data?: object; error?: string } {
    if (!this.hasPermission('export.data') && this.config.currentUser.id !== userId) {
      return { success: false, error: 'Insufficient permissions' }
    }
    const user = this.config.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found' }

    const userAuditEntries = this.config.auditLog.filter(e => e.userId === userId)
    const userTeams = this.config.teams.filter(t => t.memberIds.includes(userId))

    return {
      success: true,
      data: {
        exportDate: new Date().toISOString(),
        format: 'DSGVO/DSG-compliant-export',
        user: { ...user, teamIds: [...user.teamIds] },
        teams: userTeams.map(t => ({ id: t.id, name: t.name })),
        auditEntries: userAuditEntries.length,
        organization: this.config.organization ? { id: this.config.organization.id, name: this.config.organization.name } : null
      }
    }
  }

  // ---- SSO placeholder (config storage only) ------------------------------

  getSSOConfig(): { enforceSSO: boolean; provider?: string; config?: Record<string, string> } {
    if (!this.config.organization) {
      return { enforceSSO: false }
    }
    return {
      enforceSSO: this.config.organization.settings.enforceSSO,
      provider: this.config.organization.settings.ssoProvider,
      config: this.config.organization.settings.ssoConfig
    }
  }

  updateSSOConfig(provider: 'saml' | 'oauth' | 'ldap', ssoConfig: Record<string, string>, enforce: boolean): { success: boolean; error?: string } {
    if (!this.hasPermission('settings.security')) {
      return { success: false, error: 'Insufficient permissions' }
    }
    if (!this.config.organization) {
      return { success: false, error: 'No organization configured' }
    }
    this.config.organization.settings.ssoProvider = provider
    this.config.organization.settings.ssoConfig = ssoConfig
    this.config.organization.settings.enforceSSO = enforce
    this.audit('sso.update', 'system', `SSO updated: ${provider}, enforce=${enforce}`)
    this.saveConfig()
    return { success: true }
  }

  // ---- full state export (for renderer) -----------------------------------

  getFullState(): {
    enabled: boolean
    currentUser: UserProfile
    users: UserProfile[]
    organization: Organization | null
    teams: Team[]
    permissions: Permission[]
    rolePermissions: Record<Role, string[]>
    roleHierarchy: Record<Role, number>
  } {
    return {
      enabled: this.config.enabled,
      currentUser: this.getCurrentUser(),
      users: this.listUsers(),
      organization: this.getOrganization(),
      teams: this.listTeams(),
      permissions: PERMISSIONS,
      rolePermissions: ROLE_PERMISSIONS,
      roleHierarchy: ROLE_HIERARCHY
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: RBACManager | null = null
export function getRBACManager(): RBACManager {
  if (!instance) instance = new RBACManager()
  return instance
}
