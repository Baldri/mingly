/**
 * Transcription IPC surface tests.
 *
 * The handlers are exercised through the channel they are registered on, not
 * by calling the functions directly: what this task produces is a channel
 * surface, and "it is registered on the right channel" is exactly the part a
 * refactor can quietly drop. `ipcMain.handle` is therefore captured rather
 * than mocked away.
 *
 * Everything below the handlers is real - a sql.js database in a temp
 * directory, the real feature gate, the real job runner, a real HTTP service
 * on an ephemeral loopback port for the API key. Only the two Electron
 * surfaces (`ipcMain`, `app.getPath`) are mocked, because there is no Electron
 * in a unit test.
 *
 * Every negative assertion sits next to a positive one in the same test: a
 * refusal that proves nothing because nothing was reachable in the first place
 * is not evidence.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'

// Defined through vi.hoisted because the vi.mock factory below is hoisted
// above the imports and would otherwise close over undefined bindings.
const { ipcHandlers, electronPaths } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  electronPaths: { userData: '' }
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronPaths.userData },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

import { IPC_CHANNELS } from '../../src/shared/types'
import {
  initializeDatabase,
  closeDatabase,
  DEFAULT_TENANT_ID
} from '../../src/main/database/index'
import {
  TranscriptionModel,
  type TranscriptionSegment
} from '../../src/main/database/models/transcription'
import {
  registerTranscriptionHandlers,
  startTranscriptionScheduler,
  stopTranscriptionScheduler,
  type TranscriptionJobView
} from '../../src/main/ipc/transcription-handlers'
import {
  applyTranscriptionApiKey,
  resolveTranscriptionApiKey
} from '../../src/main/config/transcription-config'
import { getTranscriptionHttpClient } from '../../src/main/transcription/transcription-http-client'
import { getFeatureGateManager } from '../../src/main/services/feature-gate-manager'
import { configureLogger } from '../../src/shared/logger'

const FOREIGN_TENANT = 'anderer-mandant'

interface JobResult {
  success: boolean
  error?: string
  job?: TranscriptionJobView
}

interface SegmentsResult {
  success: boolean
  error?: string
  segments?: TranscriptionSegment[]
}

interface RecordedRequest {
  url: string
  authorization: string | undefined
}

const openServers: http.Server[] = []

/** A service that answers every submit, and records how it was asked. */
async function startFakeService(): Promise<{ port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      requests.push({ url: req.url ?? '', authorization: req.headers.authorization })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ job_id: 'svc-1' }))
    })
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, requests }
}

function segment(jobId: string, text: string): TranscriptionSegment {
  return { jobId, index: 0, startMs: 0, endMs: 900, speaker: 'S0', text }
}

