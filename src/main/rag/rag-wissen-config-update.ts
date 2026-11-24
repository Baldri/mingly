/**
 * Validation of the `ragWissen:update-config` payload.
 *
 * The renderer is not trusted with the connection settings: they decide where
 * the API key is sent. Every field is checked, unknown fields are dropped, and
 * anything malformed is refused rather than repaired.
 */

import type { RAGWissenConfigUpdate } from './rag-wissen-client'

/** A bare host name or address: no scheme, no path, no credentials, no whitespace. */
const HOST_PATTERN = /^[A-Za-z0-9._\-[\]:]+$/

function invalid(field: string, requirement: string): never {
  throw new Error(`Invalid RAG-Wissen config: ${field} ${requirement}`)
}

export function parseRAGWissenConfigUpdate(input: unknown): RAGWissenConfigUpdate {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('payload', 'must be an object')
  }
  const source: Record<string, unknown> = Object.fromEntries(Object.entries(input))
  const update: RAGWissenConfigUpdate = {}

  if (source.host !== undefined) {
    const host = typeof source.host === 'string' ? source.host.trim() : ''
    if (!host || !HOST_PATTERN.test(host)) invalid('host', 'must be a bare host name or address')
    update.host = host
  }

  if (source.port !== undefined) {
    const port = source.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      invalid('port', 'must be an integer between 1 and 65535')
    }
    update.port = port
  }

  if (source.protocol !== undefined) {
    if (source.protocol !== 'http' && source.protocol !== 'https') invalid('protocol', 'must be http or https')
    update.protocol = source.protocol
  }

  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') invalid('enabled', 'must be a boolean')
    update.enabled = source.enabled
  }

  if (source.defaultCollection !== undefined) {
    const collection = source.defaultCollection
    if (typeof collection !== 'string' || !collection.trim() || collection.length > 200) {
      invalid('defaultCollection', 'must be a non-empty string of at most 200 characters')
    }
    update.defaultCollection = collection
  }

  if (source.apiMode !== undefined) {
    if (source.apiMode !== 'rest' && source.apiMode !== 'jsonrpc') invalid('apiMode', 'must be rest or jsonrpc')
    update.apiMode = source.apiMode
  }

  if (source.apiKey !== undefined) {
    if (typeof source.apiKey !== 'string') invalid('apiKey', 'must be a string')
    update.apiKey = source.apiKey
  }

  return update
}
