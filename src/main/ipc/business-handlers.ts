/**
 * IPC Handlers — Budget, Feature Gate, License, Tracking, Auto-Updater, Deployment, Orchestrator
 */

import { IPC_CHANNELS } from '../../shared/types'
import { getBudgetManager } from '../tracking/budget-manager'
import { getTrackingEngine } from '../tracking/tracking-engine'
import { getFeatureGateManager } from '../services/feature-gate-manager'
import { getDeploymentManager } from '../server/deployment-manager'
import { getHybridOrchestrator } from '../routing/hybrid-orchestrator'
import { getAutoUpdater } from '../updater/auto-updater'
import { wrapHandler, requirePermission, requireFeature } from './ipc-utils'

export function registerBusinessHandlers(): void {
  const trackingEngine = getTrackingEngine()
  const budgetManager = getBudgetManager()
  const featureGateManager = getFeatureGateManager()
  const deploymentManager = getDeploymentManager()
  const orchestrator = getHybridOrchestrator()
  const updater = getAutoUpdater()

  // ========================================
  // Tracking & Analytics
  // ========================================

  wrapHandler(IPC_CHANNELS.TRACKING_GET_SUMMARY, (fromMs?: number, toMs?: number) => ({ success: true, summary: trackingEngine.getSummary(fromMs, toMs) }))
  wrapHandler(IPC_CHANNELS.TRACKING_GET_DAILY_USAGE, (days?: number) => ({ success: true, dailyUsage: trackingEngine.getDailyUsage(days) }))
  wrapHandler(IPC_CHANNELS.TRACKING_GET_RECENT_EVENTS, (limit?: number) => ({ success: true, events: trackingEngine.getRecentEvents(limit) }))

  // ========================================
  // Budget Management
  // ========================================

  wrapHandler(IPC_CHANNELS.BUDGET_GET_CONFIG, () => { requirePermission('budget.view'); return { success: true, config: budgetManager.getConfig() } })
  wrapHandler(IPC_CHANNELS.BUDGET_UPDATE_CONFIG, (updates: any) => { requirePermission('budget.manage'); return budgetManager.updateConfig(updates) })
  wrapHandler(IPC_CHANNELS.BUDGET_GET_STATUS, async () => { requirePermission('budget.view'); return { success: true, ...(await budgetManager.getStatus()) } })

  // ========================================
  // Feature Gating / Subscription
  // ========================================

  wrapHandler(IPC_CHANNELS.FEATURE_GATE_CHECK, (feature: string) => {
    return featureGateManager.checkFeature(feature as any)
  })

  wrapHandler(IPC_CHANNELS.FEATURE_GATE_GET_TIER, () => {
    return {
      tier: featureGateManager.getTier(),
      subscription: featureGateManager.getSubscription(),
      limits: featureGateManager.getLimits()
    }
  })

  wrapHandler(IPC_CHANNELS.FEATURE_GATE_SET_TIER, (tier: string, licenseKey?: string, expiresAt?: number, maxUsers?: number) => {
    featureGateManager.setTier(tier as any, licenseKey, expiresAt, maxUsers)
    return { success: true, tier: featureGateManager.getTier() }
  })

  wrapHandler(IPC_CHANNELS.FEATURE_GATE_GET_LIMITS, () => {
    return featureGateManager.getLimits()
  })

  wrapHandler(IPC_CHANNELS.FEATURE_GATE_GET_ALL_FEATURES, () => {
    return featureGateManager.getAllFeatures()
  })

  // ========================================
  // License Activation
  // ========================================

  registerLicenseHandlers()

  // ========================================
  // Deployment / Server + Client
  // ========================================

  wrapHandler(IPC_CHANNELS.DEPLOYMENT_GET_CONFIG, () => { requirePermission('deployment.manage'); return { success: true, config: deploymentManager.getConfig() } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_UPDATE_CONFIG, (config: any) => { requirePermission('deployment.manage'); return { success: true, config: deploymentManager.updateConfig(config) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_GET_STATUS, () => { requirePermission('deployment.manage'); return { success: true, status: deploymentManager.getStatus() } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_START_SERVER, async (configOverride?: any) => { requirePermission('deployment.manage'); return deploymentManager.startServer(configOverride) })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_STOP_SERVER, async () => { requirePermission('deployment.manage'); return deploymentManager.stopServer() })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_ADD_REMOTE, (server: any) => { requirePermission('deployment.manage'); return { success: true, server: deploymentManager.addRemoteServer(server) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_REMOVE_REMOTE, (serverId: string) => { requirePermission('deployment.manage'); return { success: true, removed: deploymentManager.removeRemoteServer(serverId) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_LIST_REMOTES, () => { requirePermission('deployment.manage'); return { success: true, servers: deploymentManager.getRemoteServers() } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_CHECK_REMOTE, async (serverId: string) => { requirePermission('deployment.manage'); return { success: true, ...(await deploymentManager.checkRemoteServer(serverId)) } })
  wrapHandler(IPC_CHANNELS.DEPLOYMENT_DISCOVER_SERVERS, async (networkRange?: string) => { requirePermission('deployment.manage'); return { success: true, servers: await deploymentManager.discoverServers(networkRange) } })

  // ========================================
  // Hybrid LLM Orchestration
  // ========================================

  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_GET_CONFIG, () => ({ success: true, config: orchestrator.getConfig() }))

  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_UPDATE_CONFIG, (config: any) => {
    orchestrator.updateConfig(config)
    return { success: true, config: orchestrator.getConfig() }
  })

  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_ANALYZE, async (message: string, provider: string, model: string) => {
    requireFeature('agents')
    return { success: true, proposal: await orchestrator.analyzeForDelegation(message, provider, model) }
  })
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_APPROVE, (proposalId: string) => ({ success: orchestrator.approveProposal(proposalId) }))
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_DENY, (proposalId: string) => ({ success: orchestrator.denyProposal(proposalId) }))
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_EXECUTE, async (proposalId: string) => { const r = await orchestrator.executeDelegation(proposalId); return { success: !!r, result: r } })
  wrapHandler(IPC_CHANNELS.ORCHESTRATOR_GET_PROPOSALS, () => ({ success: true, proposals: orchestrator.getPendingProposals() }))

  // ========================================
  // Auto-Updater
  // ========================================

  wrapHandler(IPC_CHANNELS.UPDATER_GET_STATUS, () => {
    return { success: true, ...updater.getStatus() }
  })

  wrapHandler(IPC_CHANNELS.UPDATER_CHECK, async () => {
    const status = await updater.checkForUpdates()
    return { success: true, ...status }
  })

  wrapHandler(IPC_CHANNELS.UPDATER_DOWNLOAD, async () => {
    const status = await updater.downloadUpdate()
    return { success: true, ...status }
  })

  wrapHandler(IPC_CHANNELS.UPDATER_INSTALL, () => {
    updater.installUpdate()
    return { success: true }
  })
}

/**
 * License handlers use dynamic import (same as original ipc-handlers.ts)
 */
async function registerLicenseHandlers(): Promise<void> {
  const { getLicenseActivationService } = await import('../services/license-activation')
  const licenseService = getLicenseActivationService()

  wrapHandler(IPC_CHANNELS.LICENSE_ACTIVATE, async (key: string, email?: string) => {
    const result = await licenseService.activate(key, email)
    return { success: result.valid, ...result }
  })

  wrapHandler(IPC_CHANNELS.LICENSE_DEACTIVATE, () => {
    licenseService.deactivate()
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.LICENSE_GET_INFO, () => {
    return { success: true, license: licenseService.getLicense() }
  })

  wrapHandler(IPC_CHANNELS.LICENSE_GET_CHECKOUT_URL, (tier: string) => {
    const url = licenseService.getCheckoutUrl(tier as any)
    return { success: true, url }
  })
}
