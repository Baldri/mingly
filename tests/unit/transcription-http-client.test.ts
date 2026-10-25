/**
 * TranscriptionHttpClient tests.
 *
 * Runs against a real HTTP server on an ephemeral loopback port instead of a
 * mocked `fetch`. What this client promises is wire behaviour: which path is
 * called, whether the bearer token is on the request, and how a refused
 * connection, a stalled service or an HTTP error shows up as an error. A mock
 * would only echo back the assumptions made when writing it.
 *
 * Header and body assertions always sit next to a request the fake service
 * actually recorded, so an assertion on "no Authorization header" cannot pass
 * just because no request was made.
 */

import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import {
  TranscriptionHttpClient,
  type TranscriptionServerConfig,
  TranscriptionServiceError,
  TranscriptionServiceUnreachableError,
  getTranscriptionHttpClient
} from '../../src/main/transcription/transcription-http-client'

interface RecordedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

type Responder = (request: RecordedRequest, response: http.ServerResponse) => void

interface FakeService {
  port: number
  requests: RecordedRequest[]
}

const API_KEY = 'test-key-4711'

const openServers: http.Server[] = []

async function startFakeService(respond: Responder): Promise<FakeService> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }
      requests.push(recorded)
      respond(recorded, res)
    })
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, requests }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A port nothing listens on: bind an ephemeral port, then release it. */
async function reserveClosedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * A client for the fake service, with the test key unless overridden. An
 * explicit `{ apiKey: undefined }` removes the key - a default parameter would
 * have swallowed it and put the key back.
 */
function clientFor(service: FakeService, overrides: Partial<TranscriptionServerConfig> = {}) {
  return new TranscriptionHttpClient({ host: '127.0.0.1', port: service.port, apiKey: API_KEY, ...overrides })
}

const DONE_BODY = {
  state: 'done',
  progress: 1,
  segments: [
    { start_ms: 0, end_ms: 4200, speaker: 'SPEAKER_00', text: 'Guten Tag zusammen.' },
    { start_ms: 4300, end_ms: 9100, speaker: 'SPEAKER_01', text: 'Danke, fangen wir an.' },
    { start_ms: 9200, end_ms: 12000, speaker: 'SPEAKER_00', text: 'Erster Punkt.' }
  ],
  error: null
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          // Keep-alive sockets and deliberately stalled responses would
          // otherwise hold close() open.
          server.closeAllConnections()
        })
    )
  )
})

