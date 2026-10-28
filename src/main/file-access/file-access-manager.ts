import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Stats } from 'fs'
import { dialog } from 'electron'
import { SimpleStore } from '../utils/simple-store'
import type {
  AllowedDirectory,
  FileAccessRequest,
  FileMetadata,
  FileAccessPermission,
  NetworkShareConfig,
  NetworkShareConfigInput
} from '../../shared/file-access-types'
import {
  ALLOWED_READ_EXTENSIONS,
  ALLOWED_CREATE_EXTENSIONS,
  AI_OUTPUT_FOLDER,
  isPathSafe
} from '../../shared/file-access-types'

/**
 * Why a proposed network-share mount point was refused.
 *
 * Kept off the Error's message on purpose — see rejectMountPoint.
 */
export type MountPointRejection =
  | 'not-absolute'
  | 'contains-home'
  | 'missing'
  | 'not-a-directory'
  | 'not-separate-volume'
  | 'not-a-mount'

/** The single message every mount-point refusal shows the caller. */
export const MOUNT_POINT_REFUSED_MESSAGE = 'Mount point cannot be granted'

export class FileAccessManager {
  private store: SimpleStore
  private allowedDirs: Map<string, AllowedDirectory> = new Map()
  private networkShares: Map<string, NetworkShareConfig> = new Map()

