/**
 * File Access Configuration
 * For secure local and network file access
 *
 * Security Model:
 * - NO FILE UPLOADS (files stay local)
 * - READ-ONLY access to specified directories
 * - CREATE-ONLY for AI-generated content (in designated folders)
 * - User must explicitly grant access to each directory
 */

export type FileAccessPermission = 'read' | 'create' | 'read-create'
export type FileLocation = 'local' | 'network-smb' | 'network-nfs'

export interface AllowedDirectory {
  id: string
  path: string // Absolute path on local machine or UNC path (\\server\share)
  name: string // User-friendly name
  location: FileLocation
  permissions: FileAccessPermission[]
  recursive: boolean // Allow subdirectories

  // Network specific (for SMB/NFS)
  networkHost?: string
  shareName?: string
  username?: string

  // Security
  grantedAt: number
  lastAccessed?: number
  accessCount: number
}

export interface FileAccessRequest {
  directoryId: string
  filePath: string // Relative to allowed directory
  operation: 'read' | 'create'
}

export interface FileMetadata {
  name: string
  path: string
  size: number
  mimeType: string
  createdAt: number
  modifiedAt: number
  isDirectory: boolean
}

export interface NetworkShareConfig {
  id: string
  name: string
  protocol: 'smb' | 'nfs'
  host: string
  shareName: string
  username?: string
  password?: string // Stored in system keychain
  mountPoint?: string // Where it's mounted on local system
}

/**
 * File patterns allowed for reading
 */
export const ALLOWED_READ_EXTENSIONS = [
  // Documents
  '.txt', '.md', '.pdf', '.doc', '.docx',
  // Code
  '.js', '.ts', '.py', '.java', '.cpp', '.c', '.h',
  '.json', '.yaml', '.yml', '.xml', '.html', '.css',
  // Data
  '.csv', '.tsv', '.log',
  // Images (for context, not editing)
  '.jpg', '.jpeg', '.png', '.gif', '.webp'
]

/**
 * File patterns allowed for AI-generated content creation
 */
export const ALLOWED_CREATE_EXTENSIONS = [
  '.txt', '.md', '.json', '.yaml', '.yml',
  '.js', '.ts', '.py', '.html', '.css'
]

/**
 * Default AI output directory name
 */
export const AI_OUTPUT_FOLDER = 'Mingly-AI-Output'

/**
 * Security: Validate path is within allowed directory
 */
export function isPathSafe(requestedPath: string, allowedDir: string): boolean {
  const path = require('path')
  const resolved = path.resolve(requestedPath)
  const allowed = path.resolve(allowedDir)

  // Path must be within allowed directory
  return resolved.startsWith(allowed)
}
