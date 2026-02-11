/**
 * Upload Permission Manager Tests
 * Tests für User-Consent und Permission Management
 */

import { vi } from 'vitest'
import { tmpdir } from 'os'
import path from 'path'

// Mock Electron's app module before importing modules that use it
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(tmpdir(), 'mingly-test-' + process.pid)
      return tmpdir()
    }
  }
}))

import { getUploadPermissionManager } from '../upload-permission-manager'
import { getSensitiveDataDetector } from '../sensitive-data-detector'
import type { UploadPermissionRequest } from '../upload-permission-manager'

describe('Upload Permission Manager', () => {
  const permissionManager = getUploadPermissionManager()
  const detector = getSensitiveDataDetector()

  beforeEach(() => {
    // Clear session cache before each test
    permissionManager.clearSessionCache()
  })

  describe('Local LLM (No Upload)', () => {
    it('should always allow local LLM destinations', async () => {
      const scanResult = detector.scan('My API key is sk-abc123...')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-1',
        filePath: '/test/file.txt',
        directoryId: 'dir-123',
        destination: 'local',
        provider: 'ollama',
        scanResult,
        timestamp: Date.now()
      }

      const response = await permissionManager.checkUploadPermission(request)

      expect(response.decision).toBe('allowed')
      expect(response.reason).toContain('Local LLM')
      expect(response.requiresUserConsent).toBe(false)
    })
  })

  describe('Cloud LLM with Sensitive Data', () => {
    it('should block critical risk (API keys)', async () => {
      const scanResult = detector.scan('API Key: sk-' + 'a'.repeat(48))

      const request: UploadPermissionRequest = {
        fileId: 'test-file-2',
        filePath: '/test/secret.txt',
        directoryId: 'dir-123',
        destination: 'cloud',
        provider: 'anthropic',
        scanResult,
        timestamp: Date.now()
      }

      const response = await permissionManager.checkUploadPermission(request)

      expect(response.decision).toBe('denied')
      expect(response.reason).toContain('Critical risk')
      expect(response.requiresUserConsent).toBe(false)
    })

    it('should require consent for medium risk (phone numbers)', async () => {
      const scanResult = detector.scan('Phone: +1-555-123-4567')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-3',
        filePath: '/test/contact.txt',
        directoryId: 'dir-123',
        destination: 'cloud',
        provider: 'openai',
        scanResult,
        timestamp: Date.now()
      }

      const response = await permissionManager.checkUploadPermission(request)

      expect(response.decision).toBe('pending')
      expect(response.requiresUserConsent).toBe(true)
      expect(response.reason).toContain('medium risk')
    })

    it('should allow no sensitive data', async () => {
      const scanResult = detector.scan('This is a normal message')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-4',
        filePath: '/test/normal.txt',
        directoryId: 'dir-123',
        destination: 'cloud',
        provider: 'google',
        scanResult,
        timestamp: Date.now()
      }

      const response = await permissionManager.checkUploadPermission(request)

      expect(response.decision).toBe('allowed')
      expect(response.reason).toContain('No sensitive data')
    })
  })

  describe('Directory Policies', () => {
    it('should respect always-allow policy', async () => {
      const scanResult = detector.scan('Phone: +1-555-123-4567')

      // Set policy first
      permissionManager.setDirectoryPolicy('dir-allow', '/path/to/dir', 'always-allow')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-5',
        filePath: '/path/to/dir/file.txt',
        directoryId: 'dir-allow',
        destination: 'cloud',
        provider: 'anthropic',
        scanResult,
        timestamp: Date.now()
      }

      const response = await permissionManager.checkUploadPermission(request)

      expect(response.decision).toBe('allowed')
      expect(response.policy).toBe('always-allow')
      expect(response.requiresUserConsent).toBe(false)

      // Cleanup
      permissionManager.removeDirectoryPolicy('dir-allow')
    })

    it('should respect always-block policy', async () => {
      const scanResult = detector.scan('Normal text')

      // Set policy first
      permissionManager.setDirectoryPolicy('dir-block', '/path/to/secret', 'always-block')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-6',
        filePath: '/path/to/secret/file.txt',
        directoryId: 'dir-block',
        destination: 'cloud',
        provider: 'openai',
        scanResult,
        timestamp: Date.now()
      }

      const response = await permissionManager.checkUploadPermission(request)

      expect(response.decision).toBe('denied')
      expect(response.policy).toBe('always-block')

      // Cleanup
      permissionManager.removeDirectoryPolicy('dir-block')
    })
  })

  describe('Grant/Deny Permission', () => {
    it('should grant permission and cache decision', async () => {
      const scanResult = detector.scan('Phone: +1-555-123-4567')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-7',
        filePath: '/test/file.txt',
        directoryId: 'dir-123',
        destination: 'cloud',
        provider: 'anthropic',
        scanResult,
        timestamp: Date.now()
      }

      // Grant permission
      permissionManager.grantPermission(request, false)

      // Check again - should use cached decision
      const response = await permissionManager.checkUploadPermission(request)
      expect(response.decision).toBe('allowed')
      expect(response.reason).toContain('Cached decision')
    })

    it('should deny permission and cache decision', async () => {
      const scanResult = detector.scan('Phone: +1-555-123-4567')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-8',
        filePath: '/test/file.txt',
        directoryId: 'dir-123',
        destination: 'cloud',
        provider: 'openai',
        scanResult,
        timestamp: Date.now()
      }

      // Deny permission
      permissionManager.denyPermission(request, false)

      // Check again - should use cached decision
      const response = await permissionManager.checkUploadPermission(request)
      expect(response.decision).toBe('denied')
    })

    it('should remember decision when rememberChoice=true', async () => {
      const scanResult = detector.scan('Phone: +1-555-123-4567')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-9',
        filePath: '/test/file.txt',
        directoryId: 'dir-remember',
        destination: 'cloud',
        provider: 'anthropic',
        scanResult,
        timestamp: Date.now()
      }

      // Grant with remember
      permissionManager.grantPermission(request, true)

      // Check directory policy was created
      const policy = permissionManager.getDirectoryPolicy('dir-remember')
      expect(policy).not.toBeNull()
      expect(policy?.policy).toBe('always-allow')

      // Cleanup
      permissionManager.removeDirectoryPolicy('dir-remember')
    })
  })

  describe('Audit Logs', () => {
    it('should log all upload decisions', async () => {
      const scanResult = detector.scan('Normal text')

      const request: UploadPermissionRequest = {
        fileId: 'test-file-10',
        filePath: '/test/file.txt',
        directoryId: 'dir-123',
        destination: 'cloud',
        provider: 'anthropic',
        scanResult,
        timestamp: Date.now()
      }

      await permissionManager.checkUploadPermission(request)

      const logs = permissionManager.getAuditLogs({ fileId: 'test-file-10' })
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].fileId).toBe('test-file-10')
      expect(logs[0].decision).toBe('allowed')
    })

    it('should filter audit logs by criteria', async () => {
      const scanResult = detector.scan('Normal text')

      // Create multiple requests
      const request1: UploadPermissionRequest = {
        fileId: 'filter-test-1',
        filePath: '/test/file1.txt',
        directoryId: 'dir-123',
        destination: 'cloud',
        provider: 'anthropic',
        scanResult,
        timestamp: Date.now()
      }

      const request2: UploadPermissionRequest = {
        fileId: 'filter-test-2',
        filePath: '/test/file2.txt',
        directoryId: 'dir-123',
        destination: 'local',
        provider: 'ollama',
        scanResult,
        timestamp: Date.now()
      }

      await permissionManager.checkUploadPermission(request1)
      await permissionManager.checkUploadPermission(request2)

      // Filter by destination
      const cloudLogs = permissionManager.getAuditLogs({ destination: 'cloud' })
      expect(cloudLogs.every((log) => log.destination === 'cloud')).toBe(true)

      const localLogs = permissionManager.getAuditLogs({ destination: 'local' })
      expect(localLogs.every((log) => log.destination === 'local')).toBe(true)
    })
  })

  describe('Statistics', () => {
    it('should track upload statistics', async () => {
      const stats = permissionManager.getStatistics()

      expect(stats).toHaveProperty('totalRequests')
      expect(stats).toHaveProperty('allowed')
      expect(stats).toHaveProperty('denied')
      expect(stats).toHaveProperty('cloudUploads')
      expect(stats).toHaveProperty('localOnly')
      expect(stats).toHaveProperty('sensitiveDataDetected')

      expect(typeof stats.totalRequests).toBe('number')
    })
  })
})
