/**
 * Transcription job runner: the queue, the state machine and the audit trail.
 *
 * Three things here are decisions, not details:
 *
 * 1. **No limit on a job, only on a standstill.** Transcribing an hour of
 *    audio legitimately takes tens of minutes (measured: 40 minutes on CPU for
 *    one session hour). A wall clock would kill such a job after it had already
 *    done the work, so the only clock this runner keeps is the one since
 *    PROGRESS last moved.
 * 2. **An unreachable service is not a failed job.** A job stays `queued` when
 *    it could not be handed over, and stays `running` when it could not be
 *    observed - re-submitting a running job would transcribe the same audio a
 *    second time. Only a service that ANSWERS and says no fails a job.
 * 3. **The audio is copied into the service's spool directory first.** The
 *    service accepts paths inside that directory and nothing else (there is
 *    deliberately no upload endpoint), so the copy is this side's job.
 *
 * The runner has no timer of its own: `tick()` is one pass and the caller
 * decides how often it happens. That keeps the whole state machine testable
 * without waiting.
 */

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import type { Stats } from 'fs'
import path from 'path'
import { DEFAULT_TENANT_ID } from '../database/index'
import { TranscriptionModel } from '../database/models/transcription'
import type { TranscriptionJob, TranscriptionJobState } from '../database/models/transcription'
import { getActivityLogger } from '../audit/activity-logger'
import { DEFAULT_POLICY } from '../policy/policy-engine'
import type { PolicySet } from '../policy/policy-types'
import type { PIISensitivity } from '../privacy/pii-types'
import { resolveTarget } from './audio-residency'
import {
  getTranscriptionHttpClient,
  TranscriptionServiceError,
  TranscriptionServiceUnreachableError
} from './transcription-http-client'
import type { TranscriptionJobStatus } from './transcription-http-client'

/** The part of the HTTP client this runner uses; injectable for tests. */
export interface TranscriptionJobClient {
  submit(audioPath: string, numSpeakers?: number): Promise<{ jobId: string }>
  poll(jobId: string): Promise<TranscriptionJobStatus>
}

export interface TranscriptionJobRunnerOptions {
  /**
   * Tenants this runner sweeps. Stage 1 is one tenant per installation, hence
   * the default. A job may only be enqueued for a tenant in this list: one
   * that is swept by nobody would sit in the queue unnoticed for ever.
   */
  tenantIds?: readonly string[]
  policy?: PolicySet
  client?: TranscriptionJobClient
  /** Overrides TRANSCRIPTION_SPOOL_DIR; the service reads the same variable. */
  spoolDir?: string
  /** Target ids an endpoint is configured for. */
  executableTargets?: readonly string[]
  /** How long progress may stand still before the job is given up. */
  progressStallTimeoutMs?: number
}

/**
 * Target ids this runner can actually hand a job to. Only the on-device
 * service exists in stage 1; a remote target stays a policy option without an
 * endpoint until someone configures one (Ruling 19), and an unconfigured
 * target is a refusal, never a quiet local run.
 */
const EXECUTABLE_TARGETS: readonly string[] = ['local']

/**
 * `target_id` of a job that never got one, because no target was permitted.
 * The row still exists so the refusal is visible and auditable; a sentinel
 * keeps the column honest instead of naming a target that was never used.
 */
const NO_TARGET = 'none'

/**
 * Default standstill window. It has to exceed the longest SINGLE stage of the
 * service's pipeline, not the whole job: the service reports progress at five
 * points (audio loaded, transcribed, aligned, diarised, done) and
 * transcription is by far the longest of them. Two hours covers a recording of
 * several hours on CPU; a deployment that transcribes longer recordings raises
 * it through the option.
 */
const DEFAULT_PROGRESS_STALL_TIMEOUT_MS = 2 * 60 * 60 * 1000

const HTTP_NOT_FOUND = 404
const HTTP_SERVICE_UNAVAILABLE = 503

const AUDIT_ACTOR_ID = 'transcription-job-runner'
const AUDIT_ENTITY_TYPE = 'transcription_job'

/** What one job's turn in `tick` ended with. */
type StepOutcome = 'handled' | 'service-unavailable'

/**
 * What this process knows about a job it handed to the service. It is NOT
 * persisted on purpose: the service keeps its own queue in memory and loses it
 * on restart, so a service job id that outlived our process would be a handle
 * to nothing. `resumeInterrupted` puts such jobs back into the queue instead.
 */
interface TrackedJob {
  serviceJobId: string
  lastProgress: number
  /** When `lastProgress` last changed - the only clock a job is given up by. */
  lastProgressAt: number
}

