/**
 * Input Validator — Defense against malformed/malicious inputs
 *
 * Validates:
 * - RAG queries (length, encoding)
 * - MCP tool arguments (type, size)
 * - File paths (traversal attacks, null bytes)
 * - Collection names (alphanumeric + safe chars only)
 * - Generic strings (encoding, null bytes)
 *
 * DSGVO/DSG: No user content is logged — only validation metadata.
 */

// ============================================================
// Types
// ============================================================

export interface ValidationResult {
  valid: boolean
  error?: string
}

// ============================================================
// Constants
// ============================================================

const MAX_QUERY_LENGTH = 10_000       // 10k chars for RAG queries
const MAX_COLLECTION_NAME = 128       // Collection name max
const MAX_FILE_PATH_LENGTH = 1024     // File path max
const MAX_MCP_ARGS_SIZE = 50_000      // 50k chars for serialized MCP args

// Safe characters for collection names: alphanumeric, dash, underscore, dot
const COLLECTION_NAME_REGEX = /^[a-zA-Z0-9_\-\.]+$/

// Path traversal patterns
const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//,           // ../
  /\.\.\\/,           // ..\
  /\.\.$/,            // ends with ..
  /^\.\.$/,           // just ..
  /\0/,               // null byte injection
  /%00/,              // URL-encoded null byte
  /%2e%2e/i,          // URL-encoded ..
]

// ============================================================
// Validators
// ============================================================

/**
 * Validate a RAG search query.
 */
export function validateRAGQuery(query: unknown): ValidationResult {
  if (typeof query !== 'string') {
    return { valid: false, error: 'Query must be a string' }
  }
  if (query.length === 0) {
    return { valid: false, error: 'Query cannot be empty' }
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { valid: false, error: `Query exceeds max length (${MAX_QUERY_LENGTH} chars)` }
  }
  // Check for null bytes
  if (query.includes('\0')) {
    return { valid: false, error: 'Query contains invalid characters' }
  }
  return { valid: true }
}

/**
 * Validate a collection name (RAG, Qdrant).
 */
export function validateCollectionName(name: unknown): ValidationResult {
  if (typeof name !== 'string') {
    return { valid: false, error: 'Collection name must be a string' }
  }
  if (name.length === 0) {
    return { valid: false, error: 'Collection name cannot be empty' }
  }
  if (name.length > MAX_COLLECTION_NAME) {
    return { valid: false, error: `Collection name exceeds max length (${MAX_COLLECTION_NAME} chars)` }
  }
  if (!COLLECTION_NAME_REGEX.test(name)) {
    return { valid: false, error: 'Collection name may only contain alphanumeric characters, dashes, underscores, and dots' }
  }
  return { valid: true }
}

/**
 * Validate a file path (prevent traversal attacks).
 */
export function validateFilePath(filePath: unknown): ValidationResult {
  if (typeof filePath !== 'string') {
    return { valid: false, error: 'File path must be a string' }
  }
  if (filePath.length === 0) {
    return { valid: false, error: 'File path cannot be empty' }
  }
  if (filePath.length > MAX_FILE_PATH_LENGTH) {
    return { valid: false, error: `File path exceeds max length (${MAX_FILE_PATH_LENGTH} chars)` }
  }
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(filePath)) {
      return { valid: false, error: 'File path contains path traversal patterns' }
    }
  }
  return { valid: true }
}

/**
 * Validate MCP tool arguments.
 */
export function validateMCPArgs(args: unknown): ValidationResult {
  if (args === null || args === undefined) {
    return { valid: true } // optional args
  }
  if (typeof args !== 'object') {
    return { valid: false, error: 'MCP arguments must be an object' }
  }
  // Size check — serialize and measure
  try {
    const serialized = JSON.stringify(args)
    if (serialized.length > MAX_MCP_ARGS_SIZE) {
      return { valid: false, error: `MCP arguments exceed max size (${MAX_MCP_ARGS_SIZE} chars)` }
    }
  } catch {
    return { valid: false, error: 'MCP arguments are not serializable' }
  }
  return { valid: true }
}

/**
 * Validate a generic string input (non-empty, bounded, no null bytes).
 */
export function validateString(value: unknown, fieldName: string, maxLength: number = 10_000): ValidationResult {
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` }
  }
  if (value.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds max length (${maxLength} chars)` }
  }
  if (value.includes('\0')) {
    return { valid: false, error: `${fieldName} contains invalid characters` }
  }
  return { valid: true }
}

/**
 * Validate a positive integer (for limit, offset params).
 */
export function validatePositiveInt(value: unknown, fieldName: string, max: number = 10_000): ValidationResult {
  if (value === undefined || value === null) {
    return { valid: true } // optional
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { valid: false, error: `${fieldName} must be a non-negative integer` }
  }
  if (value > max) {
    return { valid: false, error: `${fieldName} exceeds maximum (${max})` }
  }
  return { valid: true }
}
