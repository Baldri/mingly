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

  // Path must be the allowed directory itself or strictly inside it. The
  // trailing separator prevents a sibling like /a/photos-evil from matching
  // the grant for /a/photos (security audit 2026-08-21).
  return resolved === allowed || resolved.startsWith(allowed + path.sep)
}

/**
 * Security: is the path inside ANY of the granted directories?
 * Used to constrain raw file reads to the user's granted-directory model.
 */
export function isPathWithinAllowedDirs(requestedPath: string, allowedDirPaths: string[]): boolean {
  return allowedDirPaths.some((dir) => isPathSafe(requestedPath, dir))
}

/**
 * Config a caller may propose for a network share — everything but the id,
 * which addNetworkShare derives from protocol/host/shareName.
 */
export type NetworkShareConfigInput = Omit<NetworkShareConfig, 'id'>

export type NetworkShareConfigParseResult =
  | { valid: true; config: NetworkShareConfigInput }
  | { valid: false; error: string }

/** Long enough for a UNC path or a descriptive share name, short enough to log. */
const MAX_SHARE_FIELD_LENGTH = 1024

type FieldResult = { ok: true; value: string } | { ok: false; error: string }

function checkStringField(value: unknown, field: string): FieldResult {
  if (typeof value !== 'string') {
    return { ok: false, error: `Network share field '${field}' must be a string` }
  }
  if (value.trim() === '') {
    return { ok: false, error: `Network share field '${field}' must not be empty` }
  }
  if (value.length > MAX_SHARE_FIELD_LENGTH) {
    return { ok: false, error: `Network share field '${field}' exceeds ${MAX_SHARE_FIELD_LENGTH} chars` }
  }
  if (value.includes('\0')) {
    return { ok: false, error: `Network share field '${field}' contains a null byte` }
  }
  return { ok: true, value }
}

/**
 * Security: turn an untrusted IPC payload into a NetworkShareConfigInput.
 *
 * The channel behind this used to take `config: any` straight from the
 * renderer, so protocol, host and mountPoint were whatever the renderer said
 * they were — including objects and null bytes (security audit 2026-10-26).
 * Field-by-field checks live here rather than in the IPC module so the main
 * process has one place to point at when a payload is rejected; whether the
 * proposed mountPoint may actually be GRANTED is a separate, stricter question
 * answered in FileAccessManager.addNetworkShare.
 */
export function parseNetworkShareConfig(raw: unknown): NetworkShareConfigParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, error: 'Network share config must be an object' }
  }
  const candidate = raw as Record<string, unknown>

  if (candidate.protocol !== 'smb' && candidate.protocol !== 'nfs') {
    return { valid: false, error: "Network share field 'protocol' must be 'smb' or 'nfs'" }
  }
  const protocol: NetworkShareConfig['protocol'] = candidate.protocol

  const name = checkStringField(candidate.name, 'name')
  if (!name.ok) return { valid: false, error: name.error }

  const host = checkStringField(candidate.host, 'host')
  if (!host.ok) return { valid: false, error: host.error }

  const shareName = checkStringField(candidate.shareName, 'shareName')
  if (!shareName.ok) return { valid: false, error: shareName.error }

  const config: NetworkShareConfigInput = {
    name: name.value,
    protocol,
    host: host.value,
    shareName: shareName.value
  }

  // Optional fields are only validated when present — an absent username is
  // normal for a guest share, an empty-string one is a malformed payload.
  for (const field of ['username', 'password', 'mountPoint'] as const) {
    if (candidate[field] === undefined) continue
    const parsed = checkStringField(candidate[field], field)
    if (!parsed.ok) return { valid: false, error: parsed.error }
    config[field] = parsed.value
  }

  return { valid: true, config }
}