export class TranscriptionJobRunner {
  private readonly tenantIds: readonly string[]
  private readonly policy: PolicySet
  private readonly client: TranscriptionJobClient
  private readonly spoolDirOption?: string
  private readonly executableTargets: readonly string[]
  private readonly progressStallTimeoutMs: number

  private readonly tracked = new Map<string, TrackedJob>()

  /**
   * Declared level per job, for the audit entry of every state change.
   * `transcription_jobs` has no column for it, so for a job from an earlier
   * process the level is genuinely unknown and the entry says `null` rather
   * than inventing one.
   */
  private readonly declaredLevels = new Map<string, PIISensitivity>()

  constructor(options: TranscriptionJobRunnerOptions = {}) {
    this.tenantIds = options.tenantIds ?? [DEFAULT_TENANT_ID]
    this.policy = options.policy ?? DEFAULT_POLICY
    this.client = options.client ?? getTranscriptionHttpClient()
    this.spoolDirOption = options.spoolDir
    this.executableTargets = options.executableTargets ?? EXECUTABLE_TARGETS
    this.progressStallTimeoutMs =
      options.progressStallTimeoutMs ?? DEFAULT_PROGRESS_STALL_TIMEOUT_MS
  }

  /**
   * Queue one recording: decide the target, check the file, copy it into the
   * spool directory and record the job.
   *
   * Every way this can go wrong produces a job in state `failed` carrying the
   * reason, not a thrown error - a refusal nobody sees would be the quiet
   * deviation from a policy decision that this feature exists to prevent. The
   * one exception is a tenant this runner does not serve: that is a
   * configuration error of the caller, and it is raised before a row exists.
   */
  async enqueue(
    tenantId: string,
    workspaceId: string,
    audioPath: string,
    declaredLevel?: PIISensitivity
  ): Promise<TranscriptionJob> {
    if (!this.tenantIds.includes(tenantId)) {
      throw new Error(
        `TranscriptionJobRunner serves tenants [${this.tenantIds.join(', ')}] ` +
          `and cannot enqueue a job for "${tenantId}"`
      )
    }

    const resolution = resolveTarget(declaredLevel, this.policy)
    if (!resolution.allowed) {
      return this.refuse(tenantId, workspaceId, audioPath, NO_TARGET, declaredLevel, resolution.reason)
    }

    const targetId = resolution.targetId
    if (!this.executableTargets.includes(targetId)) {
      return this.refuse(
        tenantId, workspaceId, audioPath, targetId, declaredLevel,
        this.describeUnconfiguredTarget(targetId)
      )
    }

    const audioProblem = await describeUnusableAudio(audioPath)
    if (audioProblem !== undefined) {
      return this.refuse(tenantId, workspaceId, audioPath, targetId, declaredLevel, audioProblem)
    }

    let spooledPath: string
    try {
      spooledPath = await this.copyIntoSpool(audioPath)
    } catch (error) {
      return this.refuse(
        tenantId, workspaceId, audioPath, targetId, declaredLevel,
        `Die Aufnahme konnte nicht in das Spool-Verzeichnis kopiert werden: ${describeError(error)}`
      )
    }

    // The job carries the COPY, not the original: the original may be gone by
    // the time the job runs, and the service only accepts the copy's location.
    const job = TranscriptionModel.createJob(tenantId, workspaceId, spooledPath, targetId)
    if (declaredLevel !== undefined) this.declaredLevels.set(job.id, declaredLevel)
    this.audit(job, 'queued')
    return job
  }

  /**
   * One pass: observe the jobs that are running, then hand over the ones that
   * are queued. Running first, so a job that has to go back into the queue (a
   * service that forgot it) is submitted again in the same pass.
   *
   * A pass stops as soon as the service turns out to be unavailable. Every
   * remaining job would hit the same wall, and each attempt costs a request
   * timeout.
   */
  async tick(): Promise<void> {
    for (const tenantId of this.tenantIds) {
      for (const job of TranscriptionModel.listByState('running', tenantId)) {
        if ((await this.observe(job)) === 'service-unavailable') return
      }
      for (const job of TranscriptionModel.listByState('queued', tenantId)) {
        if ((await this.start(job)) === 'service-unavailable') return
      }
    }
  }

  /**
   * Put every job that was `running` when the process stopped back into the
   * queue. The service holds its queue in memory and lost it as well, so
   * submitting again is the only way such a job ever finishes - and the
   * alternative, leaving it `running`, would strand it for ever.
   */
  async resumeInterrupted(): Promise<void> {
    for (const tenantId of this.tenantIds) {
      for (const job of TranscriptionModel.listByState('running', tenantId)) {
        this.requeue(job)
      }
    }
  }

