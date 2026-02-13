/**
 * IPC Handlers — RBAC (Enterprise Access Control) & GDPR/DSG Compliance
 */

import { IPC_CHANNELS } from '../../shared/types'
import { getRBACManager } from '../security/rbac-manager'
import { wrapHandler, requirePermission } from './ipc-utils'

export function registerRBACHandlers(): void {
  const rbacManager = getRBACManager()

  // ========================================
  // RBAC (Enterprise Access Control)
  // ========================================

  wrapHandler(IPC_CHANNELS.RBAC_GET_STATE, () => ({ success: true, state: rbacManager.getFullState() }))
  wrapHandler(IPC_CHANNELS.RBAC_ENABLE, () => { rbacManager.enable(); return { success: true } })
  wrapHandler(IPC_CHANNELS.RBAC_DISABLE, () => { rbacManager.disable(); return { success: true } })
  wrapHandler(IPC_CHANNELS.RBAC_HAS_PERMISSION, (permissionId: string) => rbacManager.hasPermission(permissionId))
  wrapHandler(IPC_CHANNELS.RBAC_GET_CURRENT_USER, () => rbacManager.getCurrentUser())
  wrapHandler(IPC_CHANNELS.RBAC_LIST_USERS, () => rbacManager.listUsers())
  wrapHandler(IPC_CHANNELS.RBAC_ADD_USER, (name: string, role: string, email?: string, teamIds?: string[]) => rbacManager.addUser(name, role as any, email, teamIds))
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_USER_ROLE, (userId: string, role: string) => rbacManager.updateUserRole(userId, role as any))
  wrapHandler(IPC_CHANNELS.RBAC_REMOVE_USER, (userId: string) => rbacManager.removeUser(userId))
  wrapHandler(IPC_CHANNELS.RBAC_SWITCH_USER, (userId: string) => rbacManager.switchUser(userId))
  wrapHandler(IPC_CHANNELS.RBAC_COMPLETE_ONBOARDING, (userId: string) => rbacManager.completeOnboarding(userId))
  wrapHandler(IPC_CHANNELS.RBAC_GET_ORGANIZATION, () => rbacManager.getOrganization())
  wrapHandler(IPC_CHANNELS.RBAC_CREATE_ORGANIZATION, (name: string, settings?: any) => rbacManager.createOrganization(name, settings))
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_ORGANIZATION, (updates: any) => rbacManager.updateOrganization(updates))
  wrapHandler(IPC_CHANNELS.RBAC_LIST_TEAMS, () => rbacManager.listTeams())
  wrapHandler(IPC_CHANNELS.RBAC_CREATE_TEAM, (name: string, managerId?: string) => rbacManager.createTeam(name, managerId))
  wrapHandler(IPC_CHANNELS.RBAC_DELETE_TEAM, (teamId: string) => rbacManager.deleteTeam(teamId))
  wrapHandler(IPC_CHANNELS.RBAC_ADD_USER_TO_TEAM, (userId: string, teamId: string) => rbacManager.addUserToTeam(userId, teamId))
  wrapHandler(IPC_CHANNELS.RBAC_REMOVE_USER_FROM_TEAM, (userId: string, teamId: string) => rbacManager.removeUserFromTeam(userId, teamId))
  wrapHandler(IPC_CHANNELS.RBAC_SET_USER_BUDGET, (userId: string, limit: any) => rbacManager.setUserBudget(userId, limit))
  wrapHandler(IPC_CHANNELS.RBAC_SET_TEAM_BUDGET, (teamId: string, limit: any) => rbacManager.setTeamBudget(teamId, limit))
  wrapHandler(IPC_CHANNELS.RBAC_CHECK_BUDGET, (userId: string, tokens: number, costCents: number) => rbacManager.checkBudget(userId, tokens, costCents))
  wrapHandler(IPC_CHANNELS.RBAC_GET_AUDIT_LOG, (opts?: any) => rbacManager.getAuditLog(opts))
  wrapHandler(IPC_CHANNELS.RBAC_CLEAR_AUDIT_LOG, () => rbacManager.clearAuditLog())
  wrapHandler(IPC_CHANNELS.RBAC_GET_SSO_CONFIG, () => rbacManager.getSSOConfig())
  wrapHandler(IPC_CHANNELS.RBAC_UPDATE_SSO_CONFIG, (provider: string, ssoConfig: any, enforce: boolean) => rbacManager.updateSSOConfig(provider as any, ssoConfig, enforce))

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
