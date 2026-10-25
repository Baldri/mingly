/**
 * Transcription HTTP Client
 * Connects to the external Python FastAPI transcription service
 * (transcription-server/server.py): submit an audio file, then poll the job.
 *
 * Two kinds of failure are kept apart on purpose, because the job runner
 * reacts to them differently:
 *
 * - TranscriptionServiceUnreachableError: the service gave no usable answer
 *   (connection refused, no response in time, connection lost). The job did
 *   not fail - the runner leaves it queued and tries again later.
 * - TranscriptionServiceError: the service answered and said no (HTTP error,
 *   or a body that is not what the service promises). Retrying the same
 *   request will not change that.
 */

import type { TranscriptionSegment } from '../database/models/transcription'

export interface TranscriptionServerConfig {
  host: string
  port: number
  protocol: 'http' | 'https'
  /**
   * Bearer token for the authenticated endpoints (/transcribe, /jobs/{id}).
   * Leave unset when the service runs on loopback without a key; the header is
   * then not sent at all.
   */
  apiKey?: string
  /**
   * Limit for ONE HTTP request, in milliseconds. It is not a limit on a job:
   * transcribing a long recording legitimately takes tens of minutes, and the
   * job is observed by polling, one short request at a time.
   */
  requestTimeoutMs?: number
}

export interface TranscriptionHealth {
  status: string
  modelLoaded: boolean
  device: string
}

/** The states the service itself reports; "cancelled" exists only on Mingly's side. */
const JOB_STATES = ['queued', 'running', 'done', 'failed'] as const
export type TranscriptionServiceJobState = (typeof JOB_STATES)[number]

export interface TranscriptionJobStatus {
  state: TranscriptionServiceJobState
  /** Fraction from 0 to 1, exactly as the service reports it. Never rescaled. */
  progress: number
  /** Empty until the job is done. */
  segments: TranscriptionSegment[]
  /** Why the job failed. Set by the service for state 'failed' only. */
  error?: string
}

/** The service gave no usable answer; the job itself has not failed. */
export class TranscriptionServiceUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TranscriptionServiceUnreachableError'
  }
}

/** The service answered, but not with a usable result. */
export class TranscriptionServiceError extends Error {
  /** HTTP status of the answer (the status of a 2xx answer with an unusable body). */
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'TranscriptionServiceError'
    this.status = status
  }
}

const DEFAULT_CONFIG: TranscriptionServerConfig = {
  host: '127.0.0.1',
  port: 8765,
  protocol: 'http'
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** A response body that does not have the shape the service promises. */
class MalformedResponseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isJobState(value: unknown): value is TranscriptionServiceJobState {
  return JOB_STATES.some((state) => state === value)
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MalformedResponseError(`${what} is not an object`)
  return value
}

function parseHealth(body: unknown): TranscriptionHealth {
  const record = requireRecord(body, 'health response')
  if (typeof record.status !== 'string') throw new MalformedResponseError('health.status is not a string')
  if (typeof record.model_loaded !== 'boolean') {
    throw new MalformedResponseError('health.model_loaded is not a boolean')
  }
  if (typeof record.device !== 'string') throw new MalformedResponseError('health.device is not a string')
  return { status: record.status, modelLoaded: record.model_loaded, device: record.device }
}

function parseSubmit(body: unknown): { jobId: string } {
  const record = requireRecord(body, 'submit response')
  if (typeof record.job_id !== 'string' || record.job_id === '') {
    throw new MalformedResponseError('job_id is not a non-empty string')
  }
  return { jobId: record.job_id }
}

function parseSegment(value: unknown, jobId: string, index: number): TranscriptionSegment {
  const record = requireRecord(value, `segment ${index}`)
  if (!isFiniteNumber(record.start_ms) || !isFiniteNumber(record.end_ms)) {
    throw new MalformedResponseError(`segment ${index} has no numeric start_ms/end_ms`)
  }
  if (typeof record.speaker !== 'string' || typeof record.text !== 'string') {
    throw new MalformedResponseError(`segment ${index} has no speaker/text string`)
  }
  // The service does not know the job id it was asked about, and the position
  // in the array is the transcript order - both are filled in here so the rest
  // of the code works with one segment type (the one the job table stores).
  return {
    jobId,
    index,
    startMs: record.start_ms,
    endMs: record.end_ms,
    speaker: record.speaker,
    text: record.text
  }
}

function parseJobStatus(body: unknown, jobId: string): TranscriptionJobStatus {
  const record = requireRecord(body, 'job response')
  if (!isJobState(record.state)) throw new MalformedResponseError('job.state is not a known state')
  if (!isFiniteNumber(record.progress)) throw new MalformedResponseError('job.progress is not a number')
  if (!Array.isArray(record.segments)) throw new MalformedResponseError('job.segments is not a list')
  if (record.error !== null && record.error !== undefined && typeof record.error !== 'string') {
    throw new MalformedResponseError('job.error is neither a string nor null')
  }

  const segments = (record.segments as unknown[]).map((segment, index) => parseSegment(segment, jobId, index))
  return {
    state: record.state,
    progress: record.progress,
    segments,
    error: record.error ?? undefined
  }
}

/** FastAPI puts the reason in `detail`; for validation errors that is a list, which is not echoed. */
function extractDetail(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (isRecord(parsed) && typeof parsed.detail === 'string') return parsed.detail
  } catch {
    // Not JSON: no detail to offer.
  }
  return undefined
}

