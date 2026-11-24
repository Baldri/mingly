/**
 * What the UI may claim about the external knowledge server.
 *
 * The server's /health is public, but /search needs an API key. A successful
 * health check therefore only proves the server is reachable. `auth` carries
 * the answer to the question that matters: will a search return hits?
 */

/**
 * - ok:       an authenticated request succeeded
 * - required: the server answered 401/403 and no key is stored
 * - rejected: the server answered 401/403 although a key is stored
 * - unknown:  not probed (JSON-RPC mode) or the probe itself failed
 */
export type RAGWissenAuthState = 'ok' | 'required' | 'rejected' | 'unknown'

/** The part of the `ragWissen:health` IPC answer the UI reads. */
export interface RAGWissenHealthResult {
  success?: boolean
  auth?: RAGWissenAuthState
  error?: string
}

/** True when searches against the server can be expected to return hits. */
export function isWissenUsable(result: RAGWissenHealthResult | null | undefined): boolean {
  if (!result || result.success !== true) return false
  return result.auth !== 'required' && result.auth !== 'rejected'
}

export interface WissenStatusDescription {
  /** null while the first check is pending */
  usable: boolean | null
  label: string
}

export function describeWissenStatus(result: RAGWissenHealthResult | null): WissenStatusDescription {
  if (result === null) return { usable: null, label: 'Checking…' }

  if (result.success === true) {
    if (result.auth === 'required') {
      return { usable: false, label: 'Reachable, but an API key is required' }
    }
    if (result.auth === 'rejected') {
      return { usable: false, label: 'Reachable, but the API key was rejected' }
    }
    return { usable: true, label: 'Connected' }
  }

  return { usable: false, label: result.error ? `Offline (${result.error})` : 'Offline' }
}
