/**
 * Service discovery — RAG-Wissen
 *
 * The discovery table once pointed RAG-Wissen at port 8080 with path /health.
 * Measured on 2026-11-24 against the running servers:
 *
 *   :8000  RAG Unterrichtsmaterialien API (src.api_server) — the retrieval
 *          server. /health 200, /api/v1/heartbeat 404.
 *   :8080  RAG-Wissen Admin API (a different app, all routes under /api/v1/).
 *          /health 404, /api/v1/health 200.
 *
 * This test does not assert a URL. It models what each port answers and checks
 * the outcome: discovery must find the retrieval server, and must not report
 * the same server twice under two names.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { getServiceDiscovery } from '../../src/main/discovery/service-discovery'

/** What each endpoint answered when measured. Everything else refuses the connection. */
const MEASURED_RESPONSES: Record<string, { status: number; body: unknown }> = {
  'http://localhost:8000/health': {
    status: 200,
    body: { status: 'ready', checks: { qdrant: { status: 'ok' } } }
  },
  'http://localhost:8000/api/v1/heartbeat': { status: 404, body: { detail: 'Not Found' } },
  'http://localhost:8080/health': { status: 404, body: { detail: 'Not Found' } },
  'http://localhost:8080/api/v1/health': { status: 200, body: { status: 'ok' } },
  'http://localhost:6333/collections': { status: 200, body: { result: { collections: [] } } }
}

function modelOfMachine(input: string | URL | Request): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const answer = MEASURED_RESPONSES[url]
  if (!answer) return Promise.reject(new Error(`connect ECONNREFUSED ${url}`))
  return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }))
}

describe('service discovery — RAG-Wissen', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(modelOfMachine))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('finds the retrieval server that answers /health, not the admin API', async () => {
    const services = await getServiceDiscovery().discover({ type: 'rag', timeout: 200 })

    const online = services.filter((s) => s.provider === 'rag-wissen' && s.status === 'online')

    expect(online.map((s) => s.url)).toEqual(['http://localhost:8000'])
  })

  it('does not report one server twice under different names', async () => {
    const services = await getServiceDiscovery().discover({ type: 'rag', timeout: 200 })

    const onlineUrls = services.filter((s) => s.status === 'online').map((s) => s.url)

    expect(new Set(onlineUrls).size).toBe(onlineUrls.length)
  })

  it('still reports Qdrant, so the fix did not narrow the scan', async () => {
    const services = await getServiceDiscovery().discover({ type: 'rag', timeout: 200 })

    const qdrant = services.find((s) => s.provider === 'qdrant')

    expect(qdrant?.status).toBe('online')
  })
})
