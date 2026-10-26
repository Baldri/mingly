/**
 * IPC Handlers — Transcription (submit, status, segments, cancel)
 *
 * This is where the transcription feature becomes reachable: before it, the
 * job runner had no caller, the HTTP client had no key and nothing ran a pass.
 * Three decisions here are deliberate rather than incidental:
 *
 * 1. **The tenant is resolved on this side, never taken from the arguments.**
 *    The model's read methods filter by tenant, so a tenant id passed in by
 *    the caller would be an open door with a lock on it.
 * 2. **The stored `error` field never crosses the boundary as it is.** The job
 *    runner also writes WAIT reasons there (see models/transcription.ts), so a
 *    renderer that read "error is set" as "failed" would show a waiting job as
 *    a failed one. The state decides which of the two view fields is filled.
 * 3. **The next pass is scheduled when the previous one has finished**, with
 *    `setTimeout` and not `setInterval`: passes are serialised rather than
 *    dropped (a resumption arriving mid-pass must not be swallowed) and the
 *    queue of waiting passes is not capped, so a fixed interval shorter than a
 *    pass would pile passes up without bound.
 */

import fs from 'fs/promises'
import { extname } from 'path'
import { IPC_CHANNELS, TRANSCRIPTION_WAITING_STATES } from '../../shared/types'
import type { TranscriptionJobView } from '../../shared/types'
import { DEFAULT_TENANT_ID } from '../database/index'
import { TranscriptionModel } from '../database/models/transcription'
import type { TranscriptionJob, TranscriptionSegment } from '../database/models/transcription'
import { getTranscriptionJobRunner } from '../transcription/job-runner'
import {
  applyTranscriptionApiKey,
  resolveTranscriptionApiKey
} from '../config/transcription-config'
import { SENSITIVITY_ORDER } from '../policy/policy-types'
import type { PIISensitivity } from '../privacy/pii-types'
import { validateFilePath } from '../security/input-validator'
import { getFileAccessManager } from '../file-access/file-access-manager'
import { isPathWithinAllowedDirs } from '../../shared/file-access-types'
import type { FileAccessPermission, FileLocation } from '../../shared/file-access-types'
import { wrapHandler, requireFeature } from './ipc-utils'
import { createLogger } from '../../shared/logger'

const logger = createLogger('TranscriptionIPC')

/** The gated feature these channels sit behind. */
const FEATURE = 'transcription'

/**
 * Same message whether the job belongs to another tenant or does not exist.
 * Telling the two apart would answer "does this id exist somewhere else",
 * which is not a question this surface should answer.
 */
const NOT_FOUND = 'Transkriptionsauftrag nicht gefunden'

/** The prefix the job runner puts in front of a reason that is NOT a failure. */
const WAIT_REASON_PREFIX = 'Wartet: '

/** The declared protection levels, from the one place that ranks them. */
const PROTECTION_LEVELS = Object.keys(SENSITIVITY_ORDER)

// The payload type lives in src/shared/types.ts with the channel names, so a
// preload or renderer can import it without reaching into src/main. Re-exported
// because this module is where it is produced.
export type { TranscriptionJobView }

interface JobReply {
  success: true
  job: TranscriptionJobView
}

interface SegmentsReply {
  success: true
  segments: TranscriptionSegment[]
}

/**
 * The tenant these handlers read and write for.
 *
 * Stage 1 is one tenant per installation (design 10.2). When an installation
 * carries several, this function is the single place that has to learn who is
 * asking - and the only place, which is the point of it existing at all.
 */
function callerTenantId(): string {
  return DEFAULT_TENANT_ID
}

function requireNonEmptyString(value: unknown, missing: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(missing)
  return value
}

/**
 * The declared protection level, or `undefined` when none was given.
 *
 * An unknown value is REFUSED rather than interpreted. The policy core treats
 * a level outside its union as "no rule applies" and permits every candidate
 * - 'CRITICAL' in capitals is enough (measured, see audio-residency.ts). That
 * value is caught downstream as well, where it falls to the strict side, but
 * a caller that sends nonsense should be told so instead of silently getting
 * the strictest level it did not ask for.
 */
function requireDeclaredLevel(value: unknown): PIISensitivity | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !PROTECTION_LEVELS.includes(value)) {
    throw new Error(`Unbekannte Schutzstufe. Erlaubt sind: ${PROTECTION_LEVELS.join(', ')}.`)
  }
  return value as PIISensitivity
}

