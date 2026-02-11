import fs from 'fs/promises'
import path from 'path'
import { dialog } from 'electron'
import { SimpleStore } from '../utils/simple-store'
import type {
  AllowedDirectory,
  FileAccessRequest,
  FileMetadata,
  FileAccessPermission,
  NetworkShareConfig
} from '../../shared/file-access-types'
import {
  ALLOWED_READ_EXTENSIONS,
  ALLOWED_CREATE_EXTENSIONS,
  AI_OUTPUT_FOLDER,
  isPathSafe
} from '../../shared/file-access-types'

export class FileAccessManager {
  private store: SimpleStore
  private allowedDirs: Map<string, AllowedDirectory> = new Map()
  private networkShares: Map<string, NetworkShareConfig> = new Map()

  constructor() {
    this.store = new SimpleStore('file-access.json')
    this.loadAllowedDirectories()
  }

  /**
   * Load saved allowed directories
   */
  private loadAllowedDirectories(): void {
    const saved = this.store.get('allowedDirectories', []) as AllowedDirectory[]
    saved.forEach(dir => {
      this.allowedDirs.set(dir.id, dir)
    })
    console.log(`📁 Loaded ${saved.length} allowed directories`)
  }

  /**
   * Save allowed directories to disk
   */
  private saveAllowedDirectories(): void {
    const dirsArray = Array.from(this.allowedDirs.values())
    this.store.set('allowedDirectories', dirsArray)
  }

