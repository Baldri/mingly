/**
 * RAGWissenClient against a real HTTP server that behaves like RAG-Wissen's core API.
 *
 * Measured on 2026-11-24 against the running src.api_server (port 8000):
 *   GET  /health   200 without credentials
 *   GET  /stats    401 without `Authorization: Bearer <key>`
 *   POST /search   401 without a key — and Mingly never sent one
 *   POST /retrieve 401 without a key
 *   POST /mcp      404 (the MCP server of RAG-Wissen speaks stdio, not HTTP)
 *
 * The fake server below models that, and the tests assert on what the server
 * saw (method, path, Authorization header) — not on a mocked fetch that already
 * assumes the right URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => userData.dir }
}))

import type { RAGWissenClient as RAGWissenClientType } from '../../src/main/rag/rag-wissen-client'

type ClientModule = typeof import('../../src/main/rag/rag-wissen-client')

const VALID_KEY = 'rw_test_valid_key_0123456789'

interface SeenRequest {
  method: string
  path: string
  authorization: string | undefined
}

interface FakeServer {
  port: number
  seen: SeenRequest[]
  close: () => Promise<void>
}

/** A server that answers like RAG-Wissen's core API, including its 401s and its 404s. */
async function startCoreApi(): Promise<FakeServer> {
  const seen: SeenRequest[] = []

  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    seen.push({ method: req.method ?? '', path: url, authorization: req.headers.authorization })

    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const authorised = req.headers.authorization === `Bearer ${VALID_KEY}`
    const needsAuth = (): boolean => {
      if (authorised) return true
      send(401, { detail: 'Authentication required. Provide Authorization: Bearer <api_key>' })
      return false
    }

    if (req.method === 'GET' && url === '/health') {
      return send(200, { status: 'ready', checks: { qdrant: { status: 'ok', points: 854957 } } })
    }
    if (req.method === 'GET' && url === '/stats') {
      if (!needsAuth()) return
      return send(200, { total_chunks: 854957 })
    }
    if (req.method === 'POST' && url === '/search') {
      if (!needsAuth()) return
      return send(200, {
        query: 'q',
        results: [
          {
            score: 0.81,
            content: 'Retrieval-Augmented Generation verbindet Suche und Generierung.',
            file_name: 'handbuch.pdf',
            file_path: '/docs/handbuch.pdf',
            file_type: 'pdf',
            chunk_index: 3
          }
        ],
        total_results: 1,
        search_time_ms: 12.5
      })
    }
    if (req.method === 'POST' && url === '/retrieve') {
      if (!needsAuth()) return
      return send(200, {
        query: 'q',
        context: 'Retrieval-Augmented Generation verbindet Suche und Generierung.',
        sources: [{ file: 'handbuch.pdf', score: 0.81 }],
        total_chunks: 1
      })
    }
    return send(404, { detail: 'Not Found' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** In-memory stand-in for the encrypted secret store. */
function memorySecrets(): { store: Map<string, string>; api: import('../../src/main/rag/rag-wissen-client').SecretStore } {
  const store = new Map<string, string>()
  return {
    store,
    api: {
      get: (key) => store.get(key),
      set: (key, value) => {
        store.set(key, value)
      },
      delete: (key) => {
        store.delete(key)
      }
    }
  }
}

describe('RAGWissenClient — REST mode against the core API', () => {
  let mod: ClientModule
  let server: FakeServer
  let secrets: ReturnType<typeof memorySecrets>

  beforeEach(async () => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-rag-auth-'))
    vi.resetModules()
    mod = await import('../../src/main/rag/rag-wissen-client')
    server = await startCoreApi()
    secrets = memorySecrets()
  })

  afterEach(async () => {
    await server.close()
    fs.rmSync(userData.dir, { recursive: true, force: true })
  })

  function clientForServer(): RAGWissenClientType {
    return new mod.RAGWissenClient(
      { host: '127.0.0.1', port: server.port, protocol: 'http', apiMode: 'rest' },
      { secrets: secrets.api }
    )
  }

  it('searches POST /search with the stored key and returns the hit', async () => {
    const client = clientForServer()
    client.updateConfig({ apiKey: VALID_KEY })

    const result = await client.search('Retrieval')

    expect(result.success).toBe(true)
    expect(result.results?.[0]).toMatchObject({ filename: 'handbuch.pdf', score: 0.81, chunk_index: 3 })
    const call = server.seen.find((r) => r.method === 'POST')
    expect(call).toEqual({ method: 'POST', path: '/search', authorization: `Bearer ${VALID_KEY}` })
  })

  it('tells the user that an API key is needed when the server answers 401', async () => {
    const client = clientForServer()

    const result = await client.search('Retrieval')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/401/)
    expect(result.error).toMatch(/API key/i)
  })

  it('also names the key when a key was sent and rejected', async () => {
    const client = clientForServer()
    client.updateConfig({ apiKey: 'rw_wrong_key' })

    const result = await client.search('Retrieval')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/API key/i)
  })

  it('fetches context from POST /retrieve with the stored key', async () => {
    const client = clientForServer()
    client.updateConfig({ apiKey: VALID_KEY })

    const result = await client.getContext('Retrieval')

    expect(result.success).toBe(true)
    expect(result.context).toContain('Retrieval-Augmented Generation')
    expect(result.sources).toEqual([{ filename: 'handbuch.pdf', score: 0.81 }])
    const call = server.seen.find((r) => r.method === 'POST')
    expect(call).toEqual({ method: 'POST', path: '/retrieve', authorization: `Bearer ${VALID_KEY}` })
  })

  describe('healthCheck does not report green for a server that will refuse every search', () => {
    it('says auth is ok when the key is accepted', async () => {
      const client = clientForServer()
      client.updateConfig({ apiKey: VALID_KEY })

      const result = await client.healthCheck()

      expect(result).toMatchObject({ success: true, auth: 'ok' })
    })

    it('says a key is required when none is stored', async () => {
      const result = await clientForServer().healthCheck()

      expect(result).toMatchObject({ success: true, auth: 'required' })
    })

    it('says the key was rejected when the server refuses it', async () => {
      const client = clientForServer()
      client.updateConfig({ apiKey: 'rw_wrong_key' })

      const result = await client.healthCheck()

      expect(result).toMatchObject({ success: true, auth: 'rejected' })
    })

    it('stays unknown in JSON-RPC mode, which has no authenticated probe', async () => {
      const client = new mod.RAGWissenClient(
        { host: '127.0.0.1', port: server.port, protocol: 'http', apiMode: 'jsonrpc' },
        { secrets: secrets.api }
      )

      const result = await client.healthCheck()

      expect(result).toMatchObject({ success: true, auth: 'unknown' })
      expect(server.seen.map((r) => r.path)).toEqual(['/health'])
    })
  })

  describe('the key is a secret', () => {
    it('never lands in the plain config file and is not returned by getConfig', () => {
      const client = clientForServer()

      client.updateConfig({ apiKey: VALID_KEY, defaultCollection: 'handbuecher' })

      expect(client.getConfig()).not.toHaveProperty('apiKey')
      expect(client.getConfig().hasApiKey).toBe(true)
      expect(secrets.store.size).toBe(1)

      const plain = fs
        .readdirSync(userData.dir)
        .map((name) => fs.readFileSync(path.join(userData.dir, name), 'utf-8'))
        .join('\n')
      expect(plain).toContain('handbuecher') // positive control: the config file was written
      expect(plain).not.toContain(VALID_KEY)
    })

    it('is picked up by a new client that shares the secret store', async () => {
      clientForServer().updateConfig({ apiKey: VALID_KEY })

      const next = clientForServer()

      expect(next.getConfig().hasApiKey).toBe(true)
      expect((await next.search('Retrieval')).success).toBe(true)
    })

    it('is removed by an empty string', () => {
      const client = clientForServer()
      client.updateConfig({ apiKey: VALID_KEY })

      client.updateConfig({ apiKey: '' })

      expect(client.getConfig().hasApiKey).toBe(false)
      expect(secrets.store.size).toBe(0)
    })

    it('is left alone by updates that do not mention it', () => {
      const client = clientForServer()
      client.updateConfig({ apiKey: VALID_KEY })

      client.updateConfig({ defaultCollection: 'notizen' })

      expect(client.getConfig().hasApiKey).toBe(true)
    })
  })
})