/**
 * ONE refusal for every reason a submitted recording is not acceptable.
 *
 * Four different messages would make the channel a probe: it would answer
 * "does this path exist", "is it inside a granted directory" and "which rule
 * did I hit" to a caller that is allowed to know none of it. The reason goes
 * into the main-process log instead - the same discipline the Python service
 * arrived at for its 400s.
 */
const RECORDING_REFUSED =
  'Diese Aufnahme kann nicht transkribiert werden. Erlaubt sind Audio- und ' +
  'Videodateien aus einem Verzeichnis, fuer das Mingly Zugriff hat.'

/**
 * Containers the transcription service can decode (ffmpeg/whisperx). An
 * allowlist, because the question at a boundary is what IS permitted - and it
 * belongs here, not only in the runner's spool-name sanitising, which decides
 * a file name rather than whether the job may exist.
 */
const ALLOWED_RECORDING_EXTENSIONS: readonly string[] = [
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma',
  '.aiff', '.aif', '.caf', '.amr', '.mka',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.wmv', '.3gp'
]

/**
 * The submitted path, resolved - or a refusal.
 *
 * The renderer is the LESS trusted side in Electron, and Mingly renders LLM
 * answers, RAG documents and MCP content. An unconfined path here would hand
 * anything that reaches the renderer every audio and video file on the
 * machine: the runner copies the recording into the spool directory, so the
 * path confinement the service enforces would be satisfied by the copy, and
 * the transcript would come back over the segments channel.
 *
 * This is the rule READ_FILE already follows (content-handlers.ts, security
 * audit 2026-08-21) - the same mistake was made once in this app - with one
 * step more: the path is RESOLVED before it is compared, so a symlink inside a
 * granted directory pointing somewhere else is refused rather than followed.
 */
async function requireAllowedRecording(submittedPath: string): Promise<string> {
  const refuse = (reason: string): never => {
    logger.warn('Transcription submit refused', { reason, submittedPath })
    throw new Error(RECORDING_REFUSED)
  }

  const validation = validateFilePath(submittedPath)
  if (!validation.valid) return refuse(validation.error ?? 'invalid path')

  let resolved: string
  try {
    resolved = await fs.realpath(submittedPath)
  } catch (error) {
    // A path that cannot be resolved cannot be confined either, so it is
    // refused rather than passed on: the alternative is deciding about a file
    // whose identity we do not know.
    return refuse(`cannot be resolved: ${String(error)}`)
  }

  if (!ALLOWED_RECORDING_EXTENSIONS.includes(extname(resolved).toLowerCase())) {
    return refuse('extension is not an audio or video container')
  }

  const allowedDirs = await resolvedAllowedDirectories()
  if (!isPathWithinAllowedDirs(resolved, allowedDirs)) {
    return refuse('outside every granted directory')
  }

  // The resolved path, not the submitted one: it is the file that was checked.
  //
  // What this approval guarantees, and what it rests on: the file AT THIS
  // MOMENT is inside a granted directory. The runner opens it again by name
  // when it copies it into the spool, so replacing it with a symlink in
  // between would escape the confinement (a time-of-check/time-of-use gap).
  // Nothing in the repo lets the renderer create a symlink, and no IPC channel
  // writes into a granted directory, which is why the gap is not reachable
  // today - but the whole value of the check above depends on that staying
  // true. Closing it properly means handing the runner an open descriptor
  // instead of a path.
  return resolved
}

/**
 * Grant origins that are NOT a recording source, however they got into the
 * allowlist.
 *
 * A network share gets in without a dialog: `FILE_ACCESS_ADD_NETWORK_SHARE`
 * takes its configuration from the renderer, and `addNetworkShare` turns the
 * `mountPoint` it is handed into a recursive grant - no confirmation, and no
 * check that the path is a mount point at all. A renderer can therefore grant
 * itself `/` and walk through any check that trusts the list.
 *
 * An allowlist is only as strong as the weakest way an entry gets into it, so
 * this confinement picks its own trust root instead of accepting a list the
 * side it defends against can fill.
 *
 * Lift the exclusion once `addNetworkShare` requires a confirmation the
 * renderer cannot give itself: transcribing a recording from a network drive
 * is a legitimate thing to want, and only the way the grant is made is wrong.
 */
const UNTRUSTED_GRANT_LOCATIONS: readonly FileLocation[] = ['network-smb', 'network-nfs']

/** The permissions that make a granted directory readable at all. */
const READING_PERMISSIONS: readonly FileAccessPermission[] = ['read', 'read-create']

/**
 * The granted directories that may hold recordings, with their symlinks
 * resolved.
 *
 * Both sides have to be resolved or the comparison is between two spellings of
 * the same place: macOS alone resolves `/tmp` to `/private/tmp` and `/var` to
 * `/private/var`, and a grant for a directory under either would then match
 * nothing. A granted directory that no longer resolves grants nothing.
 */
