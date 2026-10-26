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
    expect(afterOutage.error).toBeUndefined()
    expect(client.submitted).toHaveLength(1)

    // The queue is not a dead end: once the service answers, the same job runs.
    client.submitImpl = () => Promise.resolve({ jobId: 'svc-7' })
    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('running')
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
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')

    vi.setSystemTime(start + THIRTY_MINUTES_MS + 60 * 1000)
    await runner.tick()

    const stored = requireJob('tenant-a', job.id)
    expect(stored.state).toBe('failed')
    expect(stored.error).toMatch(/Fortschritt/)
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
    expect(stored.error).toContain(NOTHING_ALLOWED_POLICY.version)
    expect(client.submitted).toEqual([])
    // Refused before anything was copied anywhere.
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
    expect(requireJob('tenant-a', job.id).error).toBeUndefined()

    client.submitImpl = () => Promise.resolve({ jobId: 'svc-1' })
    await runner.tick()
    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(client.submitted).toHaveLength(2)

    client.pollImpl = () => Promise.reject(new TranscriptionServiceError('models not loaded', 503))
    await runner.tick()

    expect(requireJob('tenant-a', job.id).state).toBe('running')
    expect(client.submitted).toHaveLength(2)
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