  /**
   * Request user to grant access to a directory
   * Opens native OS directory picker
   */
  async requestDirectoryAccess(
    permissions: FileAccessPermission[] = ['read']
  ): Promise<AllowedDirectory | null> {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Grant Mingly Access to Directory',
        message: `Select directory for ${permissions.join(', ')} access`
      })

      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const dirPath = result.filePaths[0]
      const dirName = path.basename(dirPath)

      const allowedDir: AllowedDirectory = {
        id: this.generateDirId(dirPath),
        path: dirPath,
        name: dirName,
        location: 'local',
        permissions,
        recursive: true,
        grantedAt: Date.now(),
        accessCount: 0
      }

      this.allowedDirs.set(allowedDir.id, allowedDir)
      this.saveAllowedDirectories()

      console.log(`📁 ✅ Access granted to: ${dirPath}`)
      return allowedDir
    } catch (error) {
      console.error('Failed to request directory access:', error)
      return null
    }
  }

  /**
   * Add network share (SMB/NFS)
   */
  async addNetworkShare(config: Omit<NetworkShareConfig, 'id'>): Promise<NetworkShareConfig> {
    const share: NetworkShareConfig = {
      ...config,
      id: `${config.protocol}://${config.host}/${config.shareName}`
    }

    this.networkShares.set(share.id, share)

    // Also add as allowed directory if mounted
    if (share.mountPoint) {
      const allowedDir: AllowedDirectory = {
        id: share.id,
        path: share.mountPoint,
        name: share.name,
        location: config.protocol === 'smb' ? 'network-smb' : 'network-nfs',
        permissions: ['read', 'create'],
        recursive: true,
        networkHost: config.host,
        shareName: config.shareName,
        username: config.username,
        grantedAt: Date.now(),
        accessCount: 0
      }

      this.allowedDirs.set(allowedDir.id, allowedDir)
      this.saveAllowedDirectories()
    }

    console.log(`📁 Added network share: ${share.name}`)
    return share
  }

  /**
   * Revoke access to a directory
   */
  revokeDirectoryAccess(directoryId: string): boolean {
    const removed = this.allowedDirs.delete(directoryId)
    if (removed) {
      this.saveAllowedDirectories()
      console.log(`📁 Revoked access to directory: ${directoryId}`)
    }
    return removed
  }

  /**
   * Get all allowed directories
   */
  getAllowedDirectories(): AllowedDirectory[] {
    return Array.from(this.allowedDirs.values())
  }

  /**
   * Read file content (with security checks)
   */
  async readFile(request: FileAccessRequest): Promise<string> {
    // 1. Security: Verify directory is allowed
    const allowedDir = this.allowedDirs.get(request.directoryId)
    if (!allowedDir) {
      throw new Error('Directory access not granted')
    }

    // 2. Security: Verify permission
    if (!allowedDir.permissions.includes('read') && !allowedDir.permissions.includes('read-create')) {
      throw new Error('Read permission not granted for this directory')
    }

    // 3. Security: Validate path is within allowed directory
    const fullPath = path.join(allowedDir.path, request.filePath)
    if (!isPathSafe(fullPath, allowedDir.path)) {
      throw new Error('Path traversal attempt detected')
    }

    // 4. Security: Verify file extension is allowed
    const ext = path.extname(fullPath).toLowerCase()
    if (!ALLOWED_READ_EXTENSIONS.includes(ext)) {
      throw new Error(`File type ${ext} not allowed for reading`)
    }

    // 5. Read file
    try {
      const content = await fs.readFile(fullPath, 'utf-8')

      // Update access stats
      allowedDir.lastAccessed = Date.now()
      allowedDir.accessCount++
      this.saveAllowedDirectories()

      console.log(`📁 Read file: ${fullPath}`)
      return content
    } catch (error) {
      console.error(`Failed to read file ${fullPath}:`, error)
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Create file with AI-generated content (with security checks)
   */
  async createFile(
    request: FileAccessRequest,
    content: string
  ): Promise<{ success: boolean; path: string }> {
    // 1. Security: Verify directory is allowed
    const allowedDir = this.allowedDirs.get(request.directoryId)
    if (!allowedDir) {
      throw new Error('Directory access not granted')
    }

    // 2. Security: Verify permission
    if (!allowedDir.permissions.includes('create') && !allowedDir.permissions.includes('read-create')) {
      throw new Error('Create permission not granted for this directory')
    }

    // 3. Security: Validate path is within allowed directory
    const fullPath = path.join(allowedDir.path, request.filePath)
    if (!isPathSafe(fullPath, allowedDir.path)) {
      throw new Error('Path traversal attempt detected')
    }

    // 4. Security: Verify file extension is allowed for creation
    const ext = path.extname(fullPath).toLowerCase()
    if (!ALLOWED_CREATE_EXTENSIONS.includes(ext)) {
      throw new Error(`File type ${ext} not allowed for creation`)
    }

    // 5. Security: Prevent overwriting existing files (safety measure)
    try {
      await fs.access(fullPath)
      throw new Error('File already exists. Mingly only creates new files for safety.')
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error
      }
      // File doesn't exist, good to proceed
    }

    // 6. Create directory structure if needed
    const dir = path.dirname(fullPath)
    await fs.mkdir(dir, { recursive: true })

    // 7. Write file
    try {
      await fs.writeFile(fullPath, content, 'utf-8')

      // Update access stats
      allowedDir.lastAccessed = Date.now()
      allowedDir.accessCount++
      this.saveAllowedDirectories()

      console.log(`📁 ✅ Created file: ${fullPath}`)
      return { success: true, path: fullPath }
    } catch (error) {
      console.error(`Failed to create file ${fullPath}:`, error)
      throw new Error(`Failed to create file: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * List files in allowed directory
   */
  async listFiles(directoryId: string, relativePath: string = ''): Promise<FileMetadata[]> {
    const allowedDir = this.allowedDirs.get(directoryId)
    if (!allowedDir) {
      throw new Error('Directory access not granted')
    }

    const fullPath = path.join(allowedDir.path, relativePath)
    if (!isPathSafe(fullPath, allowedDir.path)) {
      throw new Error('Path traversal attempt detected')
    }

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true })

      const files: FileMetadata[] = []
      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry.name)
        const stats = await fs.stat(entryPath)

        files.push({
          name: entry.name,
          path: path.relative(allowedDir.path, entryPath),
          size: stats.size,
          mimeType: entry.isDirectory() ? 'directory' : this.getMimeType(entry.name),
          createdAt: stats.birthtime.getTime(),
          modifiedAt: stats.mtime.getTime(),
          isDirectory: entry.isDirectory()
        })
      }

      return files
    } catch (error) {
      console.error(`Failed to list files in ${fullPath}:`, error)
      throw new Error(`Failed to list files: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Create AI output directory in user's allowed directory
   */
  async createAIOutputDirectory(directoryId: string): Promise<string> {
    const allowedDir = this.allowedDirs.get(directoryId)
    if (!allowedDir) {
      throw new Error('Directory access not granted')
    }

    const outputPath = path.join(allowedDir.path, AI_OUTPUT_FOLDER)

    try {
      await fs.mkdir(outputPath, { recursive: true })
      console.log(`📁 Created AI output directory: ${outputPath}`)
      return outputPath
    } catch (error) {
      console.error(`Failed to create AI output directory:`, error)
      throw error
    }
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.js': 'text/javascript',
      '.ts': 'text/typescript',
      '.py': 'text/x-python',
      '.html': 'text/html',
      '.css': 'text/css',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg'
    }
    return mimeTypes[ext] || 'application/octet-stream'
  }

  /**
   * Generate directory ID
   */
  private generateDirId(dirPath: string): string {
    return Buffer.from(dirPath).toString('base64').substring(0, 16)
  }
}

// Singleton instance
let fileAccessManagerInstance: FileAccessManager | null = null

export function getFileAccessManager(): FileAccessManager {
  if (!fileAccessManagerInstance) {
    fileAccessManagerInstance = new FileAccessManager()
  }
  return fileAccessManagerInstance
}
