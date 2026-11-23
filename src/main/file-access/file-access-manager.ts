import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Stats } from 'fs'
import { app, dialog } from 'electron'
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
  isPathSafe,
  survivingPermissions,
  hasConfirmationMarker,
  hasPermission
} from '../../shared/file-access-types'
import { isMissingPathError, isRealPathWithin } from './real-path-guard'
import { getCodingModeStore } from '../coding/coding-mode-store'
import { currentDirectoryId, directoryId } from './directory-id'
import { migrateDirectoryIdStores } from './store-migration'

/**
 * Why a proposed network-share mount point was refused.
 *
 * Kept off the Error's message on purpose — see rejectMountPoint.
 */
export type MountPointRejection =
  | 'not-absolute'
  | 'contains-home'
  | 'missing'
  | 'unreadable'
  | 'not-a-directory'
  | 'not-separate-volume'
  | 'not-a-mount'

/** The single message every mount-point refusal shows the caller. */
export const MOUNT_POINT_REFUSED_MESSAGE = 'Mount point cannot be granted'

/**
 * Where grants dropped by loadAllowedDirectories are parked.
 *
 * A separate key, never read back into allowedDirs, so nothing trusts it.
 */
const UNCONFIRMED_DIRECTORIES_KEY = 'unconfirmedDirectories'

export class FileAccessManager {
  private store: SimpleStore
  private allowedDirs: Map<string, AllowedDirectory> = new Map()
  private networkShares: Map<string, NetworkShareConfig> = new Map()

  constructor() {
    // BEFORE the store is created, so SimpleStore reads the migrated file and
    // never caches the old one. registerInfrastructureHandlers constructs this
    // class at start-up, before any IPC channel can be served, so this is also
    // the point at which the coding mode store's file has been seen to — and if
    // it has not, that store ignores an unversioned file anyway.
    try {
      migrateDirectoryIdStores(app.getPath('userData'))
    } catch (error) {
      // app may be unavailable (a unit test, a very early call). The migration
      // itself swallows its own failures; this only covers resolving the path,
      // and without it the session is still correct — loadAllowedDirectories
      // re-derives the ids below.
      console.warn('📁 ⚠️ Could not locate the store directory for migration:', error)
    }
    this.store = SimpleStore.create('file-access.json')
    this.loadAllowedDirectories()
  }