async function resolvedAllowedDirectories(): Promise<string[]> {
  const resolved: string[] = []
  for (const dir of getFileAccessManager().getAllowedDirectories()) {
    if (UNTRUSTED_GRANT_LOCATIONS.includes(dir.location)) continue
    // The rule the file access manager itself applies before it reads a file:
    // a directory granted for writing AI output into is not a source to read
    // recordings from.
    if (!dir.permissions.some((permission) => READING_PERMISSIONS.includes(permission))) continue

    try {
      resolved.push(await fs.realpath(dir.path))
    } catch {
      continue
    }
  }
  return resolved
}

/** The caller's own job, or a refusal. */
function requireOwnJob(jobId: unknown): TranscriptionJob {
  const id = requireNonEmptyString(jobId, 'Keine Auftragskennung uebergeben')
  const job = TranscriptionModel.getJob(id, callerTenantId())
  if (job === null) throw new Error(NOT_FOUND)
  return job
}

function withoutWaitPrefix(reason: string): string {
  return reason.startsWith(WAIT_REASON_PREFIX) ? reason.slice(WAIT_REASON_PREFIX.length) : reason
}

function toView(job: TranscriptionJob): TranscriptionJobView {
  const failed = job.state === 'failed'
  // The states a job can still be waiting IN. The other three are over, and a
  // reason left on the row from before - a wait reason that landed just as the
  // job was cancelled, say - must not make a finished job look like it is
  // waiting for something.
  //
  // From src/shared/types.ts, because the job runner decides by the same list:
  // it refuses to write a wait reason onto a row outside that set precisely
  // because this view would not show it. Both sides held the same literal list
  // and a comment tying them together, so a change HERE could silently make the
  // runner refuse the wrong set, with no test failing.
  const waiting = TRANSCRIPTION_WAITING_STATES.includes(job.state)
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    state: job.state,
    progress: job.progress,
    targetId: job.targetId,
    failureReason: failed ? job.error : undefined,
    waitingReason: waiting && job.error !== undefined ? withoutWaitPrefix(job.error) : undefined,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }
}

export function registerTranscriptionHandlers(): void {
  // The gate comes first in every handler: a refusal must happen before the
  // recording is copied into the spool directory, not after.

  wrapHandler(
    IPC_CHANNELS.TRANSCRIPTION_SUBMIT,
    async (workspaceId: unknown, audioPath: unknown, declaredLevel?: unknown): Promise<JobReply> => {
      requireFeature(FEATURE)
      const workspace = requireNonEmptyString(workspaceId, 'Kein Arbeitsbereich uebergeben')
      const submitted = requireNonEmptyString(audioPath, 'Kein Pfad zur Aufnahme uebergeben')
      const level = requireDeclaredLevel(declaredLevel)
      const audio = await requireAllowedRecording(submitted)

      // A refused recording comes back as a job in state 'failed' carrying the
      // reason, so the caller sees the policy decision instead of an exception.
      const job = await getTranscriptionJobRunner().enqueue(callerTenantId(), workspace, audio, level)
      return { success: true, job: toView(job) }
    }
  )

  wrapHandler(IPC_CHANNELS.TRANSCRIPTION_STATUS, (jobId: unknown): JobReply => {
    requireFeature(FEATURE)
    return { success: true, job: toView(requireOwnJob(jobId)) }
  })

  wrapHandler(IPC_CHANNELS.TRANSCRIPTION_SEGMENTS, (jobId: unknown): SegmentsReply => {
    requireFeature(FEATURE)
    const job = requireOwnJob(jobId)
    // Tenant again, although the job was just read for this tenant: the
    // segment query is the one that hands out content.
    return { success: true, segments: TranscriptionModel.getSegments(job.id, callerTenantId()) }
  })

  wrapHandler(IPC_CHANNELS.TRANSCRIPTION_CANCEL, (jobId: unknown): JobReply => {
    requireFeature(FEATURE)
    const id = requireNonEmptyString(jobId, 'Keine Auftragskennung uebergeben')
    const tenantId = callerTenantId()

    const outcome = getTranscriptionJobRunner().cancel(tenantId, id)
    if (!outcome.cancelled) {
      if (outcome.reason === 'not-found') throw new Error(NOT_FOUND)
      throw new Error(`Ein Auftrag im Zustand "${outcome.state}" kann nicht storniert werden`)
    }

    const job = TranscriptionModel.getJob(id, tenantId)
    if (job === null) throw new Error(NOT_FOUND)
    return { success: true, job: toView(job) }
  })
}

