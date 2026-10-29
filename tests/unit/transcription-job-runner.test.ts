/**
 * TranscriptionJobRunner tests.
 *
 * Real sql.js database in a temp directory, exactly like
 * transcription-model.test.ts: what this runner promises is state
 * transitions, resumption and an audit trail, and none of that means
 * anything against a mocked model.
 *
 * The HTTP client is a scripted fake, because the three failure cases the
 * runner has to keep apart (unreachable, 404, 503) are distinguished by the
 * ERROR TYPE the client throws, not by wire behaviour - that is Task 5's
 * test. The fake records every call, so an assertion of the form "it did NOT
 * submit again" always sits next to one that shows it kept working.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  initializeDatabase,
  closeDatabase,
  dbAll,
  DEFAULT_TENANT_ID
} from '../../src/main/database/index'
import {
  TranscriptionModel,
  type TranscriptionJob,
  type TranscriptionJobState,
  type TranscriptionSegment
} from '../../src/main/database/models/transcription'
import {
  TranscriptionJobRunner,
  NO_TARGET,
  type TranscriptionJobClient,
  type TranscriptionJobRunnerOptions
} from '../../src/main/transcription/job-runner'
import {
  TranscriptionServiceError,
  TranscriptionServiceUnreachableError,
  type TranscriptionJobStatus
} from '../../src/main/transcription/transcription-http-client'
import { DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import type { PolicySet } from '../../src/main/policy/policy-types'
import { configureLogger } from '../../src/shared/logger'

const JOB_STATES: TranscriptionJobState[] = ['queued', 'running', 'done', 'failed', 'cancelled']

const THIRTY_MINUTES_MS = 30 * 60 * 1000

/** Matches MAX_COUNTED_OBSERVATION_GAP_MS: the longest gap counted in full. */
const FIVE_MINUTES_MS = 5 * 60 * 1000

/**
 * Permits nothing at any level, so `resolveTarget` returns a refusal. The
 * empty `allowedResidency` is the point: no candidate can match it.
 */
const NOTHING_ALLOWED_POLICY: PolicySet = {
  version: 'test-nothing-allowed.1',
  rules: [{ id: 'nothing-allowed', minSensitivity: 'low', allowedResidency: [] }]
}

/**
 * Permits CH residency only, so the on-device target is out and `resolveTarget`
 * succeeds with the remote one - the case Ruling 19 is about: a permitted
 * target for which no endpoint is configured.
 */
const CH_ONLY_POLICY: PolicySet = {
  version: 'test-ch-only.1',
  rules: [{ id: 'ch-only', minSensitivity: 'low', allowedResidency: ['CH'] }]
}

class FakeTranscriptionClient implements TranscriptionJobClient {
  readonly submitted: string[] = []
  readonly polled: string[] = []

  submitImpl: (audioPath: string) => Promise<{ jobId: string }> = () =>
    Promise.resolve({ jobId: 'svc-1' })

  pollImpl: (serviceJobId: string) => Promise<TranscriptionJobStatus> = () =>
    Promise.resolve(runningStatus(0))

  submit(audioPath: string): Promise<{ jobId: string }> {
    this.submitted.push(audioPath)
    return this.submitImpl(audioPath)
  }

  poll(serviceJobId: string): Promise<TranscriptionJobStatus> {
    this.polled.push(serviceJobId)
    return this.pollImpl(serviceJobId)
  }
}

function runningStatus(progress: number): TranscriptionJobStatus {
  return { state: 'running', progress, segments: [] }
}

function doneStatus(segments: TranscriptionSegment[]): TranscriptionJobStatus {
  return { state: 'done', progress: 1, segments }
}

interface AuditEntry {
  event: string
  tenantId: string
  entityId: string
  details: Record<string, unknown>
}

/** Audit entries of one tenant in write order. */
function readAuditEntries(tenantId: string): AuditEntry[] {
  const rows = dbAll(
    `SELECT action, tenant_id, entity_id, details FROM activity_log
     WHERE tenant_id = ? ORDER BY created_at ASC, rowid ASC`,
    [tenantId]
  )

  return rows.map((row) => ({
    event: String(row.action),
    tenantId: String(row.tenant_id),
    entityId: String(row.entity_id),
    details: JSON.parse(
      typeof row.details === 'string' ? row.details : '{}'
    ) as Record<string, unknown>
  }))
}

