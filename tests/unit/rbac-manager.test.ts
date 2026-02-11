/**
 * Enterprise RBAC Manager Tests
 * Tests role-based access control, organization hierarchy, budget limits, audit logging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import nodePath from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => nodePath.join(tmpdir(), 'mingly-rbac-test-' + process.pid)
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

import {
  RBACManager, PERMISSIONS, ROLE_PERMISSIONS, ROLE_HIERARCHY
} from '../../src/main/security/rbac-manager'
import type { Role } from '../../src/main/security/rbac-manager'

describe('PERMISSIONS', () => {
  it('should define permissions with categories', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(15)
    for (const p of PERMISSIONS) {
      expect(p.id).toBeTruthy()
      expect(p.name).toBeTruthy()
      expect(p.description).toBeTruthy()
      expect(p.category).toBeTruthy()
    }
  })

  it('should include enterprise permissions', () => {
    const ids = PERMISSIONS.map(p => p.id)
    expect(ids).toContain('teams.manage')
    expect(ids).toContain('org.manage')
    expect(ids).toContain('audit.view')
    expect(ids).toContain('budget.view')
    expect(ids).toContain('settings.security')
    expect(ids).toContain('deployment.manage')
    expect(ids).toContain('network.manage')
  })
})

describe('ROLE_HIERARCHY', () => {
  it('should define 6 roles in correct order', () => {
    expect(ROLE_HIERARCHY.super_admin).toBeGreaterThan(ROLE_HIERARCHY.admin)
    expect(ROLE_HIERARCHY.admin).toBeGreaterThan(ROLE_HIERARCHY.manager)
    expect(ROLE_HIERARCHY.manager).toBeGreaterThan(ROLE_HIERARCHY.user)
    expect(ROLE_HIERARCHY.user).toBeGreaterThan(ROLE_HIERARCHY.viewer)
    expect(ROLE_HIERARCHY.viewer).toBeGreaterThan(ROLE_HIERARCHY.guest)
  })
})

describe('ROLE_PERMISSIONS', () => {
  it('should give super_admin all permissions', () => {
    expect(ROLE_PERMISSIONS.super_admin.length).toBe(PERMISSIONS.length)
  })

  it('should give admin all except org.manage', () => {
    expect(ROLE_PERMISSIONS.admin).not.toContain('org.manage')
    expect(ROLE_PERMISSIONS.admin.length).toBe(PERMISSIONS.length - 1)
  })

  it('should give viewer limited permissions', () => {
    expect(ROLE_PERMISSIONS.viewer.length).toBeLessThan(ROLE_PERMISSIONS.user.length)
    expect(ROLE_PERMISSIONS.viewer).toContain('chat.view')
    expect(ROLE_PERMISSIONS.viewer).not.toContain('chat.send')
  })

  it('should give manager more than user', () => {
    expect(ROLE_PERMISSIONS.manager.length).toBeGreaterThan(ROLE_PERMISSIONS.user.length)
  })

  it('should give guest only chat.view', () => {
    expect(ROLE_PERMISSIONS.guest).toEqual(['chat.view'])
  })

  it('should give user basic permissions', () => {
    expect(ROLE_PERMISSIONS.user).toContain('chat.send')
    expect(ROLE_PERMISSIONS.user).toContain('chat.view')
    expect(ROLE_PERMISSIONS.user).not.toContain('users.manage')
  })
})

describe('RBACManager', () => {
  let manager: RBACManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new RBACManager()
  })

  describe('defaults', () => {
    it('should be disabled by default', () => {
      expect(manager.isEnabled()).toBe(false)
    })

    it('should have default admin user with teamIds', () => {
      const user = manager.getCurrentUser()
      expect(user.role).toBe('admin')
      expect(user.id).toBe('default')
      expect(user.teamIds).toEqual([])
      expect(user.onboardingComplete).toBe(true)
    })
  })

  describe('enable/disable', () => {
    it('should enable RBAC', () => {
      manager.enable()
      expect(manager.isEnabled()).toBe(true)
    })

    it('should disable RBAC', () => {
      manager.enable()
      manager.disable()
      expect(manager.isEnabled()).toBe(false)
    })
  })

  describe('hasPermission', () => {
    it('should always return true when disabled', () => {
      expect(manager.hasPermission('chat.send')).toBe(true)
      expect(manager.hasPermission('users.manage')).toBe(true)
      expect(manager.hasPermission('nonexistent')).toBe(true)
    })

    it('should check role permissions when enabled', () => {
      manager.enable()
      // Default user is admin
      expect(manager.hasPermission('chat.send')).toBe(true)
      expect(manager.hasPermission('users.manage')).toBe(true)
      // Admin cannot manage org
      expect(manager.hasPermission('org.manage')).toBe(false)
    })
  })

  describe('outranks', () => {
    it('should correctly compare role hierarchy', () => {
      expect(manager.outranks('super_admin', 'admin')).toBe(true)
      expect(manager.outranks('admin', 'manager')).toBe(true)
      expect(manager.outranks('manager', 'user')).toBe(true)
      expect(manager.outranks('user', 'viewer')).toBe(true)
      expect(manager.outranks('viewer', 'guest')).toBe(true)
    })

    it('should return false for equal or lower roles', () => {
      expect(manager.outranks('admin', 'admin')).toBe(false)
      expect(manager.outranks('user', 'admin')).toBe(false)
    })
  })

  describe('getPermissionsForRole', () => {
    it('should return a copy (not the original array)', () => {
      const perms = manager.getPermissionsForRole('super_admin')
      perms.push('fake')
      expect(manager.getPermissionsForRole('super_admin').length).toBe(PERMISSIONS.length)
    })
  })

  describe('listUsers', () => {
    it('should return default user list', () => {
      const users = manager.listUsers()
      expect(users.length).toBe(1)
      expect(users[0].name).toBe('Admin')
    })
  })

  describe('addUser', () => {
    it('should add a new user with teamIds and onboardingComplete=false', () => {
      const result = manager.addUser('Alice', 'user', 'alice@test.com')
      expect(result.success).toBe(true)
      expect(result.user?.name).toBe('Alice')
      expect(result.user?.role).toBe('user')
      expect(result.user?.email).toBe('alice@test.com')
      expect(result.user?.teamIds).toEqual([])
      expect(result.user?.onboardingComplete).toBe(false)
    })

    it('should reject when user lacks permission (RBAC enabled)', () => {
      manager.enable()
      manager.addUser('Bob', 'viewer')
      const users = manager.listUsers()
      const bob = users.find(u => u.name === 'Bob')
      if (bob) manager.switchUser(bob.id)

      const result = manager.addUser('Eve', 'user')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Insufficient permissions')
    })

    it('should prevent privilege escalation', () => {
      manager.enable()
      // Admin tries to create super_admin (admin cannot outrank super_admin)
      const result = manager.addUser('Super', 'super_admin')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Cannot create user with higher or equal role')
    })
  })

  describe('updateUserRole', () => {
    it('should update user role', () => {
      manager.addUser('Alice', 'user')
      const users = manager.listUsers()
      const alice = users.find(u => u.name === 'Alice')

      const result = manager.updateUserRole(alice!.id, 'manager')
      expect(result.success).toBe(true)
    })

    it('should return error for unknown user', () => {
      const result = manager.updateUserRole('no-exist', 'admin')
      expect(result.success).toBe(false)
      expect(result.error).toContain('User not found')
    })
  })

  describe('removeUser', () => {
    it('should remove a user', () => {
      manager.addUser('Alice', 'user')
      const users = manager.listUsers()
      const alice = users.find(u => u.name === 'Alice')

      const result = manager.removeUser(alice!.id)
      expect(result.success).toBe(true)
      expect(manager.listUsers().length).toBe(1)
    })

    it('should not allow removing current user', () => {
      const result = manager.removeUser('default')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Cannot remove current user')
    })

    it('should remove user from teams on deletion', () => {
      const teamResult = manager.createTeam('Engineering')
      const userResult = manager.addUser('Bob', 'user')
      manager.addUserToTeam(userResult.user!.id, teamResult.team!.id)

      manager.removeUser(userResult.user!.id)
      const teams = manager.listTeams()
      expect(teams[0].memberIds).not.toContain(userResult.user!.id)
    })
  })

  describe('switchUser', () => {
    it('should switch to existing user', () => {
      manager.addUser('Alice', 'manager')
      const users = manager.listUsers()
      const alice = users.find(u => u.name === 'Alice')

      const result = manager.switchUser(alice!.id)
      expect(result.success).toBe(true)
      expect(manager.getCurrentUser().name).toBe('Alice')
    })

    it('should fail for unknown user', () => {
      const result = manager.switchUser('no-exist')
      expect(result.success).toBe(false)
      expect(result.error).toContain('User not found')
    })
  })

  describe('completeOnboarding', () => {
    it('should mark onboarding complete', () => {
      const result = manager.addUser('Alice', 'user')
      expect(result.user?.onboardingComplete).toBe(false)

      const onboard = manager.completeOnboarding(result.user!.id)
      expect(onboard.success).toBe(true)

      const users = manager.listUsers()
      const alice = users.find(u => u.id === result.user!.id)
      expect(alice?.onboardingComplete).toBe(true)
    })

    it('should fail for unknown user', () => {
      const result = manager.completeOnboarding('no-exist')
      expect(result.success).toBe(false)
    })
  })

  describe('organization', () => {
    it('should start with no organization', () => {
      expect(manager.getOrganization()).toBeNull()
    })

    it('should fail to create org without org.manage (admin role)', () => {
      manager.enable()
      // Default admin does not have org.manage
      const result = manager.createOrganization('Acme Corp')
      expect(result.success).toBe(false)
    })

    it('should create org when RBAC disabled (all permissions allowed)', () => {
      const result = manager.createOrganization('Acme Corp')
      expect(result.success).toBe(true)
      expect(result.org?.name).toBe('Acme Corp')
      expect(result.org?.settings.maxUsers).toBe(100)
      expect(result.org?.settings.allowedProviders).toContain('anthropic')
    })

    it('should assign all users to org on creation', () => {
      manager.addUser('Alice', 'user')
      manager.createOrganization('Acme Corp')
      const users = manager.listUsers()
      for (const u of users) {
        expect(u.orgId).toBeTruthy()
      }
    })

    it('should not allow duplicate organization', () => {
      manager.createOrganization('Acme Corp')
      const result = manager.createOrganization('Another Corp')
      expect(result.success).toBe(false)
      expect(result.error).toContain('already exists')
    })

    it('should update organization settings', () => {
      manager.createOrganization('Acme Corp')
      const result = manager.updateOrganization({ maxUsers: 500 })
      expect(result.success).toBe(true)
      expect(manager.getOrganization()?.settings.maxUsers).toBe(500)
    })
  })

  describe('teams', () => {
    it('should start with no teams', () => {
      expect(manager.listTeams()).toEqual([])
    })

    it('should create a team', () => {
      const result = manager.createTeam('Engineering')
      expect(result.success).toBe(true)
      expect(result.team?.name).toBe('Engineering')
      expect(result.team?.memberIds).toEqual([])
    })

    it('should add user to team', () => {
      const team = manager.createTeam('Engineering').team!
      const user = manager.addUser('Alice', 'user').user!

      const result = manager.addUserToTeam(user.id, team.id)
      expect(result.success).toBe(true)

      const teams = manager.listTeams()
      expect(teams[0].memberIds).toContain(user.id)

      const users = manager.listUsers()
      const alice = users.find(u => u.id === user.id)
      expect(alice?.teamIds).toContain(team.id)
    })

    it('should remove user from team', () => {
      const team = manager.createTeam('Engineering').team!
      const user = manager.addUser('Alice', 'user').user!
      manager.addUserToTeam(user.id, team.id)

      const result = manager.removeUserFromTeam(user.id, team.id)
      expect(result.success).toBe(true)

      const teams = manager.listTeams()
      expect(teams[0].memberIds).not.toContain(user.id)
    })

    it('should delete a team and clean up user references', () => {
      const team = manager.createTeam('Engineering').team!
      const user = manager.addUser('Alice', 'user').user!
      manager.addUserToTeam(user.id, team.id)

      manager.deleteTeam(team.id)
      expect(manager.listTeams()).toEqual([])

      const users = manager.listUsers()
      const alice = users.find(u => u.id === user.id)
      expect(alice?.teamIds).not.toContain(team.id)
    })
  })

  describe('budget limits', () => {
    it('should set user budget', () => {
      const user = manager.addUser('Alice', 'user').user!
      const result = manager.setUserBudget(user.id, { monthlyTokenLimit: 100000 })
      expect(result.success).toBe(true)

      const users = manager.listUsers()
      const alice = users.find(u => u.id === user.id)
      expect(alice?.budgetLimit?.monthlyTokenLimit).toBe(100000)
    })

    it('should set team budget', () => {
      const team = manager.createTeam('Engineering').team!
      const result = manager.setTeamBudget(team.id, { monthlyTokenLimit: 500000, monthlySpendLimit: 1000 })
      expect(result.success).toBe(true)

      const teams = manager.listTeams()
      expect(teams[0].budgetLimit?.monthlyTokenLimit).toBe(500000)
      expect(teams[0].budgetLimit?.monthlySpendLimit).toBe(1000)
    })

    it('should allow budget when RBAC disabled', () => {
      const result = manager.checkBudget('default', 1000, 10)
      expect(result.allowed).toBe(true)
    })

    it('should check user budget and reject when exceeded', () => {
      manager.enable()
      const user = manager.addUser('Alice', 'user').user!
      manager.setUserBudget(user.id, { monthlyTokenLimit: 100 })
      manager.recordUsage(user.id, 90, 0)

      const result = manager.checkBudget(user.id, 20, 0)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('User monthly token limit')
    })

    it('should check team budget and reject when exceeded', () => {
      manager.enable()
      const team = manager.createTeam('Engineering').team!
      const user = manager.addUser('Alice', 'user').user!
      manager.addUserToTeam(user.id, team.id)
      manager.setTeamBudget(team.id, { monthlySpendLimit: 50 })
      manager.recordUsage(user.id, 0, 40)

      const result = manager.checkBudget(user.id, 0, 20)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Team')
    })

    it('should record usage against user and team', () => {
      const team = manager.createTeam('Engineering').team!
      const user = manager.addUser('Alice', 'user').user!
      manager.addUserToTeam(user.id, team.id)
      manager.setUserBudget(user.id, { monthlyTokenLimit: 1000 })
      manager.setTeamBudget(team.id, { monthlyTokenLimit: 5000 })

      manager.recordUsage(user.id, 100, 5)

      const users = manager.listUsers()
      const alice = users.find(u => u.id === user.id)
      expect(alice?.budgetLimit?.tokensUsed).toBe(100)
      expect(alice?.budgetLimit?.spendUsed).toBe(5)

      const teams = manager.listTeams()
      expect(teams[0].budgetLimit?.tokensUsed).toBe(100)
    })
  })

  describe('audit log', () => {
    it('should record audit entries for enable/disable', () => {
      manager.enable()
      manager.disable()
      // Audit view needs permission — disabled RBAC means all allowed
      const log = manager.getAuditLog()
      expect(log.length).toBeGreaterThanOrEqual(2)
      expect(log.some(e => e.action === 'rbac.enable')).toBe(true)
      expect(log.some(e => e.action === 'rbac.disable')).toBe(true)
    })

    it('should filter by userId', () => {
      const user = manager.addUser('Alice', 'user').user!
      manager.switchUser(user.id)
      manager.switchUser('default') // Creates an audit entry for 'default'

      const log = manager.getAuditLog({ userId: 'default' })
      expect(log.every(e => e.userId === 'default')).toBe(true)
    })

    it('should filter by action prefix', () => {
      manager.addUser('Alice', 'user')
      manager.addUser('Bob', 'viewer')
      const log = manager.getAuditLog({ action: 'user.create' })
      expect(log.length).toBeGreaterThanOrEqual(2)
      expect(log.every(e => e.action.startsWith('user.create'))).toBe(true)
    })

    it('should limit results', () => {
      manager.addUser('A', 'user')
      manager.addUser('B', 'user')
      manager.addUser('C', 'user')
      const log = manager.getAuditLog({ limit: 2 })
      expect(log.length).toBe(2)
    })

    it('should return empty when viewer has no audit.view', () => {
      manager.enable()
      const user = manager.addUser('Bob', 'viewer').user!
      manager.switchUser(user.id)
      const log = manager.getAuditLog()
      expect(log).toEqual([])
    })
  })

  describe('SSO config', () => {
    it('should return default SSO config', () => {
      const sso = manager.getSSOConfig()
      expect(sso.enforceSSO).toBe(false)
    })

    it('should update SSO config when organization exists', () => {
      manager.createOrganization('Acme Corp')
      const result = manager.updateSSOConfig('oauth', { clientId: 'abc' }, true)
      expect(result.success).toBe(true)

      const sso = manager.getSSOConfig()
      expect(sso.enforceSSO).toBe(true)
      expect(sso.provider).toBe('oauth')
      expect(sso.config?.clientId).toBe('abc')
    })

    it('should fail SSO update without organization', () => {
      const result = manager.updateSSOConfig('saml', {}, false)
      expect(result.success).toBe(false)
      expect(result.error).toContain('No organization')
    })
  })

  describe('getFullState', () => {
    it('should return complete RBAC state', () => {
      const state = manager.getFullState()
      expect(state.enabled).toBe(false)
      expect(state.currentUser.role).toBe('admin')
      expect(state.users.length).toBe(1)
      expect(state.organization).toBeNull()
      expect(state.teams).toEqual([])
      expect(state.permissions.length).toBe(PERMISSIONS.length)
      expect(Object.keys(state.rolePermissions)).toContain('super_admin')
      expect(Object.keys(state.rolePermissions)).toContain('guest')
      expect(Object.keys(state.roleHierarchy).length).toBe(6)
    })
  })
})