// ── The queue's clock ────────────────────────────────────────────

/** The part of the job runner the scheduler drives; injectable for tests. */
export interface TranscriptionPassRunner {
  tick(): Promise<void>
  resumeInterrupted(): Promise<void>
}

export interface TranscriptionSchedulerOptions {
  /** Pause between the END of one pass and the start of the next. */
  intervalMs?: number
  runner?: TranscriptionPassRunner
}

/**
 * Pause between two passes.
 *
 * It is a gap, not a period: the time is counted from the moment a pass
 * finishes. A pass with an empty queue is two indexed SELECTs and no network
 * traffic at all - the service is only contacted for jobs that are running -
 * so five seconds buys a visibly moving progress bar cheaply.
 */
const DEFAULT_PASS_INTERVAL_MS = 5_000

let passTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Which chain of passes owns the clock, or `null` while nothing does.
 *
 * A counter rather than a boolean, because a pass can outlive the stop that
 * ended its chain: stop while a pass sits in `await tick()`, start again, and
 * with a shared flag the old pass finds "running" true again when it returns,
 * schedules its own successor and overwrites the new chain's timer handle.
 * Two live chains then exist and only one of them can be cancelled. Each
 * chain carries its generation and reschedules only while it is still the one
 * that owns the clock.
 */
let owningChain: number | null = null
let lastChain = 0

/**
 * Start working the queue: resume what the last process left running, then one
 * pass every `intervalMs` after the previous one finished.
 *
 * Calling it while it already runs does nothing, so wiring it up twice cannot
 * double the rate.
 */
export function startTranscriptionScheduler(options: TranscriptionSchedulerOptions = {}): void {
  if (owningChain !== null) return
  lastChain += 1
  owningChain = lastChain

  const intervalMs = options.intervalMs ?? DEFAULT_PASS_INTERVAL_MS
  const runner = options.runner ?? getTranscriptionJobRunner()
  void runPass(runner, intervalMs, true, owningChain)
}

/**
 * Stop scheduling passes. A pass already in flight finishes - interrupting it
 * halfway is what leaves jobs stranded - and schedules no successor.
 */
export function stopTranscriptionScheduler(): void {
  owningChain = null
  if (passTimer !== null) {
    clearTimeout(passTimer)
    passTimer = null
  }
}

async function runPass(
  runner: TranscriptionPassRunner,
  intervalMs: number,
  resumeFirst: boolean,
  chain: number
): Promise<void> {
  // Before every pass, not once at startup: the key is read from the
  // environment at the moment of use (see config/transcription-config.ts), so a
  // key set or removed in THIS PROCESS's environment is picked up by the next
  // pass instead of at the next restart. The .env file is not that - it is read
  // once, at module load (src/main/index.ts), so an edit to the FILE needs an
  // app restart.
  //
  // In its own try, and the pass goes ahead when it fails: a key that cannot
  // be sent is a configuration error for the operator to fix, and skipping the
  // pass over it would stop the queue instead of showing the problem.
  //
  // What the job then shows, precisely: the refusal happens BEFORE the client
  // is configured, so the client keeps whatever key it had. In a process that
  // never had a usable one - the reachable case, because the environment is
  // read once at startup and the same value is resolved on every pass - it has
  // none, the request goes unauthenticated, a service with a key configured
  // answers 401, and the runner records that as a visible wait reason on the
  // job. Measured end to end in tests/unit/transcription-handlers.test.ts.
  //
  // Were a usable key already applied and the environment then changed to a
  // malformed one, the old key would stay in use and nothing would be visible
  // on any job. That is what this log line is for.
  try {
    applyTranscriptionApiKey(resolveTranscriptionApiKey())
  } catch (error) {
    logger.error('Transcription API key cannot be used', { error: String(error) })
  }

  try {
    // Resumption before the first ordinary pass: a job the previous process
    // left in state 'running' has to be back in the queue before anything
    // tries to observe it, because the handle to it died with that process.
    if (resumeFirst) await runner.resumeInterrupted()
    await runner.tick()
  } catch (error) {
    // A failed pass must not stop the clock: the next one may well work, and
    // the jobs stay in the table either way. One job's error does not get
    // here - the runner keeps that to the job (see `attempt`).
    logger.warn('Transcription pass failed', { error: String(error) })
  }

  // Only while this chain still owns the clock: a chain that was stopped must
  // not schedule a successor, least of all over the handle of the chain that
  // replaced it.
  if (owningChain !== chain) return
  passTimer = setTimeout(() => {
    void runPass(runner, intervalMs, false, chain)
  }, intervalMs)
}