  /**
   * Load saved allowed directories.
   *
   * This used to take file-access.json back unchanged, which made the file
   * itself the weakest link in the grant chain: addNetworkShare's
   * confirmation dialog only guards the moment of GRANTING, so a network
   * entry written before that dialog existed came back fully trusted on the
   * next start. The entry is now required to carry the marker that is written
   * where the confirmation actually fell (survivingPermissions).
   *
   * Chosen over re-validating each path here: assertGrantableMountPoint is
   * async, this runs in the constructor, and the device and realpath checks
   * answer whether a path COULD be granted, never whether the user DID grant
   * it. Checking a marker is both the right question and a synchronous one,
   * so the singleton keeps its eager construction.
   *
   * Unconfirmed entries are dropped from the allowlist but parked under a
   * separate key rather than deleted: networkShares is in-memory only, so
   * such an entry is the sole surviving record of the host, share and
   * username the user typed. Silently keeping it would be the hole; silently
   * destroying it would cost them the grant with nothing left to re-grant
   * from. The pruned list is written back so the drop happens once and does
   * not depend on this check running again.
   *
   * A marker-less LOCAL grant is not dropped: it stays with `edit` removed and
   * its other permissions intact, and the reduced list is written back for the
   * same reason. Only `edit` needs the marker locally (survivingPermissions).
   */
  private loadAllowedDirectories(): void {
    // Shape check before anything is read off it. This runs in the
    // CONSTRUCTOR: a throw here makes getFileAccessManager() fail at start-up,
    // with no recovery but deleting file-access.json by hand — and this is the
    // file whose trustworthiness this class stopped assuming. A stored value
    // that is not an array of objects is an empty allowlist, the strict side.
    const stored: unknown = this.store.get('allowedDirectories', [])
    const storedList: unknown[] = Array.isArray(stored) ? stored : []
    // An entry with no usable id can never be matched by a lookup; keeping it
    // under a non-string key would only be a hazard.
    const saved: AllowedDirectory[] = storedList.filter(
      (entry): entry is AllowedDirectory =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        (entry as { id: string }).id !== ''
    )
    if (!Array.isArray(stored)) {
      console.warn('📁 ⚠️ Stored allowed directories were not a list; starting with none')
    }
    const dropped: AllowedDirectory[] = []
    // Unusable entries are pruned on the way in; the list is written back so
    // that happens once instead of on every start. `rewrite` collects every
    // reason to write it back, the re-keying below included.
    const unusable = storedList.length - saved.length
    if (unusable > 0) {
      console.warn(`📁 ⚠️ Skipped ${unusable} unusable stored grant entries`)
    }
    let rewrite = unusable > 0

    saved.forEach(raw => {
      // Normalise once at the boundary: the store value is an unchecked cast,
      // and a permission list that is not a list is an empty one. Everything
      // below, including what gets stored, works on the normalised entry.
      const malformed = !Array.isArray(raw.permissions)
      const normalised: AllowedDirectory = malformed ? { ...raw, permissions: [] } : raw
      // The id is re-derived from the entry's own path before anything is keyed
      // on it. store-migration.ts does the same on the file; doing it here as
      // well means the SESSION is right even when that rewrite could not land
      // (a read-only userData, a full disk), and on an already migrated file it
      // is a no-op, because deriving the id is deterministic.
      const currentId = currentDirectoryId(normalised)
      const dir: AllowedDirectory =
        currentId === null ? normalised : { ...normalised, id: currentId }
      if (currentId !== null) {
        console.warn(`📁 Re-keyed the stored grant of ${dir.path} to its full-path id`)
        rewrite = true
      }
      const surviving = survivingPermissions(dir)
      // Park only what is genuinely unconfirmed. A confirmed grant with an
      // empty permission list is kept as it is: it grants nothing, and
      // "needs re-granting" would be untrue for it.
      if (surviving.length === 0 && !hasConfirmationMarker(dir)) {
        dropped.push(dir)
        console.warn(
          `📁 ⚠️ Dropped unconfirmed ${dir.location} grant (needs re-granting): ${dir.path}`
        )
        return
      }
      if (surviving.length < dir.permissions.length) {
        const lost = dir.permissions.filter(permission => !surviving.includes(permission))
        console.warn(
          `📁 ⚠️ Unconfirmed ${dir.location} grant lost permission ${lost.join(', ')} (needs re-granting): ${dir.path}`
        )
        rewrite = true
        this.allowedDirs.set(dir.id, { ...dir, permissions: surviving })
        return
      }
      if (malformed) {
        console.warn(`📁 ⚠️ Grant had a malformed permission list, now empty: ${dir.path}`)
        rewrite = true
      }
      this.allowedDirs.set(dir.id, dir)
    })

    if (dropped.length > 0) {
      this.parkUnconfirmedDirectories(dropped)
    }
    if (dropped.length > 0 || rewrite) {
      this.saveAllowedDirectories()
    }

    console.log(`📁 Loaded ${this.allowedDirs.size} allowed directories`)
  }

  /**
   * Keep dropped grants on record, merged by id so a repeated load cannot
   * duplicate an entry.
   */
  private parkUnconfirmedDirectories(dropped: AllowedDirectory[]): void {
    const byId = new Map<string, AllowedDirectory>()
    for (const dir of [...this.getUnconfirmedDirectories(), ...dropped]) {
      byId.set(dir.id, dir)
    }
    this.store.set(UNCONFIRMED_DIRECTORIES_KEY, Array.from(byId.values()))
  }

