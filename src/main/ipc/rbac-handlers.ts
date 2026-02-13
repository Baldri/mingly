/**
 * IPC Handlers — RBAC (Enterprise Access Control) & GDPR/DSG Compliance
 */

import { IPC_CHANNELS } from '../../shared/types'
import { getRBACManager } from '../security/rbac-manager'
import { wrapHandler, requirePermission, requireFeature } from './ipc-utils'

export function registerRBACHandlers(): void {
  const rbacManager = getRBACManager()

  // ========================================
  // RBAC (Enterprise Access Control)
  // ========================================

  // RBAC state (read-only) — available to all tiers for UI display
  wrapHandler(IPC_CHANNELS.RBAC_GET_STATE, () => ({ success: true, state: rbacManager.getFullState() }))
  wrapHandler(IPC_CHANNELS.RBAC_HAS_PERMISSION, (permissionId: string) => rbacManager.hasPermission(permissionId))
  wrapHandler(IPC_CHANNELS.RBAC_GET_CURRENT_USER, () => rbacManager.getCurrentUser())

  // RBAC user & org management — Team+ tier
  wrapHandler(IPC_CHANNELS.RBAC_ENABLE, () => { requireFeature('team_rbac'); rbacManager.enable(); return { success: true } })
  wrapHandler(IPC_CHANNELS.RBAC_DISABLE, () => { requireFeature('team_rbac'); rbacManager.disable(); return { success: true } })
  wrapHandler(IPC_CHANNELS.RBAC_LIST_USERS, () => { requireFeature('team_rbac'); return rbacManager.listUsers() })
  wrapHandler(IPC_CHANNELS.RBAC_ADD_USER, (name: string, role: string, email?: string, teamIds?: string[]) => { requireFeature('team_rbac'); return rbacManager.addUser(name, role as any, email, teamIds) })
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_USER_ROLE, (userId: string, role: string) => { requireFeature('team_rbac'); return rbacManager.updateUserRole(userId, role as any) })
  wrapHandler(IPC_CHANNELS.RBAC_REMOVE_USER, (userId: string) => { requireFeature('team_rbac'); return rbacManager.removeUser(userId) })
  wrapHandler(IPC_CHANNELS.RBAC_SWITCH_USER, (userId: string) => { requireFeature('team_rbac'); return rbacManager.switchUser(userId) })
  wrapHandler(IPC_CHANNELS.RBAC_COMPLETE_ONBOARDING, (userId: string) => { requireFeature('team_rbac'); return rbacManager.completeOnboarding(userId) })
  wrapHandler(IPC_CHANNELS.RBAC_GET_ORGANIZATION, () => { requireFeature('team_rbac'); return rbacManager.getOrganization() })
  wrapHandler(IPC_CHANNELS.RBAC_CREATE_ORGANIZATION, (name: string, settings?: any) => { requireFeature('team_rbac'); return rbacManager.createOrganization(name, settings) })
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_ORGANIZATION, (updates: any) => { requireFeature('team_rbac'); return rbacManager.updateOrganization(updates) })

  // Team management — Team+ tier
  wrapHandler(IPC_CHANNELS.RBAC_LIST_TEAMS, () => { requireFeature('team_rbac'); return rbacManager.listTeams() })
  wrapHandler(IPC_CHANNELS.RBAC_CREATE_TEAM, (name: string, managerId?: string) => { requireFeature('team_rbac'); return rbacManager.createTeam(name, managerId) })
  wrapHandler(IPC_CHANNELS.RBAC_DELETE_TEAM, (teamId: string) => { requireFeature('team_rbac'); return rbacManager.deleteTeam(teamId) })
  wrapHandler(IPC_CHANNELS.RBAC_ADD_USER_TO_TEAM, (userId: string, teamId: string) => { requireFeature('team_rbac'); return rbacManager.addUserToTeam(userId, teamId) })
  wrapHandler(IPC_CHANNELS.RBAC_REMOVE_USER_FROM_TEAM, (userId: string, teamId: string) => { requireFeature('team_rbac'); return rbacManager.removeUserFromTeam(userId, teamId) })
  wrapHandler(IPC_CHANNELS.RBAC_SET_USER_BUDGET, (userId: string, limit: any) => { requireFeature('team_rbac'); return rbacManager.setUserBudget(userId, limit) })
  wrapHandler(IPC_CHANNELS.RBAC_SET_TEAM_BUDGET, (teamId: string, limit: any) => { requireFeature('team_rbac'); return rbacManager.setTeamBudget(teamId, limit) })
  wrapHandler(IPC_CHANNELS.RBAC_CHECK_BUDGET, (userId: string, tokens: number, costCents: number) => { requireFeature('team_rbac'); return rbacManager.checkBudget(userId, tokens, costCents) })

  // Audit logs — Team+ tier
  wrapHandler(IPC_CHANNELS.RBAC_GET_AUDIT_LOG, (opts?: any) => { requireFeature('audit_logs'); return rbacManager.getAuditLog(opts) })
  wrapHandler(IPC_CHANNELS.RBAC_CLEAR_AUDIT_LOG, () => { requireFeature('audit_logs'); return rbacManager.clearAuditLog() })

  // SSO config — Team+ for OAuth, Enterprise for SAML/LDAP
  wrapHandler(IPC_CHANNELS.RBAC_GET_SSO_CONFIG, () => { requireFeature('sso_oauth'); return rbacManager.getSSOConfig() })
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_SSO_CONFIG, (provider: string, ssoConfig: any, enforce: boolean) => {
    // SAML/LDAP requires Enterprise; OAuth requires Team+
    if (provider === 'saml' || provider === 'ldap') {
      requireFeature('sso_saml_ldap')
    } else {
      requireFeature('sso_oauth')
    }
    return rbacManager.updateSSOConfig(provider as any, ssoConfig, enforce)
  })

  // ========================================
  // DSGVO/DSG Compliance
  // ========================================

  wrapHandler(IPC_CHANNELS.GDPR_DELETE_USER_DATA, (userId: string) => {
    requirePermission('users.manage')
    return rbacManager.deleteUserData(userId)
  })

  wrapHandler(IPC_CHANNELS.GDPR_EXPORT_USER_DATA, (userId: string) => {
    return rbacManager.exportUserData(userId)
  })

  wrapHandler(IPC_CHANNELS.GDPR_ENFORCE_RETENTION, () => {
    requirePermission('org.manage')
    return rbacManager.enforceRetention()
  })
}