describe('TranscriptionJobRunner', () => {
  let tmpDir: string
  let spoolDir: string
  let client: FakeTranscriptionClient

  beforeAll(() => {
    configureLogger({ level: 'error' })
  })

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-job-runner-'))
    spoolDir = path.join(tmpDir, 'spool')
    await initializeDatabase(tmpDir)
    client = new FakeTranscriptionClient()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    // Three tests make a model method throw; without this they would do so for
    // every test after them in this file.
    vi.restoreAllMocks()
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeRunner(overrides: TranscriptionJobRunnerOptions = {}): TranscriptionJobRunner {
    return new TranscriptionJobRunner({ tenantIds: ['tenant-a'], client, spoolDir, ...overrides })
  }

  function writeAudio(name: string, bytes: number): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, Buffer.alloc(bytes, 1))
    return file
  }

  /** The stored job, whatever state it is in. Throws when it is gone. */
  function requireJob(tenantId: string, id: string): TranscriptionJob {
    for (const state of JOB_STATES) {
      const found = TranscriptionModel.listByState(state, tenantId).find((job) => job.id === id)
      if (found) return found
    }
    throw new Error(`job ${id} of tenant ${tenantId} not found in any state`)
  }

  // ── Review-Focus 1: unusable audio ─────────────────────────────

  it('setzt den Job auf failed mit Meldung bei leerer Audiodatei', async () => {
    const audio = writeAudio('empty.wav', 0)
    const runner = makeRunner()

    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toMatch(/leer/)
    expect(client.submitted).toEqual([])
  })

  it('setzt den Job auf failed mit Meldung, wenn die Audiodatei fehlt', async () => {
    const runner = makeRunner()

    const job = await runner.enqueue('tenant-a', 'ws1', path.join(tmpDir, 'gone.wav'), 'critical')

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toMatch(/nicht gefunden/)
    expect(client.submitted).toEqual([])
  })

  // ── Review-Focus 3: service unreachable ────────────────────────

  it('laesst den Job queued, wenn der Dienst nicht erreichbar ist', async () => {
    const audio = writeAudio('a.wav', 64)
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')

    client.submitImpl = () => Promise.reject(new TranscriptionServiceUnreachableError('down'))
    await runner.tick()

    const afterOutage = requireJob('tenant-a', job.id)
    expect(afterOutage.state).toBe('queued')
    // Waiting, and visibly so: a job that sits in the queue because the
    // service is down must not look like one that is simply next in line.
    expect(afterOutage.error).toMatch(/^Wartet: /)
    expect(client.submitted).toHaveLength(1)

    // The queue is not a dead end: once the service answers, the same job runs
    // and the wait reason is gone.
    client.submitImpl = () => Promise.resolve({ jobId: 'svc-7' })
    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(requireJob('tenant-a', job.id).error).toBeUndefined()
    expect(client.submitted).toHaveLength(2)
  })

  // ── Review-Focus 5: resumption and no wall-clock limit ─────────

  it('nimmt einen beim Absturz running gebliebenen Job wieder auf', async () => {
    const audio = writeAudio('long.wav', 64)
    const stranded = TranscriptionModel.createJob('tenant-a', 'ws1', audio, 'local')
    TranscriptionModel.setState(stranded.id, 'running')
    TranscriptionModel.setProgress(stranded.id, 0.45)
    const runner = makeRunner()

    await runner.resumeInterrupted()

    expect(requireJob('tenant-a', stranded.id).state).toBe('queued')

    await runner.tick()

    expect(client.submitted).toEqual([audio])
    expect(requireJob('tenant-a', stranded.id).state).toBe('running')
  })

  it('stellt einen running-Job ohne Handle zurueck in die Warteschlange', async () => {
    const audio = writeAudio('orphan.wav', 64)
    const stranded = TranscriptionModel.createJob('tenant-a', 'ws1', audio, 'local')
    TranscriptionModel.setState(stranded.id, 'running')
    const runner = makeRunner()

    await runner.tick()

    // Nothing was polled - there was no service job id to poll with.
    expect(client.polled).toEqual([])
    expect(client.submitted).toEqual([audio])
    expect(requireJob('tenant-a', stranded.id).state).toBe('running')
  })

  it('bricht einen laufenden Job nicht nach festem Zeitlimit ab', async () => {
    const audio = writeAudio('meeting.wav', 64)
    const runner = makeRunner({ progressStallTimeoutMs: THIRTY_MINUTES_MS })
    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()

    // Eighty minutes of compute - far past any wall clock - but progress moves
    // every twenty minutes, so the job is never stalled.
    const stages = [0.1, 0.45, 0.7, 0.95]
    for (const [index, progress] of stages.entries()) {
      vi.setSystemTime(start + (index + 1) * 20 * 60 * 1000)
      client.pollImpl = () => Promise.resolve(runningStatus(progress))
      await runner.tick()
      expect(requireJob('tenant-a', job.id).state).toBe('running')
    }

    expect(requireJob('tenant-a', job.id).progress).toBe(0.95)
  })

  it('gibt einen Job auf, wenn der Fortschritt die konfigurierte Zeit stillsteht', async () => {
    const audio = writeAudio('stalled.wav', 64)
    const runner = makeRunner({ progressStallTimeoutMs: THIRTY_MINUTES_MS })
    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')
    await runner.tick()

    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    client.pollImpl = () => Promise.resolve(runningStatus(0.45))

    // First observation moves progress 0 -> 0.45 and resets the clock.
    vi.setSystemTime(start + FIVE_MINUTES_MS)
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    // Progress now stops moving. Six five-minute observations are exactly the
    // window, which is not yet past it ...
    for (let step = 2; step <= 7; step++) {
      vi.setSystemTime(start + step * FIVE_MINUTES_MS)
      await runner.tick()
    }
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    // ... and the seventh takes it past.
    vi.setSystemTime(start + 8 * FIVE_MINUTES_MS)
    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toMatch(/Fortschritt/)
  })

  it('laesst einen Job nicht scheitern, wenn der Rechner laenger geschlafen hat als das Stillstandsfenster', async () => {
    const audio = writeAudio('slept.wav', 64)
    const runner = makeRunner({ progressStallTimeoutMs: THIRTY_MINUTES_MS })
    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')
    await runner.tick()

    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    client.pollImpl = () => Promise.resolve(runningStatus(0.45))
    vi.setSystemTime(start + FIVE_MINUTES_MS)
    await runner.tick()

    // The lid closes for eight hours. The local service is suspended with the
    // app, so on wake it reports the progress it had before - sixteen times
    // the window as a wall-clock delta, but nobody was awake for it.
    vi.setSystemTime(start + FIVE_MINUTES_MS + 8 * 60 * 60 * 1000)
    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(requireJob('tenant-a', job.id).error).toBeUndefined()
  })

  it('laesst die Stillstandsuhr nicht laufen, solange der Dienst den Job nur in seiner Warteschlange hat', async () => {
    const audio = writeAudio('waiting.wav', 64)
    const runner = makeRunner({ progressStallTimeoutMs: THIRTY_MINUTES_MS })
    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')
    await runner.tick()

    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    client.pollImpl = () => Promise.resolve({ state: 'queued', progress: 0, segments: [] })

    vi.setSystemTime(start + 2 * THIRTY_MINUTES_MS)
    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('running')
  })

  // ── Residency decision ─────────────────────────────────────────

  it('verweigert den Start, wenn resolveTarget kein Ziel erlaubt', async () => {
    const audio = writeAudio('a.wav', 64)
    const runner = makeRunner({ policy: NOTHING_ALLOWED_POLICY })

    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    // The sentinel is what distinguishes THIS branch from "a target was
    // permitted but has no endpoint": the policy version appears in both
    // messages, and neither branch copies anything into the spool.
    expect(stored.targetId).toBe(NO_TARGET)
    expect(stored.error).toContain(NOTHING_ALLOWED_POLICY.version)
    expect(client.submitted).toEqual([])
    expect(fs.existsSync(spoolDir)).toBe(false)
  })

  it('verweigert den Lauf, wenn die Policy ein Ziel erlaubt, fuer das kein Endpunkt konfiguriert ist', async () => {
    const audio = writeAudio('a.wav', 64)
    const runner = makeRunner({ policy: CH_ONLY_POLICY })

    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toMatch(/nicht konfiguriert/)
    expect(stored.error).toContain(stored.targetId)
    // Ruling 19: the policy decision is NOT quietly replaced by a local run.
    expect(stored.targetId).not.toBe('local')
    expect(client.submitted).toEqual([])
  })

  // ── Ruling 9/21: the spool copy ────────────────────────────────

  it('kopiert die Aufnahme in das Spool-Verzeichnis und reicht den kopierten Pfad ein', async () => {
    const audio = writeAudio('original.wav', 128)
    const runner = makeRunner()

    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')

    expect(job.audioPath).not.toBe(audio)
    expect(job.audioPath.startsWith(spoolDir + path.sep)).toBe(true)
    expect(path.extname(job.audioPath)).toBe('.wav')
    expect(fs.readFileSync(job.audioPath)).toEqual(fs.readFileSync(audio))
    // The service refuses symlinks outright, so the copy must be a plain file.
    expect(fs.lstatSync(job.audioPath).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(audio)).toBe(true)

    await runner.tick()

    expect(client.submitted).toEqual([job.audioPath])
  })

  it('legt ein selbst erzeugtes Spool-Verzeichnis mit 0700 an', async () => {
    const runner = makeRunner()

    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    expect(fs.statSync(spoolDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(job.audioPath).mode & 0o777).toBe(0o600)
  })

  it('verweigert den Job, wenn das vorhandene Spool-Verzeichnis anderen Konten offensteht', async () => {
    // THE case that happens in production: the service has to be running
    // before Mingly submits anything, and it creates the spool itself. A mode
    // argument does nothing to a directory that already exists, so this branch
    // - not the one above - is the normal one.
    fs.mkdirSync(spoolDir, { recursive: true })
    fs.chmodSync(spoolDir, 0o755)
    const runner = makeRunner()

    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toContain('755')
    expect(stored.error).toContain(spoolDir)
    // Refused, not quietly tightened: the directory is someone else's.
    expect(fs.statSync(spoolDir).mode & 0o777).toBe(0o755)
    // And no recording was written into it.
    expect(fs.readdirSync(spoolDir)).toEqual([])
    expect(client.submitted).toEqual([])
  })

  it('nimmt ein vorhandenes, dicht gesetztes Spool-Verzeichnis an', async () => {
    // Positive control for the refusal above: 0700 from the service's own
    // mkdir must pass, otherwise the check would simply block everything.
    fs.mkdirSync(spoolDir, { recursive: true })
    fs.chmodSync(spoolDir, 0o700)
    const runner = makeRunner()

    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    expect(requireJob('tenant-a', job.id).state).toBe('queued')
    expect(fs.statSync(job.audioPath).mode & 0o777).toBe(0o600)
  })

  it('legt die Kopie nie mit einem anderen Modus als 0600 an', async () => {
    // Asserting the mode of the FINISHED file would not notice a creation
    // window. Eight megabytes take many event-loop turns to stream, so the
    // sampling loop below genuinely observes the file while it is incomplete -
    // and the test fails if it never managed to, rather than passing on a
    // sample it never took.
    const size = 8 * 1024 * 1024
    const audio = writeAudio('big.wav', size)
    const runner = makeRunner()

    const observedModes = new Set<number>()
    let sawIncompleteFile = false
    let settled = false

    const pending = runner.enqueue('tenant-a', 'ws1', audio, 'critical').then(
      (job) => {
        settled = true
        return job
      },
      (error: unknown) => {
        settled = true
        throw error
      }
    )

    const sample = (): void => {
      if (!fs.existsSync(spoolDir)) return
      for (const name of fs.readdirSync(spoolDir)) {
        const stat = fs.statSync(path.join(spoolDir, name))
        observedModes.add(stat.mode & 0o777)
        if (stat.size < size) sawIncompleteFile = true
      }
    }

    while (!settled) {
      sample()
      await new Promise((resolve) => setImmediate(resolve))
    }
    const job = await pending
    sample()

    expect(sawIncompleteFile).toBe(true)
    expect([...observedModes]).toEqual([0o600])
    expect(fs.statSync(job.audioPath).size).toBe(size)
  })

  it('laesst keine Kopie im Spool zurueck, wenn die Aufnahme nicht lesbar ist', async () => {
    const audio = writeAudio('locked.wav', 64)
    fs.chmodSync(audio, 0o000)
    const runner = makeRunner()

    const job = await runner.enqueue('tenant-a', 'ws1', audio, 'critical')

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toMatch(/kopiert/)
    expect(fs.readdirSync(spoolDir)).toEqual([])
  })

  it('laesst keine Kopie im Spool zurueck, wenn der Job nicht angelegt werden kann', async () => {
    const runner = makeRunner()

    // Positive control: a successful enqueue DOES leave its copy there.
    await runner.enqueue('tenant-a', 'ws1', writeAudio('kept.wav', 64), 'critical')
    expect(fs.readdirSync(spoolDir)).toHaveLength(1)

    // Now make `createJob` throw. Without cleanup the copy would stay behind
    // with no row pointing at it, and Task 9's deletion walks jobs.
    closeDatabase()
    await expect(
      runner.enqueue('tenant-a', 'ws1', writeAudio('orphan.wav', 64), 'critical')
    ).rejects.toThrow()

    expect(fs.readdirSync(spoolDir)).toHaveLength(1)
  })

  it('nutzt TRANSCRIPTION_SPOOL_DIR, wenn kein Verzeichnis uebergeben wurde', async () => {
    const envSpool = path.join(tmpDir, 'env-spool')
    vi.stubEnv('TRANSCRIPTION_SPOOL_DIR', envSpool)
    const runner = new TranscriptionJobRunner({ tenantIds: ['tenant-a'], client })

    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 16), 'critical')

    expect(requireJob('tenant-a', job.id).state).toBe('queued')
    expect(job.audioPath.startsWith(envSpool + path.sep)).toBe(true)
  })

  it('laesst den Job mit klarer Meldung scheitern, wenn kein Spool-Verzeichnis konfiguriert ist', async () => {
    vi.stubEnv('TRANSCRIPTION_SPOOL_DIR', undefined)
    const runner = new TranscriptionJobRunner({ tenantIds: ['tenant-a'], client })

    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 16), 'critical')

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toContain('TRANSCRIPTION_SPOOL_DIR')
    expect(client.submitted).toEqual([])
  })

  // ── Ruling 23: three failure cases, kept apart ─────────────────

  it('pollt weiter und reicht NICHT erneut ein, wenn der Dienst beim Pollen nicht erreichbar ist', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()
    expect(client.submitted).toHaveLength(1)

    client.pollImpl = () => Promise.reject(new TranscriptionServiceUnreachableError('down'))
    await runner.tick()
    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('running')
    // It kept polling (so the assertion below is about a runner that worked) ...
    expect(client.polled.length).toBeGreaterThanOrEqual(2)
    // ... and it did not transcribe the same audio a second time.
    expect(client.submitted).toHaveLength(1)
  })

  it('loescht den Wartegrund, sobald der Dienst wieder antwortet', async () => {
    // A running job that waited keeps its state, so no state change clears the
    // reason for it - it has to be cleared on the spot.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    client.pollImpl = () => Promise.reject(new TranscriptionServiceUnreachableError('down'))
    await runner.tick()
    // Positive control: there really was a reason to clear.
    expect(requireJob('tenant-a', job.id).error).toMatch(/^Wartet: /)

    client.pollImpl = () => Promise.resolve(runningStatus(0.45))
    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('running')
    expect(stored.error).toBeUndefined()
    expect(stored.progress).toBe(0.45)
  })

  it('reicht nach einem 404 des Dienstes erneut ein — dessen Warteschlange ist weg', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()
    expect(client.submitted).toHaveLength(1)

    client.pollImpl = () => Promise.reject(new TranscriptionServiceError('unknown job', 404))
    await runner.tick()

    expect(client.submitted).toHaveLength(2)
    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(requireJob('tenant-a', job.id).error).toBeUndefined()
  })

  it('laesst den Job bei 503 in der Warteschlange und beim Pollen laufen, statt ihn scheitern zu lassen', async () => {
    const runner = makeRunner()
    client.submitImpl = () => Promise.reject(new TranscriptionServiceError('models not loaded', 503))
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('queued')
    expect(requireJob('tenant-a', job.id).error).toMatch(/^Wartet: /)

    client.submitImpl = () => Promise.resolve({ jobId: 'svc-1' })
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(requireJob('tenant-a', job.id).error).toBeUndefined()
    expect(client.submitted).toHaveLength(2)

    client.pollImpl = () => Promise.reject(new TranscriptionServiceError('models not loaded', 503))
    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(client.submitted).toHaveLength(2)
  })

  it('laesst den Job bei 401 und 403 warten, statt ihn scheitern zu lassen', async () => {
    // Nobody wires an API key into the client before Task 7, so a service
    // that requires one answers 401 to everything. Failing the job would empty
    // the queue over a configuration problem of the installation.
    const runner = makeRunner()
    client.submitImpl = () => Promise.reject(new TranscriptionServiceError('Unauthorized', 401))
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    await runner.tick()

    const waiting = requireJob('tenant-a', job.id)
    expect(waiting.state).toBe('queued')
    expect(waiting.error).toMatch(/^Wartet: /)
    expect(waiting.error).toContain('Unauthorized')

    // Same on the poll path, with 403.
    client.submitImpl = () => Promise.resolve({ jobId: 'svc-1' })
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    client.pollImpl = () => Promise.reject(new TranscriptionServiceError('Forbidden', 403))
    await runner.tick()

    const stillRunning = requireJob('tenant-a', job.id)
    expect(stillRunning.state).toBe('running')
    expect(stillRunning.error).toContain('Forbidden')
    // And no second hand-over of the same audio.
    expect(client.submitted).toHaveLength(2)
  })

  it('laesst einen laufenden Job weiterlaufen, wenn eine Antwort des Dienstes unbrauchbar ist', async () => {
    // The client reports a malformed BODY as a TranscriptionServiceError that
    // carries the ANSWER's own 2xx status. The service accepted the job and is
    // computing; one garbled answer must not throw away forty minutes of work.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    client.pollImpl = () =>
      Promise.reject(
        new TranscriptionServiceError(
          'Unerwartete Antwort des Transkriptionsdienstes (HTTP 200): job.state is not a known state',
          200
        )
      )
    await runner.tick()
    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('running')
    expect(stored.error).toMatch(/^Wartet: /)
    // Two ticks after the submitting one, so two polls: it kept observing ...
    expect(client.polled).toHaveLength(2)
    // ... and did not hand the same audio over a second time.
    expect(client.submitted).toHaveLength(1)
  })

  it('laesst den Job in der Warteschlange, wenn die Antwort auf die Einreichung unbrauchbar ist', async () => {
    const runner = makeRunner()
    client.submitImpl = () =>
      Promise.reject(
        new TranscriptionServiceError(
          'Unerwartete Antwort des Transkriptionsdienstes (HTTP 200): job_id is not a non-empty string',
          200
        )
      )
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('queued')
    expect(stored.error).toMatch(/^Wartet: /)
  })

  it('laesst den Job bei 429 und 500 warten, statt ihn scheitern zu lassen', async () => {
    // FastAPI answers 500 for any unhandled exception in the handler, and a
    // reverse proxy adds 502/504. None of that is a statement about this
    // recording, so it must not empty the queue.
    const runner = makeRunner()
    client.submitImpl = () => Promise.reject(new TranscriptionServiceError('Too Many Requests', 429))
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('queued')

    client.submitImpl = () => Promise.resolve({ jobId: 'svc-1' })
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    client.pollImpl = () =>
      Promise.reject(new TranscriptionServiceError('Internal Server Error', 500))
    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('running')
    expect(stored.error).toContain('Internal Server Error')
    expect(client.submitted).toHaveLength(2)
  })

  it('ueberschreibt einen Zustandswechsel nicht, der waehrend der Einreichung passiert ist', async () => {
    // The job is read at the start of the pass and the submit request can take
    // 30 s. Writing that stale state back would silently revert whatever
    // happened in between - Task 8 wires a cancel through IPC.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    let rejectSubmit: ((reason: Error) => void) | undefined
    client.submitImpl = () =>
      new Promise<{ jobId: string }>((_resolve, reject) => {
        rejectSubmit = reject
      })

    const pass = runner.tick()
    for (let spin = 0; spin < 50 && rejectSubmit === undefined; spin++) await Promise.resolve()
    expect(rejectSubmit).toBeDefined()

    // Arrives while the pass sits in its submit request.
    TranscriptionModel.setState(job.id, 'cancelled')
    rejectSubmit?.(new TranscriptionServiceUnreachableError('down'))
    await pass

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('cancelled')
    // Changed requirement, not a loosened assertion: a wait reason may only be
    // written while the job is still waiting FOR something. This row is
    // cancelled, so it waits for nothing, and the IPC view would not show a
    // reason on it anyway - the same rule that stops a `done` row with a
    // missing transcript from explaining itself to nobody. What this test is
    // about, that the state change survives the pass, is asserted above and
    // unchanged.
    expect(stored.error).toBeUndefined()
  })

  // ── Ruling 34: a cancellation must not be overwritten ──────────

  it('macht aus einer Stornierung kein running, wenn die Einreichung danach gelingt', async () => {
    // The dangerous half of the window above: the submit SUCCEEDS. Writing
    // 'running' from the state read before the request would resurrect a job
    // the user cancelled, and the runner would then poll it to completion.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    let resolveSubmit: ((value: { jobId: string }) => void) | undefined
    client.submitImpl = () =>
      new Promise<{ jobId: string }>((resolve) => {
        resolveSubmit = resolve
      })

    const pass = runner.tick()
    for (let spin = 0; spin < 50 && resolveSubmit === undefined; spin++) await Promise.resolve()
    expect(resolveSubmit).toBeDefined()

    TranscriptionModel.setState(job.id, 'cancelled')
    resolveSubmit?.({ jobId: 'svc-1' })
    await pass

    expect(requireJob('tenant-a', job.id).state).toBe('cancelled')
    // The audio HAD been handed over - that cannot be taken back, and the
    // assertion is here so the one above cannot pass on a submit that never
    // happened.
    expect(client.submitted).toHaveLength(1)
  })

  it('macht aus einer Stornierung kein done, wenn der Dienst danach ein Ergebnis liefert', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    let resolvePoll: ((value: TranscriptionJobStatus) => void) | undefined
    client.pollImpl = () =>
      new Promise<TranscriptionJobStatus>((resolve) => {
        resolvePoll = resolve
      })

    const pass = runner.tick()
    for (let spin = 0; spin < 50 && resolvePoll === undefined; spin++) await Promise.resolve()
    expect(resolvePoll).toBeDefined()

    TranscriptionModel.setState(job.id, 'cancelled')
    resolvePoll?.(
      doneStatus([
        { jobId: 'svc-1', index: 0, startMs: 0, endMs: 1000, speaker: 'SPEAKER_00', text: 'Guten Tag' }
      ])
    )
    await pass

    expect(requireJob('tenant-a', job.id).state).toBe('cancelled')
    // No transcript for a job the user cancelled.
    expect(TranscriptionModel.getSegments(job.id, 'tenant-a')).toEqual([])
  })

  it('stellt einen stornierten Job nach einem 404 nicht zurueck in die Warteschlange', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    let rejectPoll: ((reason: Error) => void) | undefined
    client.pollImpl = () =>
      new Promise<TranscriptionJobStatus>((_resolve, reject) => {
        rejectPoll = reject
      })

    const pass = runner.tick()
    for (let spin = 0; spin < 50 && rejectPoll === undefined; spin++) await Promise.resolve()
    expect(rejectPoll).toBeDefined()

    TranscriptionModel.setState(job.id, 'cancelled')
    rejectPoll?.(new TranscriptionServiceError('unknown job', 404))
    await pass

    // A requeue here would transcribe the cancelled recording all over again.
    expect(requireJob('tenant-a', job.id).state).toBe('cancelled')
    await runner.tick()
    expect(client.submitted).toHaveLength(1)
  })

  it('laesst den Job scheitern, wenn der Dienst die Anfrage ablehnt', async () => {
    const runner = makeRunner()
    client.submitImpl = () =>
      Promise.reject(new TranscriptionServiceError('Audio file is not usable', 400))
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toContain('Audio file is not usable')
  })

  // ── One job's surprise is not the queue's outage ───────────────

  it('arbeitet die uebrigen Jobs weiter, wenn ein Job unerwartet wirft', async () => {
    // An unexpected error - not one of the two named service errors - used to
    // propagate out of the pass, so every job behind it was skipped and
    // nothing was recorded on any row. The client raises a plain Error for an
    // unusable API key, which made this reachable for the whole queue.
    const runner = makeRunner()
    const first = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    const second = await runner.enqueue('tenant-a', 'ws1', writeAudio('b.wav', 64), 'critical')

    client.submitImpl = (audioPath) =>
      path.basename(audioPath) === path.basename(requireJob('tenant-a', first.id).audioPath)
        ? Promise.reject(new Error('Der API-Schluessel enthaelt ungueltige Zeichen'))
        : Promise.resolve({ jobId: 'svc-2' })

    await runner.tick()

    // The job that threw carries a visible reason and stays in the queue.
    const stuck = requireJob('tenant-a', first.id)
    expect(stuck.state).toBe('queued')
    expect(stuck.error).toMatch(/^Wartet: /)

    // And the job behind it was handled in the SAME pass.
    expect(requireJob('tenant-a', second.id).state).toBe('running')
    expect(client.submitted).toHaveLength(2)
  })

  it('laesst einen Job nicht als done ohne Transkript und ohne Grund zurueck', async () => {
    // The blind spot where two correct fixes meet: the state change to 'done'
    // has already landed when saving the transcript fails. A wait reason on a
    // terminal row is deliberately not shown to the user, so the job would
    // read "finished" with an empty transcript and no explanation anywhere
    // except the log. Reaching 'done' without a transcript is not a success.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    client.pollImpl = () =>
      Promise.resolve(
        doneStatus([
          { jobId: 'svc-1', index: 0, startMs: 0, endMs: 1000, speaker: 'SPEAKER_00', text: 'Guten Tag' }
        ])
      )
    vi.spyOn(TranscriptionModel, 'saveSegments').mockImplementation(() => {
      throw new Error('Datenbank konnte die Segmente nicht speichern')
    })

    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toContain('Segmente')
    // Not a wait reason: a failure is what this is, and a wait reason would be
    // hidden on a terminal row.
    expect(stored.error).not.toMatch(/^Wartet: /)
  })

  it('gibt die Handles frei, wenn das Speichern nach dem Uebergang auf done scheitert', async () => {
    // Reaches into the runner on purpose. What is wrong here has no projection
    // on the public surface: both maps are keyed by job id, and a job in a
    // terminal state is never listed again, so an entry left behind is simply
    // never released for the rest of the process - invisible from outside, and
    // only growing. `observe` releases the handles AFTER saving the transcript,
    // so a throw from `saveSegments` skipped that step.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    const internals = runner as unknown as {
      tracked: Map<string, unknown>
      declaredLevels: Map<string, unknown>
    }
    // Positive control in the same run: the entries ARE there while the job
    // runs, so the assertions below measure a release and not an empty map.
    expect(internals.tracked.has(job.id)).toBe(true)
    expect(internals.declaredLevels.has(job.id)).toBe(true)

    client.pollImpl = () =>
      Promise.resolve(
        doneStatus([
          { jobId: 'svc-1', index: 0, startMs: 0, endMs: 1000, speaker: 'SPEAKER_00', text: 'Guten Tag' }
        ])
      )
    vi.spyOn(TranscriptionModel, 'saveSegments').mockImplementation(() => {
      throw new Error('Datenbank konnte die Segmente nicht speichern')
    })

    await runner.tick()

    // The audit entry of that last state change still carries the declared
    // level, so the release happens after it and not before.
    const failure = readAuditEntries('tenant-a').filter(
      (entry) => entry.entityId === job.id && entry.event === 'transcription.failed'
    )
    expect(failure).toHaveLength(1)
    expect(failure[0].details.declaredLevel).toBe('critical')

    expect(requireJob('tenant-a', job.id).state).toBe('failed')
    expect(internals.tracked.has(job.id)).toBe(false)
    expect(internals.declaredLevels.has(job.id)).toBe(false)
  })

  it('laesst einen Schreibfehler beim Vermerken nicht den Durchlauf abbrechen', async () => {
    // The containment of `attempt` has to cover its own recording too: if
    // writing the reason fails, the error used to escape the pass and every
    // job behind it was skipped again - the very shape the per-job guard
    // exists to prevent, one layer down.
    const runner = makeRunner()
    const first = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    const second = await runner.enqueue('tenant-a', 'ws1', writeAudio('b.wav', 64), 'critical')
    const firstPath = requireJob('tenant-a', first.id).audioPath

    client.submitImpl = (audioPath) =>
      audioPath === firstPath
        ? Promise.reject(new Error('unerwartet'))
        : Promise.resolve({ jobId: 'svc-2' })
    vi.spyOn(TranscriptionModel, 'setError').mockImplementation(() => {
      throw new Error('Datenbank nicht schreibbar')
    })

    await expect(runner.tick()).resolves.toBeUndefined()

    // The job behind the one that threw twice was still handled.
    expect(requireJob('tenant-a', second.id).state).toBe('running')
    expect(client.submitted).toHaveLength(2)
  })

  it('behaelt den Handle, wenn ein laufender Job nur einen Wartegrund bekommt', async () => {
    // The other side of releasing the handles: a wait reason must NOT release
    // them. The obvious way to fix the leak above is one `forget` at the top of
    // `recordUnexpectedError`, for every state - and that is wrong here, where
    // the job stays `running`. `observe` reads a running job without a handle
    // as "this process lost it", puts it back into the queue, and the next pass
    // submits the same audio a second time. Measured: with the release moved to
    // the front, `submitted` has two entries instead of one.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()
    expect(client.submitted).toHaveLength(1)
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    // An unexpected error while observing: neither unreachable nor a
    // TranscriptionServiceError, so it goes through `attempt` into
    // `recordUnexpectedError` and the job keeps its state.
    client.pollImpl = () => Promise.reject(new Error('unerwartet'))
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(requireJob('tenant-a', job.id).error).toMatch(/^Wartet: /)

    // Two more passes, with the service answering again: the first would
    // requeue a job whose handle is gone, the second would submit it anew.
    client.pollImpl = () => Promise.resolve(runningStatus(0.5))
    await runner.tick()
    await runner.tick()
    expect(client.submitted).toHaveLength(1)
    expect(requireJob('tenant-a', job.id).state).toBe('running')
  })

  // ── Overlapping passes ─────────────────────────────────────────

  it('reicht denselben Job nicht zweimal ein, wenn zwei Durchlaeufe sich ueberlappen', async () => {
    // Task 8 wires this as an IPC handler AND an interval, so two passes can
    // overlap. The row still reads `queued` for the whole duration of the
    // submit request, which is up to the client's 30 s limit.
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    let release: ((value: { jobId: string }) => void) | undefined
    client.submitImpl = () =>
      new Promise<{ jobId: string }>((resolve) => {
        release = resolve
      })

    const firstPass = runner.tick()
    const secondPass = runner.tick()
    // Let the first pass reach its submit request and stay there.
    for (let spin = 0; spin < 50 && release === undefined; spin++) await Promise.resolve()
    expect(release).toBeDefined()
    expect(client.submitted).toHaveLength(1)

    release?.({ jobId: 'svc-1' })
    await Promise.all([firstPass, secondPass])

    expect(client.submitted).toHaveLength(1)
    expect(requireJob('tenant-a', job.id).state).toBe('running')
  })

  it('laesst resumeInterrupted nicht neben einem Durchlauf laufen', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    let release: ((value: { jobId: string }) => void) | undefined
    client.submitImpl = () =>
      new Promise<{ jobId: string }>((resolve) => {
        release = resolve
      })

    const pass = runner.tick()
    const resume = runner.resumeInterrupted()
    for (let spin = 0; spin < 50 && release === undefined; spin++) await Promise.resolve()
    release?.({ jobId: 'svc-1' })
    await Promise.all([pass, resume])

    expect(client.submitted).toHaveLength(1)
    // Serialised rather than skipped: the resumption ran AFTER the pass, saw
    // the job as running and handed it back to the queue. A guard that simply
    // dropped the overlapping call would have left it `running`.
    expect(requireJob('tenant-a', job.id).state).toBe('queued')
  })

  // ── Result and progress ────────────────────────────────────────

  it('speichert den Fortschritt, wie der Dienst ihn meldet', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    client.pollImpl = () => Promise.resolve(runningStatus(0.45))
    await runner.tick()

    expect(requireJob('tenant-a', job.id).progress).toBe(0.45)
  })

  it('speichert die Segmente und setzt den Job auf done', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    client.pollImpl = () =>
      Promise.resolve(
        doneStatus([
          { jobId: 'svc-1', index: 0, startMs: 0, endMs: 1000, speaker: 'SPEAKER_00', text: 'Guten Tag' }
        ])
      )
    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('done')
    expect(stored.progress).toBe(1)
    const segments = TranscriptionModel.getSegments(job.id, 'tenant-a')
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Guten Tag')
    expect(segments[0].jobId).toBe(job.id)
  })

  it('uebernimmt die Begruendung des Dienstes, wenn dieser den Job scheitern laesst', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    client.pollImpl = () =>
      Promise.resolve({ state: 'failed', progress: 0.45, segments: [], error: 'ffmpeg konnte die Datei nicht lesen' })
    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toContain('ffmpeg konnte die Datei nicht lesen')
  })

  // ── Step 4: the audit trail ────────────────────────────────────

  it('schreibt je Zustandswechsel einen Audit-Eintrag mit Mandant', async () => {
    const runner = makeRunner()

    await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')

    const entries = readAuditEntries('tenant-a')
    expect(entries.map((e) => e.event)).toEqual(['transcription.queued'])
    expect(entries[0].tenantId).toBe('tenant-a')
  })

  it('schreibt fuer jeden weiteren Zustandswechsel einen eigenen Eintrag', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()
    client.pollImpl = () => Promise.resolve(doneStatus([]))
    await runner.tick()

    const entries = readAuditEntries('tenant-a')
    expect(entries.map((e) => e.event)).toEqual([
      'transcription.queued',
      'transcription.running',
      'transcription.done'
    ])
    expect(entries.every((e) => e.entityId === job.id)).toBe(true)
  })

  it('nimmt Mandant, Arbeitsbereich, Stufe, Ziel und Policy-Version in den Eintrag — und keinen Transkriptinhalt', async () => {
    const runner = makeRunner()
    const job = await runner.enqueue('tenant-a', 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()
    client.pollImpl = () =>
      Promise.resolve(
        doneStatus([
          { jobId: 'svc-1', index: 0, startMs: 0, endMs: 1000, speaker: 'SPEAKER_00', text: 'Geheime Besprechung' }
        ])
      )
    await runner.tick()

    const entries = readAuditEntries('tenant-a')
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      expect(Object.keys(entry.details).sort()).toEqual([
        'declaredLevel',
        'policyVersion',
        'targetId',
        'workspaceId'
      ])
    }
    expect(entries[0].details).toEqual({
      workspaceId: 'ws1',
      declaredLevel: 'critical',
      targetId: 'local',
      policyVersion: DEFAULT_POLICY.version
    })

    // The transcript arrived (positive control) but never reached the log.
    expect(TranscriptionModel.getSegments(job.id, 'tenant-a')[0].text).toBe('Geheime Besprechung')
    expect(JSON.stringify(entries)).not.toContain('Geheime Besprechung')
  })

  it('traegt die erklaerte Stufe nur, solange sie bekannt ist', async () => {
    // A job from a previous process: transcription_jobs has no column for the
    // declared level, so after a restart it is genuinely unknown and the entry
    // says so rather than inventing one.
    const stranded = TranscriptionModel.createJob('tenant-a', 'ws1', writeAudio('a.wav', 64), 'local')
    TranscriptionModel.setState(stranded.id, 'running')
    const runner = makeRunner()

    await runner.resumeInterrupted()

    const entries = readAuditEntries('tenant-a')
    expect(entries.map((e) => e.event)).toEqual(['transcription.queued'])
    expect(entries[0].details.declaredLevel).toBeNull()
  })

  // ── Tenants ────────────────────────────────────────────────────

  it('weist einen Mandanten ab, den dieser Runner nicht bedient', async () => {
    const runner = makeRunner()

    await expect(
      runner.enqueue('tenant-b', 'ws1', writeAudio('a.wav', 64), 'critical')
    ).rejects.toThrow(/tenant-b/)

    expect(TranscriptionModel.listByState('queued', 'tenant-b')).toEqual([])
    expect(readAuditEntries('tenant-b')).toEqual([])
  })

  it('bedient ohne Angabe den Mandanten der Installation', async () => {
    const runner = new TranscriptionJobRunner({ client, spoolDir })

    const job = await runner.enqueue(DEFAULT_TENANT_ID, 'ws1', writeAudio('a.wav', 64), 'critical')
    await runner.tick()

    expect(job.tenantId).toBe(DEFAULT_TENANT_ID)
    expect(requireJob(DEFAULT_TENANT_ID, job.id).state).toBe('running')
    expect(client.submitted).toHaveLength(1)
  })
})