/** undici reports a refused connection as `TypeError: fetch failed`; the reason sits in `cause`. */
function describeNetworkFailure(error: unknown): string {
  if (error instanceof Error) {
    const cause: unknown = error.cause
    if (isRecord(cause)) {
      if (typeof cause.code === 'string') return cause.code
      if (typeof cause.message === 'string') return cause.message
    }
    return error.message
  }
  return 'unbekannter Fehler'
}

interface RequestOptions {
  method: 'GET' | 'POST'
  body?: unknown
  /** Whether the bearer token goes on this request. /health does not need it. */
  authenticated: boolean
}

export class TranscriptionHttpClient {
  private config: TranscriptionServerConfig

  constructor(config?: Partial<TranscriptionServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  updateConfig(config: Partial<TranscriptionServerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  private get baseUrl(): string {
    return `${this.config.protocol}://${this.config.host}:${this.config.port}`
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions,
    parse: (body: unknown) => T
  ): Promise<T> {
    // Everything that can be wrong with OUR input is built before the network
    // try-block. fetch reports an invalid URL or header value as the same
    // TypeError it uses for a refused connection, and a misconfigured key must
    // not be mistaken for an unreachable service - that would leave the job
    // queued for ever instead of surfacing the misconfiguration.
    const url = new URL(`${this.baseUrl}${endpoint}`)
    const headers = new Headers({ Accept: 'application/json' })
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.authenticated && this.config.apiKey) {
      try {
        headers.set('Authorization', `Bearer ${this.config.apiKey}`)
      } catch {
        // The runtime's own message quotes the rejected value, and that value
        // is the secret. This message ends up in the job's error field.
        throw new Error('Der API-Schlüssel für den Transkriptionsdienst enthält ungültige Zeichen')
      }
    }
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const signal = AbortSignal.timeout(timeoutMs)

    let status: number
    let ok: boolean
    let bodyText: string
    try {
      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal
      })
      status = response.status
      ok = response.ok
      // Read under the same signal: a service that sends headers and then
      // stalls must not hang the caller.
      bodyText = await response.text()
    } catch (cause) {
      const reason = signal.aborted ? `keine Antwort innerhalb von ${timeoutMs} ms` : describeNetworkFailure(cause)
      throw new TranscriptionServiceUnreachableError(
        `Transkriptionsdienst nicht erreichbar (${this.baseUrl}): ${reason}`,
        { cause }
      )
    }

    if (!ok) {
      const detail = extractDetail(bodyText)
      throw new TranscriptionServiceError(
        `Transkriptionsdienst hat die Anfrage abgelehnt (HTTP ${status})${detail ? `: ${detail}` : ''}`,
        status
      )
    }

    try {
      return parse(JSON.parse(bodyText) as unknown)
    } catch (error) {
      if (error instanceof MalformedResponseError || error instanceof SyntaxError) {
        throw new TranscriptionServiceError(
          `Unerwartete Antwort des Transkriptionsdienstes (HTTP ${status}): ${error.message}`,
          status
        )
      }
      throw error
    }
  }

  // ── Health ─────────────────────────────────────────────────────

  /** Needs no token; throws TranscriptionServiceUnreachableError when the service is down. */
  async healthCheck(): Promise<TranscriptionHealth> {
    return this.request('/health', { method: 'GET', authenticated: false }, parseHealth)
  }

  // ── Jobs ───────────────────────────────────────────────────────

  /**
   * Queue an audio file. The path is passed through as given: the service only
   * accepts paths inside its spool directory, and putting the file there is
   * the job runner's task, not the client's. The service's defaults apply for
   * the language (German) and, when no speaker count is given, for detection.
   */
  async submit(audioPath: string, numSpeakers?: number): Promise<{ jobId: string }> {
    const body: { audio_path: string; num_speakers?: number } = { audio_path: audioPath }
    if (numSpeakers !== undefined) body.num_speakers = numSpeakers
    return this.request('/transcribe', { method: 'POST', body, authenticated: true }, parseSubmit)
  }

  async poll(jobId: string): Promise<TranscriptionJobStatus> {
    return this.request(
      `/jobs/${encodeURIComponent(jobId)}`,
      { method: 'GET', authenticated: true },
      (body) => parseJobStatus(body, jobId)
    )
  }
}

// ── Singleton ──────────────────────────────────────────────────

let httpClientInstance: TranscriptionHttpClient | null = null

export function getTranscriptionHttpClient(): TranscriptionHttpClient {
  if (!httpClientInstance) {
    httpClientInstance = new TranscriptionHttpClient()
  }
  return httpClientInstance
}