describe('TranscriptionHttpClient', () => {
  describe('healthCheck', () => {
    it('wandelt snake_case der Antwort in camelCase', async () => {
      const service = await startFakeService((_req, res) =>
        sendJson(res, 200, { status: 'healthy', model_loaded: true, device: 'cuda' })
      )

      const health = await clientFor(service).healthCheck()

      expect(health).toEqual({ status: 'healthy', modelLoaded: true, device: 'cuda' })
      expect(service.requests).toHaveLength(1)
      expect(service.requests[0].method).toBe('GET')
      expect(service.requests[0].url).toBe('/health')
    })

    it('liefert auch den Zustand ohne geladenes Modell, ohne zu werfen', async () => {
      const service = await startFakeService((_req, res) =>
        sendJson(res, 200, { status: 'degraded', model_loaded: false, device: 'cpu' })
      )

      await expect(clientFor(service).healthCheck()).resolves.toEqual({
        status: 'degraded',
        modelLoaded: false,
        device: 'cpu'
      })
    })

    it('sendet den Schluessel nicht an /health, aber an die geschuetzten Endpunkte', async () => {
      const service = await startFakeService((req, res) => {
        if (req.url === '/health') return sendJson(res, 200, { status: 'healthy', model_loaded: true, device: 'cpu' })
        if (req.url === '/transcribe') return sendJson(res, 200, { job_id: 'job-1' })
        return sendJson(res, 200, DONE_BODY)
      })
      const client = clientFor(service)

      await client.healthCheck()
      await client.submit('/spool/a.wav')
      await client.poll('job-1')

      // The same client, in the same run, put the token on the two protected
      // calls - so its absence on /health is a decision, not a broken header.
      const byUrl = new Map(service.requests.map((r) => [r.url, r.headers.authorization]))
      expect(byUrl.get('/health')).toBeUndefined()
      expect(byUrl.get('/transcribe')).toBe(`Bearer ${API_KEY}`)
      expect(byUrl.get('/jobs/job-1')).toBe(`Bearer ${API_KEY}`)
    })
  })

  describe('submit', () => {
    it('schickt Pfad und Sprecherzahl unveraendert und liefert die Job-ID', async () => {
      const service = await startFakeService((_req, res) => sendJson(res, 200, { job_id: 'abc-123' }))

      const result = await clientFor(service).submit('/spool/meeting.wav', 3)

      expect(result).toEqual({ jobId: 'abc-123' })
      expect(service.requests).toHaveLength(1)
      const request = service.requests[0]
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/transcribe')
      expect(request.headers['content-type']).toMatch(/^application\/json/)
      expect(JSON.parse(request.body)).toEqual({ audio_path: '/spool/meeting.wav', num_speakers: 3 })
    })

    it('laesst num_speakers weg, wenn keine Sprecherzahl bekannt ist', async () => {
      const service = await startFakeService((_req, res) => sendJson(res, 200, { job_id: 'abc-123' }))

      await clientFor(service).submit('/spool/meeting.wav')

      expect(JSON.parse(service.requests[0].body)).toEqual({ audio_path: '/spool/meeting.wav' })
    })

    it('sendet ohne konfigurierten Schluessel keinen Authorization-Header', async () => {
      const service = await startFakeService((_req, res) => sendJson(res, 200, { job_id: 'abc-123' }))

      await clientFor(service, { apiKey: undefined }).submit('/spool/a.wav')
      await clientFor(service, { apiKey: '' }).submit('/spool/a.wav')
      await clientFor(service).submit('/spool/a.wav')

      expect(service.requests.map((r) => r.headers.authorization)).toEqual([
        undefined,
        undefined,
        `Bearer ${API_KEY}`
      ])
    })
  })

  describe('poll', () => {
    it('wandelt snake_case in camelCase und setzt jobId und index aus der Anfrage', async () => {
      const service = await startFakeService((_req, res) => sendJson(res, 200, DONE_BODY))

      const status = await clientFor(service).poll('job-7')

      expect(service.requests).toHaveLength(1)
      expect(service.requests[0].method).toBe('GET')
      expect(service.requests[0].url).toBe('/jobs/job-7')
      expect(status.state).toBe('done')
      expect(status.segments).toEqual([
        { jobId: 'job-7', index: 0, startMs: 0, endMs: 4200, speaker: 'SPEAKER_00', text: 'Guten Tag zusammen.' },
        { jobId: 'job-7', index: 1, startMs: 4300, endMs: 9100, speaker: 'SPEAKER_01', text: 'Danke, fangen wir an.' },
        { jobId: 'job-7', index: 2, startMs: 9200, endMs: 12000, speaker: 'SPEAKER_00', text: 'Erster Punkt.' }
      ])
    })

    it('reicht den Fortschritt als Bruchteil 0 bis 1 unveraendert durch', async () => {
      const service = await startFakeService((_req, res) =>
        sendJson(res, 200, { state: 'running', progress: 0.42, segments: [], error: null })
      )

      const status = await clientFor(service).poll('job-7')

      expect(status.progress).toBe(0.42)
      expect(status.segments).toEqual([])
    })

    it('liefert die Fehlermeldung eines fehlgeschlagenen Jobs und sonst keine', async () => {
      const failed = await startFakeService((_req, res) =>
        sendJson(res, 200, { state: 'failed', progress: 0.1, segments: [], error: 'RuntimeError: out of memory' })
      )
      const running = await startFakeService((_req, res) =>
        sendJson(res, 200, { state: 'running', progress: 0.1, segments: [], error: null })
      )

      const failedStatus = await clientFor(failed).poll('job-1')
      const runningStatus = await clientFor(running).poll('job-1')

      expect(failedStatus).toMatchObject({ state: 'failed', error: 'RuntimeError: out of memory' })
      expect(runningStatus.error).toBeUndefined()
    })

    it('kodiert die Job-ID im Pfad', async () => {
      const service = await startFakeService((_req, res) => sendJson(res, 200, DONE_BODY))
      const client = clientFor(service)

      await client.poll('plain-id')
      await client.poll('../health')

      // The plain id is the control: the recorder sees ordinary paths too.
      expect(service.requests.map((r) => r.url)).toEqual(['/jobs/plain-id', '/jobs/..%2Fhealth'])
    })
  })

  describe('Dienst nicht erreichbar', () => {
    it('wirft einen benannten Fehler, wenn der Dienst nicht erreichbar ist', async () => {
      const port = await reserveClosedPort()
      const client = new TranscriptionHttpClient({ host: '127.0.0.1', port, apiKey: API_KEY })

      await expect(client.healthCheck()).rejects.toThrow(/nicht erreichbar/)
      // The failure was a real refusal on a valid port, not some other fetch error.
      await expect(client.healthCheck()).rejects.toThrow(/ECONNREFUSED/)
      await expect(client.healthCheck()).rejects.toBeInstanceOf(TranscriptionServiceUnreachableError)
      await expect(client.submit('/spool/a.wav')).rejects.toBeInstanceOf(TranscriptionServiceUnreachableError)
      await expect(client.poll('job-1')).rejects.toBeInstanceOf(TranscriptionServiceUnreachableError)
    })

    it('unterscheidet sich vom Fehler einer Ablehnung', async () => {
      const port = await reserveClosedPort()
      const error = await new TranscriptionHttpClient({ host: '127.0.0.1', port })
        .healthCheck()
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(TranscriptionServiceUnreachableError)
      expect(error).not.toBeInstanceOf(TranscriptionServiceError)
      expect((error as Error).name).toBe('TranscriptionServiceUnreachableError')
    })

    it('behandelt einen Dienst ohne Antwort innerhalb des Anfrage-Zeitlimits als nicht erreichbar', async () => {
      const silent = await startFakeService(() => {
        /* never answers */
      })
      const answering = await startFakeService((_req, res) =>
        sendJson(res, 200, { status: 'healthy', model_loaded: true, device: 'cpu' })
      )

      // Control: the same timeout does not trip on a service that answers.
      await expect(clientFor(answering, { requestTimeoutMs: 1000 }).healthCheck()).resolves.toMatchObject({
        status: 'healthy'
      })

      await expect(clientFor(silent, { requestTimeoutMs: 100 }).healthCheck()).rejects.toBeInstanceOf(
        TranscriptionServiceUnreachableError
      )
      await expect(clientFor(silent, { requestTimeoutMs: 100 }).poll('job-1')).rejects.toThrow(/nicht erreichbar/)
    })

    it('beendet auch eine Antwort, deren Rumpf nie vollstaendig eintrifft', async () => {
      const stalling = await startFakeService((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"state": "running", ')
        // never ends
      })

      await expect(clientFor(stalling, { requestTimeoutMs: 100 }).poll('job-1')).rejects.toBeInstanceOf(
        TranscriptionServiceUnreachableError
      )
    })

    it('begrenzt jede Anfrage einzeln, nicht den Job insgesamt', async () => {
      const slow = await startFakeService((_req, res) => {
        setTimeout(() => sendJson(res, 200, { state: 'running', progress: 0.5, segments: [], error: null }), 150)
      })
      const client = clientFor(slow, { requestTimeoutMs: 400 })

      const started = Date.now()
      for (let i = 0; i < 4; i++) {
        await expect(client.poll('job-1')).resolves.toMatchObject({ state: 'running' })
      }

      // Four polls took longer than one request is allowed to - and none failed.
      expect(Date.now() - started).toBeGreaterThan(400)
      expect(slow.requests).toHaveLength(4)
    })
  })

  describe('Ablehnung durch den Dienst', () => {
    it.each([
      [401, 'Unauthorized.'],
      [400, 'Audio file is not usable.'],
      [503, 'Models are not loaded; the service cannot accept jobs.']
    ])('wirft bei HTTP %i einen Fehler mit Statuscode, der kein Erreichbarkeitsfehler ist', async (status, detail) => {
      const service = await startFakeService((_req, res) => sendJson(res, status, { detail }))

      const error = await clientFor(service).submit('/spool/a.wav').catch((e: unknown) => e)

      expect(service.requests).toHaveLength(1)
      expect(error).toBeInstanceOf(TranscriptionServiceError)
      expect(error).not.toBeInstanceOf(TranscriptionServiceUnreachableError)
      expect((error as TranscriptionServiceError).status).toBe(status)
      expect((error as TranscriptionServiceError).message).toContain(String(status))
      expect((error as TranscriptionServiceError).message).toContain(detail)
    })

    it('meldet einen unbekannten Job als Ablehnung mit Status 404', async () => {
      const service = await startFakeService((_req, res) => sendJson(res, 404, { detail: 'Unknown job.' }))

      const error = await clientFor(service).poll('gone').catch((e: unknown) => e)

      expect(error).toBeInstanceOf(TranscriptionServiceError)
      expect((error as TranscriptionServiceError).status).toBe(404)
      expect((error as TranscriptionServiceError).message).toContain('Unknown job.')
    })

    it('uebernimmt kein detail, das keine Zeichenkette ist (Validierungsfehler 422)', async () => {
      const service = await startFakeService((_req, res) =>
        sendJson(res, 422, { detail: [{ loc: ['body', 'num_speakers'], msg: 'too small' }] })
      )

      const error = await clientFor(service).submit('/spool/a.wav', 0).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(TranscriptionServiceError)
      expect((error as TranscriptionServiceError).status).toBe(422)
    })

    it('nennt den Schluessel in keiner Fehlermeldung', async () => {
      const rejecting = await startFakeService((_req, res) => sendJson(res, 401, { detail: 'Unauthorized.' }))
      const port = await reserveClosedPort()

      const rejected = await clientFor(rejecting).poll('job-1').catch((e: unknown) => e)
      const unreachable = await new TranscriptionHttpClient({ host: '127.0.0.1', port, apiKey: API_KEY })
        .poll('job-1')
        .catch((e: unknown) => e)

      // Both paths produced an error to look at - the assertion is not vacuous.
      expect(rejected).toBeInstanceOf(TranscriptionServiceError)
      expect(unreachable).toBeInstanceOf(TranscriptionServiceUnreachableError)
      expect(String((rejected as Error).message)).not.toContain(API_KEY)
      expect(String((unreachable as Error).message)).not.toContain(API_KEY)
    })
  })

  describe('unerwartete Antworten', () => {
    it('lehnt eine 200-Antwort ohne gueltigen JSON-Rumpf als Dienstfehler ab', async () => {
      const service = await startFakeService((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html>not the transcription service</html>')
      })

      const error = await clientFor(service).healthCheck().catch((e: unknown) => e)

      expect(error).toBeInstanceOf(TranscriptionServiceError)
      expect(error).not.toBeInstanceOf(TranscriptionServiceUnreachableError)
      expect((error as TranscriptionServiceError).status).toBe(200)
    })

    it.each([
      ['health ohne model_loaded', 'healthCheck', { status: 'healthy', device: 'cpu' }],
      ['submit ohne job_id', 'submit', { id: 'abc' }],
      ['poll mit unbekanntem Zustand', 'poll', { state: 'cancelled', progress: 0, segments: [], error: null }],
      ['poll mit Fortschritt als Text', 'poll', { state: 'running', progress: '50%', segments: [], error: null }],
      ['poll ohne Segmentliste', 'poll', { state: 'done', progress: 1, error: null }],
      [
        'poll mit unvollstaendigem Segment',
        'poll',
        { state: 'done', progress: 1, segments: [{ start_ms: 0, end_ms: 10, speaker: 'S0' }], error: null }
      ]
    ])('lehnt %s als Dienstfehler ab', async (_label, method, body) => {
      const service = await startFakeService((_req, res) => sendJson(res, 200, body))
      const client = clientFor(service)

      const call =
        method === 'healthCheck'
          ? client.healthCheck()
          : method === 'submit'
            ? client.submit('/spool/a.wav')
            : client.poll('job-1')
      const error = await call.catch((e: unknown) => e)

      expect(service.requests).toHaveLength(1)
      expect(error).toBeInstanceOf(TranscriptionServiceError)
      expect(error).not.toBeInstanceOf(TranscriptionServiceUnreachableError)
    })
  })

  describe('Konfiguration', () => {
    it('uebernimmt neue Werte aus updateConfig fuer die naechste Anfrage', async () => {
      const first = await startFakeService((_req, res) => sendJson(res, 200, { job_id: 'from-first' }))
      const second = await startFakeService((_req, res) => sendJson(res, 200, { job_id: 'from-second' }))
      const client = new TranscriptionHttpClient({ host: '127.0.0.1', port: first.port })

      await expect(client.submit('/spool/a.wav')).resolves.toEqual({ jobId: 'from-first' })
      client.updateConfig({ port: second.port, apiKey: API_KEY })
      await expect(client.submit('/spool/a.wav')).resolves.toEqual({ jobId: 'from-second' })

      expect(first.requests[0].headers.authorization).toBeUndefined()
      expect(second.requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`)
    })

    it('meldet einen unbrauchbaren Schluessel als Konfigurationsfehler, nicht als nicht erreichbar', async () => {
      const service = await startFakeService((_req, res) => sendJson(res, 200, { job_id: 'abc' }))

      // Control: the same service accepts a well-formed key.
      await expect(clientFor(service).submit('/spool/a.wav')).resolves.toEqual({ jobId: 'abc' })

      const error = await clientFor(service, { apiKey: 'secret\nvalue' })
        .submit('/spool/a.wav')
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(TranscriptionServiceUnreachableError)
      expect(error).not.toBeInstanceOf(TranscriptionServiceError)
      // The runtime's own message for a bad header value quotes the value.
      expect((error as Error).message).not.toMatch(/secret|value/)
      // Only the well-formed request reached the service.
      expect(service.requests).toHaveLength(1)
    })

    it('liefert ueber getTranscriptionHttpClient immer dieselbe Instanz', () => {
      expect(getTranscriptionHttpClient()).toBe(getTranscriptionHttpClient())
      expect(getTranscriptionHttpClient()).toBeInstanceOf(TranscriptionHttpClient)
    })
  })
})
