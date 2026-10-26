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

import { IPC_CHANNELS } from '../../shared/types'
import { DEFAULT_TENANT_ID } from '../database/index'
import { TranscriptionModel } from '../database/models/transcription'
import type {
  TranscriptionJob,
  TranscriptionJobState,
  TranscriptionSegment
} from '../database/models/transcription'
import { getTranscriptionJobRunner } from '../transcription/job-runner'
import {
  applyTranscriptionApiKey,
  resolveTranscriptionApiKey
} from '../config/transcription-config'
import { SENSITIVITY_ORDER } from '../policy/policy-types'
import type { PIISensitivity } from '../privacy/pii-types'
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

/**
 * One transcription job as a caller sees it.
 *
 * The stored `error` column is split in two here, because it carries two
 * different things (see decision 2 above): a reason the job FAILED, and a
 * reason a job that has not failed is not moving. Which one is filled follows
 * the state, which is the truth about the job.
 */
export interface TranscriptionJobView {
  id: string
  workspaceId: string
  state: TranscriptionJobState
  /** As the service reports it, 0..1. */
  progress: number
  targetId: string
  /** Why the job failed. Only ever set for state 'failed'. */
  failureReason?: string
  /** Why a job that has NOT failed is not progressing. Never a failure. */
  waitingReason?: string
  createdAt: number
  updatedAt: number
}

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
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    state: job.state,
    progress: job.progress,
    targetId: job.targetId,
    failureReason: failed ? job.error : undefined,
    waitingReason: failed || job.error === undefined ? undefined : withoutWaitPrefix(job.error),
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
      const audio = requireNonEmptyString(audioPath, 'Kein Pfad zur Aufnahme uebergeben')
      const level = requireDeclaredLevel(declaredLevel)

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
let schedulerRunning = false

/**
 * Start working the queue: resume what the last process left running, then one
 * pass every `intervalMs` after the previous one finished.
 *
 * Calling it while it already runs does nothing, so wiring it up twice cannot
 * double the rate.
 */
export function startTranscriptionScheduler(options: TranscriptionSchedulerOptions = {}): void {
  if (schedulerRunning) return
  schedulerRunning = true

  const intervalMs = options.intervalMs ?? DEFAULT_PASS_INTERVAL_MS
  const runner = options.runner ?? getTranscriptionJobRunner()
  void runPass(runner, intervalMs, true)
}

/**
 * Stop scheduling passes. A pass already in flight finishes - interrupting it
 * halfway is what leaves jobs stranded - and schedules no successor.
 */
export function stopTranscriptionScheduler(): void {
  schedulerRunning = false
  if (passTimer !== null) {
    clearTimeout(passTimer)
    passTimer = null
  }
}

async function runPass(
  runner: TranscriptionPassRunner,
  intervalMs: number,
  resumeFirst: boolean
): Promise<void> {
  try {
    // Before every pass, not once at startup: the key is read from the
    // environment at the moment of use (see config/transcription-config.ts),
    // so a key added to the .env file after start is picked up by the next
    // pass instead of at the next restart.
    applyTranscriptionApiKey(resolveTranscriptionApiKey())

    // Resumption before the first ordinary pass: a job the previous process
    // left in state 'running' has to be back in the queue before anything
    // tries to observe it, because the handle to it died with that process.
    if (resumeFirst) await runner.resumeInterrupted()
    await runner.tick()
  } catch (error) {
    // A failed pass must not stop the clock: the next one may well work, and
    // the jobs stay in the table either way.
    logger.warn('Transcription pass failed', { error: String(error) })
  }

  if (!schedulerRunning) return
  passTimer = setTimeout(() => {
    void runPass(runner, intervalMs, false)
  }, intervalMs)
}