  // ── One job's turn ─────────────────────────────────────────────

  private async start(job: TranscriptionJob): Promise<StepOutcome> {
    // Re-checked here and not only in `enqueue`: a job can outlive the
    // configuration it was queued under.
    if (!this.executableTargets.includes(job.targetId)) {
      this.fail(job, this.describeUnconfiguredTarget(job.targetId))
      return 'handled'
    }

    let submitted: { jobId: string }
    try {
      submitted = await this.client.submit(job.audioPath)
    } catch (error) {
      if (error instanceof TranscriptionServiceUnreachableError) {
        // Nothing was handed over, nothing is lost: the job stays queued.
        return 'service-unavailable'
      }
      if (error instanceof TranscriptionServiceError) {
        // 503 means the models are not loaded yet. The service is there and
        // will take the job later, so this is not a failure of the job.
        if (error.status === HTTP_SERVICE_UNAVAILABLE) return 'service-unavailable'
        // Any other answer is a refusal of this request, and repeating the
        // same request will not change it.
        this.fail(job, error.message)
        return 'handled'
      }
      // Neither named class: a programming or configuration error (the client
      // raises a plain Error for an unusable API key). It must surface, not be
      // recorded as "the service said no".
      throw error
    }

    this.tracked.set(job.id, {
      serviceJobId: submitted.jobId,
      lastProgress: job.progress,
      lastProgressAt: Date.now()
    })
    TranscriptionModel.setState(job.id, 'running')
    this.audit(job, 'running')
    return 'handled'
  }

  private async observe(job: TranscriptionJob): Promise<StepOutcome> {
    const tracked = this.tracked.get(job.id)
    if (tracked === undefined) {
      // `running` in the table, but this process holds no service job id for
      // it. Polling is impossible, so the job goes back into the queue.
      this.requeue(job)
      return 'handled'
    }

    let status: TranscriptionJobStatus
    try {
      status = await this.client.poll(tracked.serviceJobId)
    } catch (error) {
      if (error instanceof TranscriptionServiceUnreachableError) {
        // Keep polling, do NOT submit again: the job is most likely still
        // running on the service, and a second submission would transcribe
        // the same audio twice.
        return 'service-unavailable'
      }
      if (error instanceof TranscriptionServiceError) {
        if (error.status === HTTP_NOT_FOUND) {
          // The service restarted and lost its in-memory queue. NOW submitting
          // again is right - and only now.
          this.requeue(job)
          return 'handled'
        }
        if (error.status === HTTP_SERVICE_UNAVAILABLE) return 'service-unavailable'
        this.fail(job, error.message)
        return 'handled'
      }
      throw error
    }

    if (status.progress !== tracked.lastProgress) {
      tracked.lastProgress = status.progress
      tracked.lastProgressAt = Date.now()
      // Stored as the service reports it (0..1), never rescaled.
      TranscriptionModel.setProgress(job.id, status.progress)
    }

    switch (status.state) {
      case 'done':
        TranscriptionModel.saveSegments(job.id, status.segments)
        TranscriptionModel.setState(job.id, 'done')
        this.audit(job, 'done')
        this.forget(job.id)
        return 'handled'

      case 'failed':
        this.fail(
          job,
          status.error ??
            'Der Transkriptionsdienst hat den Job ohne Begruendung als gescheitert gemeldet'
        )
        return 'handled'

      case 'queued':
        // Waiting in the service's queue is not a standstill: its single
        // worker may be busy with another job. Hold the clock at now.
        tracked.lastProgressAt = Date.now()
        return 'handled'

      case 'running':
        return this.giveUpOnStandstill(job, tracked)
    }
  }

  private giveUpOnStandstill(job: TranscriptionJob, tracked: TrackedJob): StepOutcome {
    const standstillMs = Date.now() - tracked.lastProgressAt
    if (standstillMs > this.progressStallTimeoutMs) {
      this.fail(
        job,
        `Der Transkriptionsdienst meldet seit ${Math.round(standstillMs / 60_000)} Minuten ` +
          'keinen Fortschritt mehr; der Job wurde aufgegeben.'
      )
    }
    return 'handled'
  }

  // ── State changes ──────────────────────────────────────────────

