/**
 * Upload Permission Manager
 * Manages user consent for sending file content to cloud LLMs
 *
 * Security Model:
 * - Explicit consent required for cloud uploads
 * - Per-file tracking
 * - Per-directory policies
 * - Audit logging
 * - Local LLMs always allowed
 */

import { SimpleStore } from '../utils/simple-store'
import type { SensitiveDataScanResult } from './sensitive-data-detector'

export type UploadPolicy = 'always-allow' | 'always-block' | 'ask-each-time'
export type UploadDecision = 'allowed' | 'denied' | 'pending'

export interface UploadPermissionRequest {
  fileId: string // Unique file identifier (hash or path)
  filePath: string
  directoryId: string
  destination: 'local' | 'cloud'
  provider: string // 'anthropic', 'openai', 'google', 'ollama', etc.
  scanResult: SensitiveDataScanResult
  timestamp: number
}

export interface UploadPermissionResponse {
  decision: UploadDecision
  reason: string
  requiresUserConsent: boolean
  policy?: UploadPolicy
}

export interface DirectoryPolicy {
  directoryId: string
  directoryPath: string
  policy: UploadPolicy
  createdAt: number
  updatedAt: number
}

export interface UploadAuditLog {
  id: string
  fileId: string
  filePath: string
  destination: 'local' | 'cloud'
  provider: string
  decision: UploadDecision
  scanResult: SensitiveDataScanResult
  userApproved: boolean
  timestamp: number
}

export class UploadPermissionManager {
  private store: SimpleStore
  private directoryPolicies: Map<string, DirectoryPolicy> = new Map()
  private filePermissions: Map<string, UploadDecision> = new Map() // Per-session cache
  private auditLogs: UploadAuditLog[] = []

  constructor() {
    this.store = new SimpleStore('upload-permissions.json')
    this.loadPolicies()
  }

  /**
   * Load saved policies from disk
   */
  private loadPolicies(): void {
    const savedPolicies = this.store.get('directoryPolicies', []) as DirectoryPolicy[]
    savedPolicies.forEach((policy) => {
      this.directoryPolicies.set(policy.directoryId, policy)
    })
    console.log(`🔒 Loaded ${savedPolicies.length} directory upload policies`)
  }

  /**
   * Save policies to disk
   */
  private savePolicies(): void {
    const policiesArray = Array.from(this.directoryPolicies.values())
    this.store.set('directoryPolicies', policiesArray)
  }

  /**
   * Check if upload is allowed (main entry point)
   */
  async checkUploadPermission(request: UploadPermissionRequest): Promise<UploadPermissionResponse> {
    // 1. Local LLMs: Always allowed (no upload happens)
    if (request.destination === 'local') {
      this.logUpload(request, 'allowed', true)
      return {
        decision: 'allowed',
        reason: 'Local LLM - no upload required',
        requiresUserConsent: false
      }
    }

    // 2. Check directory policy
    const directoryPolicy = this.directoryPolicies.get(request.directoryId)
    if (directoryPolicy) {
      switch (directoryPolicy.policy) {
        case 'always-allow':
          this.logUpload(request, 'allowed', true)
          return {
            decision: 'allowed',
            reason: 'Directory policy: Always allow',
            requiresUserConsent: false,
            policy: 'always-allow'
          }

        case 'always-block':
          this.logUpload(request, 'denied', false)
          return {
            decision: 'denied',
            reason: 'Directory policy: Always block',
            requiresUserConsent: false,
            policy: 'always-block'
          }

        case 'ask-each-time':
          // Continue to risk assessment
          break
      }
    }

    // 3. Check per-file permission cache (current session)
    const cachedDecision = this.filePermissions.get(request.fileId)
    if (cachedDecision) {
      return {
        decision: cachedDecision,
        reason: 'Cached decision from this session',
        requiresUserConsent: false
      }
    }

    // 4. Risk-based decision
    const { scanResult } = request

    if (!scanResult.hasSensitiveData) {
      // No sensitive data detected - allow but log
      this.logUpload(request, 'allowed', true)
      return {
        decision: 'allowed',
        reason: 'No sensitive data detected',
        requiresUserConsent: false
      }
    }

    // 5. Sensitive data detected - check recommendation
    switch (scanResult.recommendation) {
      case 'block':
        this.logUpload(request, 'denied', false)
        return {
          decision: 'denied',
          reason: `Critical risk: ${scanResult.matches.length} sensitive items detected`,
          requiresUserConsent: false
        }

      case 'warn':
        // Require user consent
        return {
          decision: 'pending',
          reason: `${scanResult.overallRiskLevel} risk: ${scanResult.matches.length} sensitive items detected`,
          requiresUserConsent: true
        }

      case 'allow':
        // Low risk - allow but warn user
        return {
          decision: 'pending',
          reason: `Low risk: ${scanResult.matches.length} potential sensitive items detected`,
          requiresUserConsent: true
        }
    }
  }

  /**
   * User grants permission (after consent dialog)
   */
  grantPermission(request: UploadPermissionRequest, rememberDecision: boolean = false): void {
    // Cache for this session
    this.filePermissions.set(request.fileId, 'allowed')

    // Log the grant
    this.logUpload(request, 'allowed', true)

    // If user wants to remember, update directory policy
    if (rememberDecision) {
      this.setDirectoryPolicy(request.directoryId, request.filePath, 'always-allow')
    }
  }

