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
 * - rejected: the server answered 401/403 although a key was sent
 * - withheld: a key is stored but was not sent, because the connection is
 *             unencrypted and leads to another machine (see sendsKeyInCleartext)
 * - unknown:  not probed (JSON-RPC mode) or the probe itself failed
 */
export type RAGWissenAuthState = 'ok' | 'required' | 'rejected' | 'withheld' | 'unknown'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Would an API key cross a network in clear text? Plain http to this computer
 * never leaves the machine; plain http to anything else does.
 */
export function sendsKeyInCleartext(target: { protocol: 'http' | 'https'; host: string }): boolean {
  if (target.protocol === 'https') return false
  return !LOOPBACK_HOSTS.has(target.host.trim().toLowerCase())
}

/** The part of the `ragWissen:health` IPC answer the UI reads. */
export interface RAGWissenHealthResult {
  success?: boolean
  auth?: RAGWissenAuthState
  error?: string
}

/** True when searches against the server can be expected to return hits. */
export function isWissenUsable(result: RAGWissenHealthResult | null | undefined): boolean {
  if (!result || result.success !== true) return false
  return result.auth !== 'required' && result.auth !== 'rejected' && result.auth !== 'withheld'
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
    if (result.auth === 'withheld') {
      return {
        usable: false,
        label: 'Reachable, but the API key was not sent: the connection is not encrypted (use https)'
      }
    }
    return { usable: true, label: 'Connected' }
  }

  return { usable: false, label: result.error ? `Offline (${result.error})` : 'Offline' }
}