  /**
   * Record a job that cannot run, with the reason in its error field. The row
   * goes through `queued` because that is what `createJob` writes and what the
   * table therefore held, so both transitions are audited.
   */
  private refuse(
    tenantId: string,
    workspaceId: string,
    audioPath: string,
    targetId: string,
    declaredLevel: PIISensitivity | undefined,
    reason: string
  ): TranscriptionJob {
    const job = TranscriptionModel.createJob(tenantId, workspaceId, audioPath, targetId)
    if (declaredLevel !== undefined) this.declaredLevels.set(job.id, declaredLevel)
    this.audit(job, 'queued')
    this.fail(job, reason)
    // `updatedAt` is restated rather than carried over from `createJob`: the row
    // WAS touched again, and the model does not hand the written row back.
    return { ...job, state: 'failed', error: reason, updatedAt: Date.now() }
  }

  private fail(job: TranscriptionJob, reason: string): void {
    TranscriptionModel.setState(job.id, 'failed', reason)
    this.audit(job, 'failed')
    this.forget(job.id)
  }

  private requeue(job: TranscriptionJob): void {
    this.tracked.delete(job.id)
    // Without an error argument any earlier message is cleared - the job is
    // waiting again, not failed.
    TranscriptionModel.setState(job.id, 'queued')
    this.audit(job, 'queued')
  }

  private forget(jobId: string): void {
    this.tracked.delete(jobId)
    this.declaredLevels.delete(jobId)
  }

  // ── Audit ──────────────────────────────────────────────────────

  /**
   * One entry per state change, through the shared activity logger.
   *
   * It carries tenant, workspace, declared level, chosen target and policy
   * version - and never a segment, a text or a transcript. The log is the
   * document a customer hands to a supervisory authority; content in it would
   * be the data protection problem rather than its proof. The tenant goes in
   * explicitly, not by column default: a later multi-tenant stage cannot
   * reconstruct it afterwards.
   */
  private audit(job: TranscriptionJob, state: TranscriptionJobState): void {
    getActivityLogger().log({
      actorType: 'system',
      actorId: AUDIT_ACTOR_ID,
      action: `transcription.${state}`,
      entityType: AUDIT_ENTITY_TYPE,
      entityId: job.id,
      tenantId: job.tenantId,
      details: {
        workspaceId: job.workspaceId,
        declaredLevel: this.declaredLevels.get(job.id) ?? null,
        targetId: job.targetId,
        policyVersion: this.policy.version
      }
    })
  }

  // ── Spool directory ───────────────────────────────────────────

  /**
   * Resolved on every use, not stored in the constructor: the environment is
   * the same source the service reads, and it can be set after this runner
   * exists.
   */
  private get spoolDir(): string {
    const configured = this.spoolDirOption ?? process.env.TRANSCRIPTION_SPOOL_DIR
    if (configured === undefined || configured === '') {
      throw new Error(
        'kein Spool-Verzeichnis konfiguriert (TRANSCRIPTION_SPOOL_DIR). Der ' +
          'Transkriptionsdienst nimmt Audio ausschliesslich aus diesem Verzeichnis an, ' +
          'und Mingly muss dieselbe Variable sehen wie der Dienst'
      )
    }
    return configured
  }

  private async copyIntoSpool(audioPath: string): Promise<string> {
    const spoolDir = this.spoolDir
    await fs.mkdir(spoolDir, { recursive: true })
    // A generated name, not the original one: two recordings called
    // "aufnahme.wav" must not overwrite each other in a shared directory.
    const target = path.join(spoolDir, `${randomUUID()}${safeExtension(audioPath)}`)
    await fs.copyFile(audioPath, target)
    return target
  }

  private describeUnconfiguredTarget(targetId: string): string {
    return (
      `Das von Policy ${this.policy.version} erlaubte Transkriptionsziel "${targetId}" ist ` +
      'nicht konfiguriert - es gibt keinen Endpunkt dafuer. Die Aufnahme wird nicht ' +
      'ersatzweise an einem anderen Ziel transkribiert.'
    )
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Why the file cannot be transcribed, or `undefined` when it can be. Checked
 * before anything is queued, so an empty or vanished recording fails with a
 * clear message instead of occupying the queue.
 */
async function describeUnusableAudio(audioPath: string): Promise<string | undefined> {
  let stats: Stats
  try {
    stats = await fs.stat(audioPath)
  } catch {
    return `Audiodatei nicht gefunden: ${audioPath}`
  }

  if (!stats.isFile()) return `Der Pfad ist keine Datei: ${audioPath}`
  if (stats.size === 0) return `Die Audiodatei ist leer (0 Bytes): ${audioPath}`
  return undefined
}

/**
 * The recording's extension, kept so the service can tell the container
 * format - and only when it is a plain one. Anything else is dropped rather
 * than pasted into a path we build ourselves.
 */
function safeExtension(audioPath: string): string {
  const extension = path.extname(audioPath)
  return /^\.[A-Za-z0-9]{1,8}$/.test(extension) ? extension.toLowerCase() : ''
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