  /**
   * User denies permission (after consent dialog)
   */
  denyPermission(request: UploadPermissionRequest, rememberDecision: boolean = false): void {
    // Cache for this session
    this.filePermissions.set(request.fileId, 'denied')

    // Log the denial
    this.logUpload(request, 'denied', false)

    // If user wants to remember, update directory policy
    if (rememberDecision) {
      this.setDirectoryPolicy(request.directoryId, request.filePath, 'always-block')
    }
  }

  /**
   * Set directory policy
   */
  setDirectoryPolicy(directoryId: string, directoryPath: string, policy: UploadPolicy): void {
    const existingPolicy = this.directoryPolicies.get(directoryId)

    const directoryPolicy: DirectoryPolicy = {
      directoryId,
      directoryPath,
      policy,
      createdAt: existingPolicy?.createdAt || Date.now(),
      updatedAt: Date.now()
    }

    this.directoryPolicies.set(directoryId, directoryPolicy)
    this.savePolicies()

    console.log(`🔒 Set directory policy: ${directoryPath} → ${policy}`)
  }

  /**
   * Remove directory policy
   */
  removeDirectoryPolicy(directoryId: string): boolean {
    const removed = this.directoryPolicies.delete(directoryId)
    if (removed) {
      this.savePolicies()
      console.log(`🔒 Removed directory policy: ${directoryId}`)
    }
    return removed
  }

  /**
   * Get directory policy
   */
  getDirectoryPolicy(directoryId: string): DirectoryPolicy | null {
    return this.directoryPolicies.get(directoryId) || null
  }

  /**
   * Get all directory policies
   */
  getAllDirectoryPolicies(): DirectoryPolicy[] {
    return Array.from(this.directoryPolicies.values())
  }

  /**
   * Clear per-session file permission cache
   */
  clearSessionCache(): void {
    this.filePermissions.clear()
    console.log('🔒 Cleared upload permission cache')
  }

  /**
   * Log upload decision (audit trail)
   */
  private logUpload(
    request: UploadPermissionRequest,
    decision: UploadDecision,
    userApproved: boolean
  ): void {
    const log: UploadAuditLog = {
      id: `${request.fileId}-${Date.now()}`,
      fileId: request.fileId,
      filePath: request.filePath,
      destination: request.destination,
      provider: request.provider,
      decision,
      scanResult: request.scanResult,
      userApproved,
      timestamp: Date.now()
    }

    this.auditLogs.push(log)

    // Keep only last 1000 logs (memory limit)
    if (this.auditLogs.length > 1000) {
      this.auditLogs = this.auditLogs.slice(-1000)
    }

    console.log(
      `🔒 Upload ${decision}: ${request.filePath} → ${request.destination} (${request.provider})`
    )
  }

  /**
   * Get audit logs (optional filtering)
   */
  getAuditLogs(filter?: {
    fileId?: string
    destination?: 'local' | 'cloud'
    decision?: UploadDecision
    since?: number
  }): UploadAuditLog[] {
    let logs = [...this.auditLogs]

    if (filter) {
      if (filter.fileId) {
        logs = logs.filter((log) => log.fileId === filter.fileId)
      }
      if (filter.destination) {
        logs = logs.filter((log) => log.destination === filter.destination)
      }
      if (filter.decision) {
        logs = logs.filter((log) => log.decision === filter.decision)
      }
      if (filter.since !== undefined) {
        logs = logs.filter((log) => log.timestamp >= filter.since!)
      }
    }

    return logs.sort((a, b) => b.timestamp - a.timestamp) // Most recent first
  }

  /**
   * Export audit logs (for compliance/GDPR)
   */
  exportAuditLogs(): string {
    return JSON.stringify(this.auditLogs, null, 2)
  }

  /**
   * Clear audit logs
   */
  clearAuditLogs(): void {
    this.auditLogs = []
    console.log('🔒 Cleared audit logs')
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    totalRequests: number
    allowed: number
    denied: number
    cloudUploads: number
    localOnly: number
    sensitiveDataDetected: number
  } {
    const total = this.auditLogs.length
    const allowed = this.auditLogs.filter((log) => log.decision === 'allowed').length
    const denied = this.auditLogs.filter((log) => log.decision === 'denied').length
    const cloudUploads = this.auditLogs.filter((log) => log.destination === 'cloud').length
    const localOnly = this.auditLogs.filter((log) => log.destination === 'local').length
    const sensitiveDataDetected = this.auditLogs.filter(
      (log) => log.scanResult.hasSensitiveData
    ).length

    return {
      totalRequests: total,
      allowed,
      denied,
      cloudUploads,
      localOnly,
      sensitiveDataDetected
    }
  }
}

// Singleton instance
let permissionManagerInstance: UploadPermissionManager | null = null

export function getUploadPermissionManager(): UploadPermissionManager {
  if (!permissionManagerInstance) {
    permissionManagerInstance = new UploadPermissionManager()
  }
  return permissionManagerInstance
}