describe('Transkriptions-IPC', () => {
  let tmpDir: string
  let userDataDir: string
  /** A directory the user has granted Mingly access to; recordings live here. */
  let grantedDir: string

  async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const handler = ipcHandlers.get(channel)
    if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
    return (await handler(null, ...args)) as T
  }

  /** A directory that reached the allowlist as a network share - no dialog. */
  let networkShareDir: string
  /** A granted directory the user gave CREATE permission to, not read. */
  let createOnlyDir: string

  /** A recording where the user granted access. */
  function writeAudio(name: string): string {
    const file = path.join(grantedDir, name)
    fs.writeFileSync(file, Buffer.alloc(64, 1))
    return file
  }

  /** A recording in one of the other granted directories. */
  function writeAudioIn(directory: string, name: string): string {
    const file = path.join(directory, name)
    fs.writeFileSync(file, Buffer.alloc(64, 1))
    return file
  }

  /** A file somewhere the user never granted anything. */
  function writeOutside(name: string): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, Buffer.alloc(64, 1))
    return file
  }

  beforeAll(() => {
    configureLogger({ level: 'error' })
    // One stable userData directory for the whole file: the feature gate
    // singleton fixes its config path on construction, so a per-test
    // directory would be gone by the time it writes.
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-transcription-ipc-userdata-'))
    electronPaths.userData = userDataDir

    // Grant one directory through the real path the FileAccessManager loads
    // from, rather than mocking it away: `file-access.json` in userData is
    // what a directory the user picked leaves behind.
    grantedDir = path.join(userDataDir, 'aufnahmen')
    networkShareDir = path.join(userDataDir, 'netzlaufwerk')
    createOnlyDir = path.join(userDataDir, 'nur-schreiben')
    for (const dir of [grantedDir, networkShareDir, createOnlyDir]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(
      path.join(userDataDir, 'file-access.json'),
      JSON.stringify({
        allowedDirectories: [
          {
            id: 'granted-1',
            path: grantedDir,
            name: 'Aufnahmen',
            location: 'local',
            permissions: ['read'],
            recursive: true,
            grantedAt: Date.now(),
            accessCount: 0
          },
          // In the allowlist WITHOUT a dialog: addNetworkShare writes such an
          // entry straight from renderer input (file-access-manager.ts).
          {
            id: 'smb://x/y',
            path: networkShareDir,
            name: 'Netzlaufwerk',
            location: 'network-smb',
            permissions: ['read', 'create'],
            recursive: true,
            grantedAt: Date.now(),
            accessCount: 0
          },
          // Granted for writing AI output, never for reading.
          {
            id: 'granted-2',
            path: createOnlyDir,
            name: 'Nur Schreiben',
            location: 'local',
            permissions: ['create'],
            recursive: true,
            grantedAt: Date.now(),
            accessCount: 0
          }
        ]
      })
    )

    registerTranscriptionHandlers()
  })

  afterAll(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    for (const server of openServers) server.close()
  })

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-transcription-ipc-'))
    await initializeDatabase(tmpDir)
    vi.stubEnv('TRANSCRIPTION_SPOOL_DIR', path.join(tmpDir, 'spool'))
    // The transcription feature needs a paid tier; the tier test sets Free itself.
    getFeatureGateManager().setTier('pro')
  })

  afterEach(() => {
    stopTranscriptionScheduler()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    applyTranscriptionApiKey(undefined)
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Feature gate ───────────────────────────────────────────────

  it('verweigert den Zugriff unter der erforderlichen Abo-Stufe', async () => {
    const audio = writeAudio('a.wav')
    getFeatureGateManager().setTier('free')

    const denied = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', audio, 'critical')

    expect(denied.success).toBe(false)
    // The refusal names the tier it needs; the gate spells the tier the way
    // the subscription does, in lower case.
    expect(denied.error).toMatch(/requires pro plan/i)
    expect(denied.error).toContain('transcription')
    // The gate sits in FRONT of the work: nothing was queued, nothing copied.
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)

    // Positive control, same run: the identical call succeeds on the tier the
    // feature requires, so the refusal above is the gate and not a broken call.
    getFeatureGateManager().setTier('pro')
    const allowed = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', audio, 'critical')

    expect(allowed.success).toBe(true)
    expect(allowed.job?.state).toBe('queued')
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(1)
  })

  it('verweigert auch das Lesen unter der erforderlichen Abo-Stufe', async () => {
    const job = TranscriptionModel.createJob(DEFAULT_TENANT_ID, 'ws1', '/spool/a.wav', 'local')
    TranscriptionModel.saveSegments(job.id, [segment(job.id, 'Text')])
    getFeatureGateManager().setTier('free')

    const status = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_STATUS, job.id)
    const segments = await invoke<SegmentsResult>(IPC_CHANNELS.TRANSCRIPTION_SEGMENTS, job.id)

    expect(status.success).toBe(false)
    expect(segments.success).toBe(false)
    expect(segments.segments).toBeUndefined()

    getFeatureGateManager().setTier('pro')
    expect((await invoke<SegmentsResult>(IPC_CHANNELS.TRANSCRIPTION_SEGMENTS, job.id)).success).toBe(true)
  })

  // ── Tenant isolation ───────────────────────────────────────────

  it('gibt Segmente nur fuer den eigenen Mandanten heraus', async () => {
    const own = TranscriptionModel.createJob(DEFAULT_TENANT_ID, 'ws1', '/spool/own.wav', 'local')
    TranscriptionModel.saveSegments(own.id, [segment(own.id, 'eigener Text')])
    const foreign = TranscriptionModel.createJob(FOREIGN_TENANT, 'ws9', '/spool/fremd.wav', 'local')
    TranscriptionModel.saveSegments(foreign.id, [segment(foreign.id, 'fremder Text')])

    // Positive control first: the own transcript IS handed out, so an empty
    // answer below cannot come from a query that finds nothing at all.
    const mine = await invoke<SegmentsResult>(IPC_CHANNELS.TRANSCRIPTION_SEGMENTS, own.id)
    expect(mine.success).toBe(true)
    expect(mine.segments?.map((s) => s.text)).toEqual(['eigener Text'])

    const theirs = await invoke<SegmentsResult>(IPC_CHANNELS.TRANSCRIPTION_SEGMENTS, foreign.id)
    expect(theirs.success).toBe(false)
    expect(theirs.segments).toBeUndefined()
    expect(JSON.stringify(theirs)).not.toContain('fremder Text')
  })

  it('gibt den Status eines fremden Jobs nicht heraus', async () => {
    const foreign = TranscriptionModel.createJob(FOREIGN_TENANT, 'ws9', '/spool/fremd.wav', 'local')
    TranscriptionModel.setState(foreign.id, 'failed', 'fremde Fehlermeldung')
    const own = TranscriptionModel.createJob(DEFAULT_TENANT_ID, 'ws1', '/spool/own.wav', 'local')

    expect((await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_STATUS, own.id)).success).toBe(true)

    const theirs = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_STATUS, foreign.id)
    expect(theirs.success).toBe(false)
    expect(theirs.job).toBeUndefined()
    expect(JSON.stringify(theirs)).not.toContain('fremde Fehlermeldung')
  })

  // ── Ruling 33: the state is the truth, not the error field ─────

  it('meldet einen wartenden Job nicht als gescheitert', async () => {
    const waiting = TranscriptionModel.createJob(DEFAULT_TENANT_ID, 'ws1', '/spool/a.wav', 'local')
    // Exactly what the job runner writes while a job cannot be handed over.
    TranscriptionModel.setError(waiting.id, 'Wartet: Transkriptionsdienst nicht erreichbar')

    const queued = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_STATUS, waiting.id)

    expect(queued.job?.state).toBe('queued')
    expect(queued.job?.failureReason).toBeUndefined()
    expect(queued.job?.waitingReason).toBe('Transkriptionsdienst nicht erreichbar')

    // Positive control: a job that really failed does surface as failed, so
    // the assertion above is not "the fields are simply never filled".
    const broken = TranscriptionModel.createJob(DEFAULT_TENANT_ID, 'ws1', '/spool/b.wav', 'local')
    TranscriptionModel.setState(broken.id, 'failed', 'Die Audiodatei ist leer (0 Bytes)')

    const failed = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_STATUS, broken.id)

    expect(failed.job?.state).toBe('failed')
    expect(failed.job?.failureReason).toBe('Die Audiodatei ist leer (0 Bytes)')
    expect(failed.job?.waitingReason).toBeUndefined()
  })

  // ── Cancellation ───────────────────────────────────────────────

  it('storniert einen wartenden Job', async () => {
    const job = TranscriptionModel.createJob(DEFAULT_TENANT_ID, 'ws1', '/spool/a.wav', 'local')

    const result = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_CANCEL, job.id)

    expect(result.success).toBe(true)
    expect(result.job?.state).toBe('cancelled')
    expect(TranscriptionModel.getJob(job.id, DEFAULT_TENANT_ID)?.state).toBe('cancelled')
  })

  it('storniert keinen Job eines anderen Mandanten', async () => {
    const foreign = TranscriptionModel.createJob(FOREIGN_TENANT, 'ws9', '/spool/fremd.wav', 'local')

    const result = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_CANCEL, foreign.id)

    expect(result.success).toBe(false)
    expect(TranscriptionModel.getJob(foreign.id, FOREIGN_TENANT)?.state).toBe('queued')
  })

  it('storniert einen abgeschlossenen Job nicht', async () => {
    const job = TranscriptionModel.createJob(DEFAULT_TENANT_ID, 'ws1', '/spool/a.wav', 'local')
    TranscriptionModel.setState(job.id, 'done')

    const result = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_CANCEL, job.id)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/done/)
    expect(TranscriptionModel.getJob(job.id, DEFAULT_TENANT_ID)?.state).toBe('done')
  })

  // ── Input validation at the trust boundary ─────────────────────

  it('weist eine unbekannte Schutzstufe zurueck, statt sie zu deuten', async () => {
    const audio = writeAudio('a.wav')

    // 'CRITICAL' is not a level: the policy core treats an unknown level as
    // "no rule applies" and permits every target (measured, see
    // audio-residency.ts). It must not get that far.
    const rejected = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', audio, 'CRITICAL')

    expect(rejected.success).toBe(false)
    expect(rejected.error).toMatch(/Schutzstufe/)
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)
    expect(TranscriptionModel.listByState('failed', DEFAULT_TENANT_ID)).toHaveLength(0)

    // Positive control: the lower-case level the type allows goes through.
    const accepted = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', audio, 'critical')
    expect(accepted.success).toBe(true)
  })

  // ── The path is renderer input, not a trusted file name ────────
  //
  // Mingly renders LLM answers, RAG documents and MCP content, so the renderer
  // is the less trusted side. A submitted path that is not confined would let
  // anything that reaches it have any audio or video file on the machine
  // transcribed - and the transcript handed back over the segments channel.
  // The spool copy would carry it past the path confinement the service
  // enforces, because the service only ever sees the spool path.
  //
  // The same mistake was made once in this app and fixed after an audit; the
  // rule lives in content-handlers.ts for READ_FILE (audit 2026-08-21).

  it('verweigert eine Aufnahme ausserhalb der freigegebenen Verzeichnisse', async () => {
    const outside = writeOutside('fremde-aufnahme.wav')

    const refused = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', outside)

    expect(refused.success).toBe(false)
    // Nothing was queued and nothing copied: the refusal happens before the
    // runner ever sees the path.
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)
    expect(TranscriptionModel.listByState('failed', DEFAULT_TENANT_ID)).toHaveLength(0)

    // Positive control in the same run: the identical call for a recording
    // inside the granted directory IS queued, so the refusal above is the
    // confinement and not a handler that refuses everything.
    const inside = writeAudio('eigene-aufnahme.wav')
    const accepted = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', inside)

    expect(accepted.success).toBe(true)
    expect(accepted.job?.state).toBe('queued')
  })

  it('verweigert einen Pfad mit ../', async () => {
    const target = writeOutside('heimlich.wav')
    // Spelled out, NOT through path.join: join normalises the '..' away, and
    // then this would test the confinement check again instead of the
    // traversal check. An attacker sends the unnormalised string.
    const traversal = `${grantedDir}/../../${path.basename(target)}`

    const refused = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', traversal)

    expect(refused.success).toBe(false)
    expect(traversal).toContain('../')
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)
  })

  it('verweigert einen Symlink im freigegebenen Verzeichnis, der hinausfuehrt', async () => {
    // The case the resolution exists for: the submitted path passes every
    // string check, and the file it names is somewhere else entirely.
    const target = writeOutside('vertraulich.wav')
    const link = path.join(grantedDir, 'sieht-harmlos-aus.wav')
    fs.symlinkSync(target, link)

    const refused = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', link)

    expect(refused.success).toBe(false)
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)

    fs.unlinkSync(link)
  })

  it('verweigert eine Datei, die keine Audio- oder Videodatei ist', async () => {
    const notAudio = writeAudio('schluessel.txt')

    const refused = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', notAudio)

    expect(refused.success).toBe(false)
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)
  })

  // ── Ruling 35: nicht jede Freigabe ist eine Quelle ─────────────
  //
  // Eine Allowlist ist nur so stark wie der schwaechste Weg, auf dem ein
  // Eintrag hineinkommt. FILE_ACCESS_ADD_NETWORK_SHARE nimmt die Konfiguration
  // ungeprueft vom Renderer und `addNetworkShare` macht daraus eine Freigabe
  // mit `recursive: true` - ohne Dialog, ohne Bestaetigung, ohne Pruefung, ob
  // der Pfad ueberhaupt ein Mountpoint ist. Der Renderer kann sich damit
  // selbst `/` freigeben.

  it('nimmt ein Netzlaufwerk nicht als Aufnahmequelle an, obwohl es freigegeben ist', async () => {
    const onShare = writeAudioIn(networkShareDir, 'vom-netzlaufwerk.wav')

    const refused = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', onShare)

    expect(refused.success).toBe(false)
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)

    // Positivkontrolle im selben Lauf: die per Dialog freigegebene Quelle
    // bleibt eine Quelle - die Verweigerung oben ist die Herkunft, nicht ein
    // Handler, der alles ablehnt.
    const fromDialog = writeAudio('aus-dem-dialog.wav')
    const accepted = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', fromDialog)

    expect(accepted.success).toBe(true)
    expect(accepted.job?.state).toBe('queued')
  })

  it('nimmt ein nur zum Schreiben freigegebenes Verzeichnis nicht als Quelle an', async () => {
    const inCreateOnly = writeAudioIn(createOnlyDir, 'nur-schreiben.wav')

    const refused = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', inCreateOnly)

    expect(refused.success).toBe(false)
    expect(TranscriptionModel.listByState('queued', DEFAULT_TENANT_ID)).toHaveLength(0)

    // Positivkontrolle: dieselbe Datei in einem Lese-Verzeichnis geht durch.
    const readable = writeAudio('lesbar.wav')
    expect((await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', readable)).success).toBe(true)
  })

  it('nennt in der Verweigerung weder den Pfad noch die gescheiterte Pruefung', async () => {
    const outside = writeOutside('streng-geheim.wav')
    const notAudio = writeAudio('auch-geheim.txt')

    const outsideRefusal = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', outside)
    const extensionRefusal = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', notAudio)

    // Two different checks, one message: otherwise the refusal answers "does
    // this path exist" and "which rule did I hit".
    expect(outsideRefusal.error).toBe(extensionRefusal.error)
    expect(outsideRefusal.error).not.toContain('streng-geheim')
    expect(outsideRefusal.error).not.toContain(tmpDir)
    expect(extensionRefusal.error).not.toContain('auch-geheim')
    expect(extensionRefusal.error).not.toContain(grantedDir)
  })

  it('nimmt einen Job ohne erklaerte Schutzstufe an und behandelt ihn streng', async () => {
    const audio = writeAudio('a.wav')

    const result = await invoke<JobResult>(IPC_CHANNELS.TRANSCRIPTION_SUBMIT, 'ws1', audio)

    expect(result.success).toBe(true)
    // 'local' is the on-device target: the strict side, not a remote one.
    expect(result.job?.targetId).toBe('local')
  })

  // ── Ruling 22: the API key reaches the service ──────────────────

  it('schickt den Schluessel aus TRANSCRIPTION_API_KEY an den Dienst', async () => {
    const service = await startFakeService()
    const client = getTranscriptionHttpClient()
    client.updateConfig({ host: '127.0.0.1', port: service.port, protocol: 'http' })

    vi.stubEnv('TRANSCRIPTION_API_KEY', 'schluessel-4711')
    applyTranscriptionApiKey(resolveTranscriptionApiKey())
    await client.submit('/spool/a.wav')

    expect(service.requests[0].authorization).toBe('Bearer schluessel-4711')

    // Negative control in the same run: without the variable no header is
    // sent AND the request still happened, so the assertion above cannot pass
    // on an unsent request.
    vi.stubEnv('TRANSCRIPTION_API_KEY', '')
    applyTranscriptionApiKey(resolveTranscriptionApiKey())
    await client.submit('/spool/b.wav')

    expect(service.requests).toHaveLength(2)
    expect(service.requests[1].authorization).toBeUndefined()
  })

  it('setzt den Schluessel vor jedem Durchlauf des Zeitgebers', async () => {
    vi.useFakeTimers()
    const updateConfig = vi.spyOn(getTranscriptionHttpClient(), 'updateConfig')
    vi.stubEnv('TRANSCRIPTION_API_KEY', 'schluessel-vor-dem-durchlauf')
    const runner = {
      resumeInterrupted: () => Promise.resolve(),
      tick: () => Promise.resolve()
    }

    startTranscriptionScheduler({ intervalMs: 10, runner })
    await vi.advanceTimersByTimeAsync(1)

    expect(updateConfig).toHaveBeenCalledWith({ apiKey: 'schluessel-vor-dem-durchlauf' })
  })

  // ── Ruling 31: the next pass is scheduled after the previous one ──

  it('plant den naechsten Durchlauf erst nach dem vorigen, statt sie aufzustauen', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const ticks: number[] = []
    const runner = {
      resumeInterrupted: () => Promise.resolve(),
      tick: (): Promise<void> => {
        ticks.push(ticks.length)
        return new Promise<void>((resolve) => {
          release = resolve
        })
      }
    }

    startTranscriptionScheduler({ intervalMs: 10, runner })
    // 100 interval periods: a setInterval would have started a hundred passes
    // behind the one that has not finished.
    await vi.advanceTimersByTimeAsync(1000)

    expect(ticks).toHaveLength(1)

    // Positive control: once the pass finishes, the next one happens - the
    // count above is a queue of one, not a dead scheduler.
    release()
    await vi.advanceTimersByTimeAsync(20)

    expect(ticks).toHaveLength(2)
  })

  it('nimmt beim Start unterbrochene Jobs wieder auf', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const runner = {
      resumeInterrupted: (): Promise<void> => {
        calls.push('resume')
        return Promise.resolve()
      },
      tick: (): Promise<void> => {
        calls.push('tick')
        return Promise.resolve()
      }
    }

    startTranscriptionScheduler({ intervalMs: 10, runner })
    await vi.advanceTimersByTimeAsync(1)

    // Resumption BEFORE the first ordinary pass: a job left running by the
    // previous process has to be back in the queue before anything observes it.
    expect(calls).toEqual(['resume', 'tick'])

    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual(['resume', 'tick', 'tick'])
  })

  it('hoert nach stopTranscriptionScheduler auf', async () => {
    vi.useFakeTimers()
    let ticks = 0
    const runner = {
      resumeInterrupted: () => Promise.resolve(),
      tick: (): Promise<void> => {
        ticks += 1
        return Promise.resolve()
      }
    }

    startTranscriptionScheduler({ intervalMs: 10, runner })
    await vi.advanceTimersByTimeAsync(25)
    const before = ticks
    expect(before).toBeGreaterThan(1)

    stopTranscriptionScheduler()
    await vi.advanceTimersByTimeAsync(100)

    expect(ticks).toBe(before)
  })
})
