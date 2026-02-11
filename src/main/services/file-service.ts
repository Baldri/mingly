import { dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { existsSync, statSync } from 'fs'

export interface FileMetadata {
  size: number
  created: Date
  modified: Date
  extension: string
  isDirectory: boolean
}

export interface FileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  extension?: string
  size?: number
}

export interface NetworkVolume {
  name: string
  path: string
  type: 'local' | 'network'
}

export class FileService {
  private allowedPaths: Set<string> = new Set()

  /**
   * Request user permission to access a directory
   */
  async requestAccess(dirPath: string): Promise<boolean> {
    // Check if already allowed
    if (this.isPathAllowed(dirPath)) {
      return true
    }

    const result = await dialog.showMessageBox({
      message: 'Dateizugriff erlauben?',
      detail: `Mingly möchte auf folgenden Ordner zugreifen:\n\n${dirPath}\n\nBerechtigung gilt nur für diese Sitzung.\nKeine Dateien werden hochgeladen oder gelöscht.`,
      buttons: ['Zugriff erlauben', 'Ablehnen'],
      type: 'question',
      defaultId: 0,
      cancelId: 1
    })

    if (result.response === 0) {
      this.allowedPaths.add(path.resolve(dirPath))
      console.log(`✅ User granted access to: ${dirPath}`)
      return true
    }

    console.log(`❌ User denied access to: ${dirPath}`)
    return false
  }

  /**
   * Read a file's content
   */
  async readFile(filePath: string): Promise<{
    content: string
    metadata: FileMetadata
  }> {
    const resolvedPath = path.resolve(filePath)
    const dirPath = path.dirname(resolvedPath)

    if (!this.isPathAllowed(dirPath)) {
      throw new Error(`Access denied: Path not authorized - ${dirPath}`)
    }

    if (!existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`)
    }

    const stats = statSync(resolvedPath)

    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`)
    }

    // Check file size (max 50 MB for text files)
    if (stats.size > 50 * 1024 * 1024) {
      throw new Error(`File too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 50 MB)`)
    }

    const content = await fs.readFile(resolvedPath, 'utf-8')

    return {
      content,
      metadata: {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        extension: path.extname(resolvedPath),
        isDirectory: false
      }
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(
    dirPath: string,
    options?: {
      extensions?: string[]
      recursive?: boolean
      includeHidden?: boolean
    }
  ): Promise<FileInfo[]> {
    const resolvedPath = path.resolve(dirPath)

    if (!this.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path not authorized - ${dirPath}`)
    }

    if (!existsSync(resolvedPath)) {
      throw new Error(`Directory not found: ${dirPath}`)
    }

    const stats = statSync(resolvedPath)
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${dirPath}`)
    }

    const files: FileInfo[] = []
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true })

    for (const entry of entries) {
      // Skip hidden files unless explicitly requested
      if (!options?.includeHidden && entry.name.startsWith('.')) {
        continue
      }

      const fullPath = path.join(resolvedPath, entry.name)

      if (entry.isFile()) {
        const ext = path.extname(entry.name)

        // Filter by extensions if provided
        if (options?.extensions && !options.extensions.includes(ext)) {
          continue
        }

        const fileStats = statSync(fullPath)

        files.push({
          path: fullPath,
          name: entry.name,
          type: 'file',
          extension: ext,
          size: fileStats.size
        })
      } else if (entry.isDirectory()) {
        files.push({
          path: fullPath,
          name: entry.name,
          type: 'directory'
        })

        // Recursively list subdirectories
        if (options?.recursive) {
          try {
            const subFiles = await this.listFiles(fullPath, options)
            files.push(...subFiles)
          } catch (error) {
            // Silently skip directories we can't read
            console.warn(`Skipping directory ${fullPath}:`, error)
          }
        }
      }
    }

    return files
  }

  /**
   * Write content to a file (creates new or overwrites)
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const resolvedPath = path.resolve(filePath)
    const dirPath = path.dirname(resolvedPath)

    if (!this.isPathAllowed(dirPath)) {
      throw new Error(`Access denied: Cannot write to this location - ${dirPath}`)
    }

    // Check if file exists and warn user
    if (existsSync(resolvedPath)) {
      const result = await dialog.showMessageBox({
        message: 'Datei überschreiben?',
        detail: `Die Datei "${path.basename(filePath)}" existiert bereits.\n\nMöchten Sie sie überschreiben?`,
        buttons: ['Überschreiben', 'Abbrechen'],
        type: 'warning',
        defaultId: 1,
        cancelId: 1
      })

      if (result.response !== 0) {
        throw new Error('User cancelled file overwrite')
      }
    }

    // Ensure directory exists
    await fs.mkdir(dirPath, { recursive: true })

    // Write file
    await fs.writeFile(resolvedPath, content, 'utf-8')
    console.log(`✅ File written: ${resolvedPath}`)
  }

  /**
   * List network volumes (macOS specific)
   */
  async listNetworkVolumes(): Promise<NetworkVolume[]> {
    const volumesPath = '/Volumes'

    if (!existsSync(volumesPath)) {
      return []
    }

    try {
      const volumes = await fs.readdir(volumesPath)

      const volumeInfos = await Promise.all(
        volumes.map(async (name) => {
          const volumePath = path.join(volumesPath, name)
          const stats = statSync(volumePath)

          return {
            name,
            path: volumePath,
            type: (name === 'Macintosh HD' || name.includes('Data')) ? 'local' : 'network'
          } as NetworkVolume
        })
      )

      return volumeInfos
    } catch (error) {
      console.error('Failed to list network volumes:', error)
      return []
    }
  }

  /**
   * Check if a path is allowed for access
   */
  private isPathAllowed(filePath: string): boolean {
    const resolvedPath = path.resolve(filePath)

    // Check if path or any parent is in allowed paths
    return Array.from(this.allowedPaths).some((allowed) =>
      resolvedPath.startsWith(allowed)
    )
  }

  /**
   * Validate path (prevent traversal attacks)
   */
  private validatePath(filePath: string): string {
    const resolved = path.resolve(filePath)

    // Prevent access to system directories
    const forbidden = ['/etc', '/System', '/private', '/usr', '/bin', '/sbin']
    if (forbidden.some((dir) => resolved.startsWith(dir))) {
      throw new Error('Access to system directories is forbidden')
    }

    return resolved
  }

  /**
   * Clear all allowed paths (called on app restart)
   */
  clearPermissions(): void {
    this.allowedPaths.clear()
    console.log('🔒 All file access permissions cleared')
  }

  /**
   * Get list of currently allowed paths
   */
  getAllowedPaths(): string[] {
    return Array.from(this.allowedPaths)
  }
}

// Singleton instance
let fileServiceInstance: FileService | null = null

export function getFileService(): FileService {
  if (!fileServiceInstance) {
    fileServiceInstance = new FileService()
  }
  return fileServiceInstance
}