  constructor() {
    this.store = SimpleStore.create('file-access.json')
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
   *
   * The caller may PROPOSE a mount point, but proposing it is not granting it.
   * This method writes into the same allowlist that READ_FILE and the
   * transcription spool read back, and in Electron the renderer is the less
   * trusted side — Mingly renders LLM answers, RAG documents and MCP content,
   * so one prompt injection reaching the renderer was enough. Until this gate
   * existed a renderer could post { mountPoint: '/' } and hold a read+create
   * grant on the whole filesystem (security audit 2026-10-26).
   *
   * The decision is therefore the user's, taken in the main process with the
   * same showMessageBox confirmation FileService uses before it grants a
   * directory. That is the dialog route rather than a system volume query,
   * because the only volume enumeration in this repo reads /Volumes
   * (FileService.listNetworkVolumes) — macOS-only, and a directory under
   * /Volumes says nothing about whether the user wants Mingly reading it.
   * assertGrantableMountPoint runs first so an obviously unusable path is
   * rejected without putting a dialog in front of the user at all, and so
   * that the path the dialog names is the one that gets granted.
   */
  async addNetworkShare(config: NetworkShareConfigInput): Promise<NetworkShareConfig> {
    const share: NetworkShareConfig = {
      ...config,
      id: `${config.protocol}://${config.host}/${config.shareName}`
    }

    // Also add as allowed directory if mounted
    if (share.mountPoint) {
      const mountPoint = await this.assertGrantableMountPoint(share.mountPoint)

      if (!(await this.confirmNetworkShareGrant(share, mountPoint))) {
        console.log(`📁 ❌ Network share grant denied by user: ${mountPoint}`)
        throw new Error('Network share access denied by user')
      }

      const allowedDir: AllowedDirectory = {
        id: share.id,
        path: mountPoint,
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
      share.mountPoint = mountPoint
    }

    this.networkShares.set(share.id, share)

    console.log(`📁 Added network share: ${share.name}`)
    return share
  }

  /**
   * Security: may this path be granted as a network share mount point?
   *
   * Returns the real, absolute path that may be granted, or throws. Checks
   * run in rising cost, and the authoritative ones run on the realpath:
   *
   * 1. Absolute, so the grant does not depend on the main process's working
   *    directory. Rejected before any filesystem call.
   * 2. It must not CONTAIN the user's home directory — one rule that covers
   *    '/', '/Users' and the home directory itself, while still allowing a
   *    mapped Windows drive at Z:\ , which is not where the user's files
   *    live. Note that isPathSafe is deliberately NOT reused: it appends
   *    path.sep to defeat sibling prefixes, which at a filesystem root
   *    yields '//' and makes isPathSafe(home, '/') false — exactly the
   *    payload this gate exists to refuse.
   * 3. It must be an existing directory whose st_dev differs from the volume
   *    holding the user's files AND from its own parent directory.
   *
   * Check 3 is where a spelling test is not enough. A network share is by
   * definition a different filesystem than the one holding $HOME, and st_dev
   * says that outright; a path prefix only says it about the spellings it
   * happens to recognise. A bind mount makes the difference concrete: after
   * `mount --bind /home/user /mnt/backup`, the path /mnt/backup has a
   * different device than its parent /mnt (so it looks like a real mount) and
   * '/home/user'.startsWith('/mnt/backup/') is false (so the prefix test sees
   * nothing wrong) — yet granting it grants the user's home. The device
   * comparison refuses it. The parent comparison stays because it answers a
   * different question: whether the path is a mount at all, rather than an
   * ordinary folder somebody created under /Volumes.
   *
   * Everything is checked on the realpath, and the realpath is what gets
   * granted, so the path that was validated is the path that gets read. With
   * path.resolve alone a symlink would leave the grant naming one place and
   * pointing at another — the same validate-then-resolve gap that still
   * affects READ_FILE and is tracked separately.
   *
   * Not adopted from the review, deliberately: filtering by filesystem type
   * via the OS mount table (no cross-platform Node API, and it would make
   * this macOS/Linux-specific), refusing every filesystem root (that would
   * break a mapped Windows share at Z:\, which the device check already
   * handles correctly), and restricting to /Volumes, /mnt or /media (/Volumes
   * is user-writable on macOS, so it is not a trust boundary on its own).
   */
  private async assertGrantableMountPoint(candidate: string): Promise<string> {
    if (!path.isAbsolute(candidate)) {
      this.rejectMountPoint('not-absolute', candidate)
    }

    // Cheap reject on the lexical path, so the obvious payloads never reach
    // the filesystem. Repeated authoritatively on the realpath below.
    if (this.containsHomeDirectory(path.resolve(candidate), path.resolve(os.homedir()))) {
      this.rejectMountPoint('contains-home', candidate)
    }

    let resolved: string
    try {
      resolved = await fs.realpath(candidate)
    } catch {
      this.rejectMountPoint('missing', candidate)
    }

    let stats: Stats
    try {
      stats = await fs.stat(resolved)
    } catch {
      this.rejectMountPoint('missing', resolved)
    }
    if (!stats.isDirectory()) {
      this.rejectMountPoint('not-a-directory', resolved)
    }

    const home = await fs.realpath(os.homedir())
    if (this.containsHomeDirectory(resolved, home)) {
      this.rejectMountPoint('contains-home', resolved)
    }

    const [homeStats, rootStats] = await Promise.all([
      fs.stat(home),
      fs.stat(path.parse(home).root)
    ])
    if (stats.dev === homeStats.dev || stats.dev === rootStats.dev) {
      this.rejectMountPoint('not-separate-volume', resolved)
    }

    // A filesystem root is its own mount by definition and has no parent to
    // compare against.
    if (path.parse(resolved).root !== resolved) {
      const parent = await fs.stat(path.dirname(resolved))
      if (parent.dev === stats.dev) {
        this.rejectMountPoint('not-a-mount', resolved)
      }
    }

    return resolved
  }

  /**
   * Refuse a mount point with one message for every reason.
   *
   * wrapHandler hands a thrown message straight back to the renderer
   * (`{ success: false, error: error.message }`), so a reason-specific message
   * would turn this gate into a filesystem oracle: by probing paths an
   * injected renderer could tell "does not exist" from "is a file" from "is on
   * your home volume" — and a realpath in the text would additionally disclose
   * symlink targets — all without any user interaction.
   *
   * The reason therefore stays in the main process: in the log, and on the
   * error's `reason` property, which the tests read. The one refusal that
   * keeps its own message is a declined confirmation, because the renderer
   * already knows it asked, the UI needs to tell "you said no" from "bad
   * path", and each such bit costs a dialog the user sees — so it is not an
   * enumeration channel.
   */
  private rejectMountPoint(reason: MountPointRejection, detail: string): never {
    console.warn(`📁 ❌ Mount point refused (${reason}): ${detail}`)
    throw Object.assign(new Error(MOUNT_POINT_REFUSED_MESSAGE), { reason })
  }

  /**
   * Is `homePath` the directory `candidatePath` itself, or inside it?
   *
   * Normalises the separator instead of appending it, so a filesystem root
   * does not fall out of the containment relation (see assertGrantableMountPoint).
   */
  private containsHomeDirectory(candidatePath: string, homePath: string): boolean {
    const prefix = candidatePath.endsWith(path.sep) ? candidatePath : candidatePath + path.sep
    return homePath === candidatePath || homePath.startsWith(prefix)
  }

  /**
   * Ask the user to confirm a network share grant.
   *
   * Defaults to Ablehnen (unlike FileService.requestAccess, which defaults to
   * allow for a folder the user just picked themselves): nothing here came
   * from a user gesture, so a stray Return keypress must not grant read and
   * create rights on a whole volume.
   */
  private async confirmNetworkShareGrant(
    share: NetworkShareConfig,
    mountPoint: string
  ): Promise<boolean> {
    const result = await dialog.showMessageBox({
      // The path being granted goes in `message`, ahead of any caller-supplied
      // text, so no share name can push it out of view.
      message: `Zugriff auf ${mountPoint} erlauben?`,
      detail:
        `Mingly darf dort lesen und neue Dateien anlegen.\n` +
        `Keine Dateien werden gelöscht oder überschrieben.\n\n` +
        `Angefordert für das Netzlaufwerk:\n` +
        `${share.protocol.toUpperCase()} · ${share.host}/${share.shareName}`,
      buttons: ['Zugriff erlauben', 'Ablehnen'],
      type: 'question',
      defaultId: 1,
      cancelId: 1
    })

    return result.response === 0
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