  /**
   * Grants that were dropped for want of a confirmation marker.
   *
   * Read-only bookkeeping: these are NOT part of the allowlist and no read
   * path consults them. They exist so the user can be told which share to
   * grant again instead of finding it gone.
   */
  getUnconfirmedDirectories(): AllowedDirectory[] {
    return this.store.get(UNCONFIRMED_DIRECTORIES_KEY, []) as AllowedDirectory[]
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
        id: directoryId(dirPath),
        path: dirPath,
        name: dirName,
        location: 'local',
        permissions,
        recursive: true,
        grantedAt: Date.now(),
        // The user picked this directory themselves in the OS dialog, which
        // is the confirmation. Nothing a caller supplied reaches this route.
        confirmedAt: Date.now(),
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
        // Set here and nowhere else for a network grant: this line is only
        // reached once confirmNetworkShareGrant has returned true, so the
        // marker means a human said yes to THIS mount point. Writing it
        // anywhere a caller can reach without a dialog would re-open the hole
        // loadAllowedDirectories closes.
        confirmedAt: Date.now(),
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

    // Refused either way; the reason only decides what the log says. A path
    // the filesystem would not resolve is not an absent path, and calling it
    // 'missing' sends whoever reads the log looking for the wrong thing.
    let resolved: string
    try {
      resolved = await fs.realpath(candidate)
    } catch (error) {
      this.rejectMountPoint(isMissingPathError(error) ? 'missing' : 'unreadable', candidate)
    }

    let stats: Stats
    try {
      stats = await fs.stat(resolved)
    } catch (error) {
      this.rejectMountPoint(isMissingPathError(error) ? 'missing' : 'unreadable', resolved)
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
      // A revoked grant must not leave a coding mode behind. The directory id
      // is derived from the path, so granting the same directory again
      // produces the same id, and a surviving mode would come back with it —
      // `propose-run` included — without the user choosing a level again.
      // Done here rather than in getMode: by the time the directory has been
      // granted again there IS a grant, so a read-time check cannot tell the
      // revived mode from a chosen one.
      try {
        getCodingModeStore().forgetMode(directoryId)
      } catch (error) {
        // The grant is gone either way; losing the revoke over a store error
        // would be worse than a stale mode, which the next grant's own mode
        // choice overwrites.
        console.warn(`📁 ⚠️ Could not clear the coding mode of ${directoryId}:`, error)
      }
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
    if (!hasPermission(allowedDir, 'read')) {
      throw new Error('Read permission not granted for this directory')
    }

    // 3. Security: Validate path is within allowed directory, by spelling and
    // then in fact. isPathSafe follows no symlink, so a link inside the grant
    // used to read whatever it pointed at; the same message covers both because
    // both are the same attempt and a distinct one would leak which it was.
    const fullPath = path.join(allowedDir.path, request.filePath)
    if (!isPathSafe(fullPath, allowedDir.path)) {
      throw new Error('Path traversal attempt detected')
    }
    if (!(await isRealPathWithin(fullPath, allowedDir.path))) {
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
    if (!hasPermission(allowedDir, 'create')) {
      throw new Error('Create permission not granted for this directory')
    }

    // 3. Security: Validate path is within allowed directory, by spelling and
    // then in fact. The target does not exist yet, so the real-path check
    // resolves the deepest existing ancestor — which is what a symlinked
    // subdirectory would be.
    const fullPath = path.join(allowedDir.path, request.filePath)
    if (!isPathSafe(fullPath, allowedDir.path)) {
      throw new Error('Path traversal attempt detected')
    }
    if (!(await isRealPathWithin(fullPath, allowedDir.path))) {
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
    if (!(await isRealPathWithin(fullPath, allowedDir.path))) {
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
}

// Singleton instance
let fileAccessManagerInstance: FileAccessManager | null = null

export function getFileAccessManager(): FileAccessManager {
  if (!fileAccessManagerInstance) {
    fileAccessManagerInstance = new FileAccessManager()
  }
  return fileAccessManagerInstance
}
