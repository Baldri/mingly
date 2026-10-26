/**
 * Transcription job runner: the queue, the state machine and the audit trail.
 *
 * Three things here are decisions, not details:
 *
 * 1. **No limit on a job, only on a standstill - in awake time.** Transcribing
 *    an hour of audio legitimately takes tens of minutes (measured: 40 minutes
 *    on CPU for one session hour). A wall clock would kill such a job after it
 *    had already done the work, so the only clock this runner keeps is the one
 *    since PROGRESS last moved, and it does not run while the machine sleeps
 *    (see MAX_COUNTED_OBSERVATION_GAP_MS).
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
 * without waiting. Passes never run beside each other, whoever starts them -
 * see `inOwnPass`.
 */

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import type { Stats } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { DEFAULT_TENANT_ID } from '../database/index'
import { TranscriptionModel } from '../database/models/transcription'
import type { TranscriptionJob, TranscriptionJobState } from '../database/models/transcription'
import { getActivityLogger } from '../audit/activity-logger'
import { createLogger } from '../../shared/logger'
import { TRANSCRIPTION_WAITING_STATES } from '../../shared/types'
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
 *
 * Exported because it is the only way to tell "no target was permitted" apart
 * from "the permitted target has no endpoint" by looking at the row.
 */
export const NO_TARGET = 'none'

/**
 * Default standstill window, measured in AWAKE time (see
 * MAX_COUNTED_OBSERVATION_GAP_MS). It has to exceed the longest SINGLE stage
 * of the service's pipeline, not the whole job: the service reports progress
 * at five points (audio loaded, transcribed, aligned, diarised, done) and
 * transcription is by far the longest of them. Two hours covers a recording of
 * several hours on CPU; a deployment that transcribes longer recordings raises
 * it through the option.
 */
const DEFAULT_PROGRESS_STALL_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * The longest gap between two observations of the same job that is still
 * counted towards the standstill window in full.
 *
 * This is what makes the window awake time rather than wall-clock time. A
 * laptop that sleeps for eight hours suspends the local transcription service
 * with it; on wake the service reports the same progress it had before, and a
 * wall-clock delta would read that as eight hours of standstill and kill a job
 * that never stopped. Sleep is the normal case for a desktop app, so a gap
 * longer than this one is taken as "this process was not watching" and
 * contributes only this much.
 *
 * It is clamped rather than ignored on purpose: a caller that polls less often
 * than this still accumulates standstill, just more slowly. Ignoring long gaps
 * would switch the detection off silently for such a caller.
 */
const MAX_COUNTED_OBSERVATION_GAP_MS = 5 * 60 * 1000

const HTTP_NOT_FOUND = 404
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_TOO_MANY_REQUESTS = 429

const AUDIT_ACTOR_ID = 'transcription-job-runner'
const AUDIT_ENTITY_TYPE = 'transcription_job'

const logger = createLogger('TranscriptionJobRunner')

interface AuditActor {
  actorType: string
  actorId: string
}

/** Every state change a pass makes is the runner's own. */
const SYSTEM_ACTOR: AuditActor = { actorType: 'system', actorId: AUDIT_ACTOR_ID }

/**
 * A cancellation is somebody's decision, not the runner's. Stage 1 has no user
 * identity, and `local` is what the request guard writes for the same reason -
 * one installation, one person, no id to invent.
 */
const LOCAL_USER_ACTOR: AuditActor = { actorType: 'user', actorId: 'local' }

/**
 * States a job can still be cancelled out of; the other three are over.
 *
 * Deliberately its own list, although it holds the same two states as
 * `TRANSCRIPTION_WAITING_STATES` today. That one answers "may a reason be
 * written onto this row, and will the view show it", and nothing about
 * cancelling follows from the answer: a state that is not over but whose work
 * can no longer be called off - the service has no cancel endpoint, so a
 * later "finalising" would be exactly that - belongs in one list and not the
 * other. Merging them would tie two unrelated decisions together.
 */
const CANCELLABLE_STATES: readonly TranscriptionJobState[] = ['queued', 'running']

/** What `cancel` did, in a form the caller can act on without parsing a message. */
export type TranscriptionCancelOutcome =
  | { cancelled: true }
  | { cancelled: false; reason: 'not-found' }
  | { cancelled: false; reason: 'not-cancellable'; state: TranscriptionJobState }

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
  /**
   * Awake time with unchanged progress, accumulated over the observations -
   * the only measure a job is ever given up by. Reset to zero whenever
   * progress moves, and whenever the service says the job is still waiting in
   * its own queue.
   */
  standstillMs: number
  /** When this job was last observed; the base for the next gap. */
  lastObservedAt: number
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

  /**
   * Tail of the chain of passes. Every pass - `tick` and `resumeInterrupted`
   * alike - runs behind the previous one, because two passes over the same
   * queue would both read a job as `queued` while the first one is still
   * inside its `submit` request (up to the client's 30 s limit) and hand the
   * same audio over twice. That is exactly the double transcription Ruling 23
   * exists to prevent, and it needs no timeout to happen: Task 8 wires this as
   * an IPC handler AND an interval.
   *
   * Passes are serialised rather than skipped so that a `resumeInterrupted`
   * arriving during a pass still happens; a skipped resumption would leave
   * jobs stranded in `running` for the rest of the session.
   */
  private passes: Promise<void> = Promise.resolve()

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
   * deviation from a policy decision that this feature exists to prevent.
   *
   * Two things are raised instead, because there is no row to carry them: a
   * tenant this runner does not serve (a configuration error of the caller,
   * caught before anything is written) and a database that cannot take the
   * job at all.
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
    let job: TranscriptionJob
    try {
      job = TranscriptionModel.createJob(tenantId, workspaceId, spooledPath, targetId)
    } catch (error) {
      // Without a row, nothing points at the copy: Task 9's deletion walks
      // jobs, and this one does not exist. It would sit in the spool for ever.
      await discard(spooledPath)
      throw error
    }

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
    return this.inOwnPass(async () => {
      for (const tenantId of this.tenantIds) {
        for (const job of TranscriptionModel.listByState('running', tenantId)) {
          if ((await this.attempt(job, (it) => this.observe(it))) === 'service-unavailable') return
        }
        for (const job of TranscriptionModel.listByState('queued', tenantId)) {
          if ((await this.attempt(job, (it) => this.start(it))) === 'service-unavailable') return
        }
      }
    })
  }

  /**
   * One job's turn, with its surprises kept to that job.
   *
   * `start` and `observe` deliberately raise anything that is NOT the service
   * answering - a programming or configuration error, such as an API key that
   * cannot go into a header. Raised through `tick` it aborted the whole pass:
   * every job behind it was skipped, no row said why, and the only trace was a
   * log line in the caller. One job's surprise is not the queue's outage.
   *
   * It is recorded as a WAIT reason, not as a failure: what gets here is a
   * condition someone can fix, not a broken recording, and a failed job would
   * need re-submitting after the fix. The state stays where it was, so the
   * next pass picks the job up again.
   */
  private async attempt(
    job: TranscriptionJob,
    step: (job: TranscriptionJob) => Promise<StepOutcome>
  ): Promise<StepOutcome> {
    try {
      return await step(job)
    } catch (error) {
      // Logged as well as recorded: the row says what a user can see, the log
      // keeps the detail for whoever has to fix the cause.
      logger.error('Unexpected error while handling a transcription job', {
        jobId: job.id,
        error: describeError(error)
      })

      // The recording is inside the guard as well. It writes to the database,
      // which can fail for the same reasons the step did - and an error from
      // the error handling would leave `attempt` and `tick` exactly the way
      // this method exists to prevent, one layer down.
      try {
        this.recordUnexpectedError(job, describeError(error))
      } catch (recordingError) {
        logger.error('Could not record that error on the transcription job', {
          jobId: job.id,
          error: describeError(recordingError)
        })
      }
      return 'handled'
    }
  }

  /**
   * Put every job that was `running` when the process stopped back into the
   * queue. The service holds its queue in memory and lost it as well, so
   * submitting again is the only way such a job ever finishes - and the
   * alternative, leaving it `running`, would strand it for ever.
   */
  async resumeInterrupted(): Promise<void> {
    return this.inOwnPass(async () => {
      for (const tenantId of this.tenantIds) {
        for (const job of TranscriptionModel.listByState('running', tenantId)) {
          this.requeue(job)
        }
      }
    })
  }

  /**
   * Cancel a job the user no longer wants, and say what happened.
   *
   * Runs OUTSIDE the pass chain on purpose. A cancellation that had to wait
   * for a 30-second submit request to come back would be useless, and it does
   * not have to: every state change a pass makes is a compare-and-swap on the
   * state the pass read, so whichever of the two lands second loses - and
   * finds out. Serialising the cancel behind the passes would trade a lost
   * write for a slow one.
   *
   * What it does NOT do is stop a transcription the service already started:
   * the service has no cancel endpoint in stage 1, so it finishes the job into
   * the void. Nothing here polls it again and no transcript is stored.
   */
  cancel(tenantId: string, jobId: string): TranscriptionCancelOutcome {
    const job = TranscriptionModel.getJob(jobId, tenantId)
    if (job === null) return { cancelled: false, reason: 'not-found' }
    if (!CANCELLABLE_STATES.includes(job.state)) {
      return { cancelled: false, reason: 'not-cancellable', state: job.state }
    }

    if (!TranscriptionModel.compareAndSetState(job.id, job.state, 'cancelled')) {
      // A pass changed the state between the read above and here. Report the
      // state the job now HAS, read again rather than guessed.
      const current = TranscriptionModel.getJob(jobId, tenantId)
      return { cancelled: false, reason: 'not-cancellable', state: current?.state ?? job.state }
    }

    this.audit(job, 'cancelled', LOCAL_USER_ACTOR)
    this.forget(job.id)
    return { cancelled: true }
  }

  /**
   * Run `work` after every pass started before it, and never beside one.
   *
   * The caller still sees `work`'s own rejection - an unexpected error has to
   * surface - but a rejected pass must not poison the chain for the passes
   * behind it, hence the separate, swallowed tail.
   */
  private inOwnPass(work: () => Promise<void>): Promise<void> {
    const pass = this.passes.then(work, work)
    this.passes = pass.then(
      () => undefined,
      () => undefined
    )
    return pass
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
        this.recordWaitReason(job, error.message)
        return 'service-unavailable'
      }
      if (error instanceof TranscriptionServiceError) {
        if (isRetryableStatus(error.status)) {
          this.recordWaitReason(job, error.message)
          return 'service-unavailable'
        }
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

    // Clears any wait reason recorded while the service was unavailable - and
    // only if the job is still queued. The submit above took up to 30 seconds,
    // and a cancellation that arrived inside that window must not be turned
    // back into a running job. The audio HAS been handed over; the service
    // will transcribe it into the void, which is the price of there being no
    // cancel endpoint. Nothing polls it, nothing is stored.
    if (!this.transition(job, 'running')) {
      this.forget(job.id)
      return 'handled'
    }

    this.tracked.set(job.id, {
      serviceJobId: submitted.jobId,
      lastProgress: job.progress,
      standstillMs: 0,
      lastObservedAt: Date.now()
    })
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
        this.recordWaitReason(job, error.message)
        return 'service-unavailable'
      }
      if (error instanceof TranscriptionServiceError) {
        if (error.status === HTTP_NOT_FOUND) {
          // The service restarted and lost its in-memory queue. NOW submitting
          // again is right - and only now.
          this.requeue(job)
          return 'handled'
        }
        if (isRetryableStatus(error.status)) {
          this.recordWaitReason(job, error.message)
          return 'service-unavailable'
        }
        this.fail(job, error.message)
        return 'handled'
      }
      throw error
    }

    // The poll was an await, so the row may have been cancelled while it was
    // in flight. Then nothing below is worth writing - not the progress
    // either - and the handle goes. Everything after this point is
    // synchronous, so this reading cannot go stale before the writes happen.
    if (TranscriptionModel.getJob(job.id, job.tenantId)?.state !== 'running') {
      this.forget(job.id)
      return 'handled'
    }

    // The answer arrived, so whatever the job was waiting for is over.
    this.clearWaitReason(job)

    // One reading of the clock for both: two calls would drop the sliver
    // between them out of the accounting.
    const now = Date.now()
    const gap = now - tracked.lastObservedAt
    tracked.lastObservedAt = now

    if (status.progress !== tracked.lastProgress) {
      tracked.lastProgress = status.progress
      tracked.standstillMs = 0
      // Stored as the service reports it (0..1), never rescaled.
      TranscriptionModel.setProgress(job.id, status.progress)
    } else {
      tracked.standstillMs += Math.min(gap, MAX_COUNTED_OBSERVATION_GAP_MS)
    }

    switch (status.state) {
      case 'done':
        // State first, transcript second: the transition can be refused, and
        // a cancelled job must not end up with a stored transcript. Both
        // writes are synchronous, so no reader sees the row in between.
        if (this.transition(job, 'done')) {
          TranscriptionModel.saveSegments(job.id, status.segments)
        }
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
        // worker may be busy with another job.
        tracked.standstillMs = 0
        return 'handled'

      case 'running':
        return this.giveUpOnStandstill(job, tracked)
    }
  }

  private giveUpOnStandstill(job: TranscriptionJob, tracked: TrackedJob): StepOutcome {
    if (tracked.standstillMs > this.progressStallTimeoutMs) {
      this.fail(
        job,
        'Der Transkriptionsdienst meldet seit ' +
          `${Math.round(tracked.standstillMs / 60_000)} Minuten beobachteter Laufzeit ` +
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

  /**
   * Say on the job WHY it is waiting, without moving it out of its state.
   *
   * A job that silently sits in the queue because the service is unreachable
   * or the API key is not wired up yet looks identical to one that is simply
   * next in line. There is no column for "why waiting", so the reason goes
   * where the user already looks for it; the prefix keeps it readable as a
   * wait rather than a failure. Any state change clears it again, so it cannot
   * outlive the condition.
   *
   * No audit entry: nothing changed state, and the audit records state
   * changes.
   *
   * Written as an error-only update, never as `setState(job.id, job.state)`:
   * `job` was read at the start of the pass, and writing that state back would
   * revert a change made in between - a cancellation arriving during a
   * 30-second submit request would simply vanish.
   *
   * It REFUSES a row that has reached a terminal state in the meantime. Such a
   * job is not waiting for anything, and the IPC view deliberately does not
   * show reasons on terminal states - so the write would be untrue AND
   * invisible, which is how a `done` job with a missing transcript could end
   * up explaining itself to nobody. A caller that needs to say something about
   * such a row has to change the state, not the reason (see
   * `recordUnexpectedError`).
   *
   * The set comes from src/shared/types.ts, which is the same list the view
   * decides by: the two are one statement about the same thing, and keeping two
   * copies of it in step was a comment's job until now.
   */
  private recordWaitReason(job: TranscriptionJob, reason: string): void {
    const current = TranscriptionModel.getJob(job.id, job.tenantId)
    if (current === null || !TRANSCRIPTION_WAITING_STATES.includes(current.state)) return
    TranscriptionModel.setError(job.id, `Wartet: ${reason}`)
  }

  /**
   * Put an unexpected error where someone will actually meet it.
   *
   * While the job is queued or running, it is a WAIT reason: what gets here is
   * a condition someone can fix, not a broken recording, and the next pass
   * picks the job up again.
   *
   * A row that has already reached `done` is the one case where that is not
   * true, and the only way to get here with one is `saveSegments` failing
   * right after the job was set to `done`. That row claims a finished
   * transcription whose transcript is missing; a wait reason on it would be
   * hidden, and the user would see an empty transcript with no explanation.
   * Reaching `done` without a transcript is not a success, so the job is
   * marked FAILED with the reason - which the view does show.
   *
   * `cancelled` and `failed` are left exactly as they are: a cancellation must
   * not come back as a failure (Ruling 34), and a job that already failed
   * keeps the reason it failed with.
   *
   * Only the terminal branch releases the handles. A job that stays queued or
   * running keeps them on purpose: `observe` reads a `running` job without a
   * tracked service job id as "this process lost the handle" and puts it back
   * into the queue, so dropping the entry here would hand the same audio over
   * a second time - the double transcription the whole state machine avoids.
   */
  private recordUnexpectedError(job: TranscriptionJob, reason: string): void {
    const current = TranscriptionModel.getJob(job.id, job.tenantId)
    if (current === null) return

    if (current.state === 'done') {
      // `current`, not `job`: its state is the one the compare-and-swap has to
      // expect, and this is a real state change, so it is audited like one.
      this.transition(current, 'failed', reason)
      // AFTER the transition, because the audit entry it writes reads the
      // declared level out of one of the maps this clears.
      //
      // The only way to get here is `saveSegments` throwing right after the row
      // was set to `done` - and `observe` releases the handles only once saving
      // has returned, so that throw skipped it. The job is over either way,
      // whether the transition landed or a cancellation got there first, so
      // this pass is done with it and nothing may keep pointing at it.
      this.forget(job.id)
      return
    }

    this.recordWaitReason(current, reason)
  }

  private clearWaitReason(job: TranscriptionJob): void {
    // Only when there is something to clear - otherwise every poll of every
    // running job would write a row for nothing.
    if (job.error !== undefined) TranscriptionModel.setError(job.id, null)
  }

  /**
   * Write one state change of this pass - but only if the job is still in the
   * state the pass read, and say whether that was the case.
   *
   * `job.state` is the expected value on purpose: it is what the pass saw when
   * it picked the job up, and every decision it made rests on it. A refused
   * transition means someone else got there first (a cancellation through
   * `cancel`), and then this pass has nothing more to say about the job - no
   * state, and no audit entry either, because nothing changed.
   */
  private transition(job: TranscriptionJob, state: TranscriptionJobState, error?: string): boolean {
    if (!TranscriptionModel.compareAndSetState(job.id, job.state, state, error)) return false
    this.audit(job, state)
    return true
  }

  private fail(job: TranscriptionJob, reason: string): void {
    this.transition(job, 'failed', reason)
    // The handle goes either way: this pass is done with the job, whether the
    // failure was recorded or a cancellation got there first.
    this.forget(job.id)
  }

  private requeue(job: TranscriptionJob): void {
    this.tracked.delete(job.id)
    // Without an error argument any earlier message is cleared - the job is
    // waiting again, not failed.
    this.transition(job, 'queued')
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
  private audit(
    job: TranscriptionJob,
    state: TranscriptionJobState,
    actor: AuditActor = SYSTEM_ACTOR
  ): void {
    getActivityLogger().log({
      actorType: actor.actorType,
      actorId: actor.actorId,
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
    const spoolDir = await this.prepareSpoolDir()
    // A generated name, not the original one: two recordings called
    // "aufnahme.wav" must not overwrite each other in a shared directory.
    const target = path.join(spoolDir, `${randomUUID()}${safeExtension(audioPath)}`)
    try {
      // The destination is created BY US at 0o600 and streamed into, rather
      // than created by `copyFile` at 0o644 and tightened afterwards. The
      // difference is not microseconds: `copyFile` creates the file and then
      // streams into it, which is seconds for an hour of WAV, and a reader who
      // opens it inside that window keeps the descriptor - and with it read
      // access to the finished recording - across any later chmod. This way
      // the file never exists at any other mode.
      //
      // `wx` keeps the never-overwrite property an explicit create would
      // otherwise lose.
      await pipeline(
        createReadStream(audioPath),
        createWriteStream(target, { flags: 'wx', mode: 0o600 })
      )
    } catch (error) {
      // A copy that failed part-way leaves a truncated file behind that no row
      // will ever point at, so nothing would clean it up later.
      await discard(target)
      throw error
    }
    return target
  }

  /**
   * Make sure the spool directory exists AND is not readable by other local
   * accounts, and hand back its path.
   *
   * The mode argument only applies to a directory this call actually creates.
   * In the ordinary start order it never does: the service has to be running
   * before Mingly submits anything, and it creates the spool itself (now with
   * mode 0o700 - without a mode it was 0755, which is what made this a real
   * exposure rather than a theoretical one).
   *
   * So a directory we find group- or world-accessible is REFUSED, not quietly
   * tightened. Tightening someone else's directory could lock a service
   * account out of its own spool, and doing it silently would hide a
   * misconfigured deployment; refusing puts it in front of the user, on the
   * job, in the same place as every other reason a recording did not run.
   */
  private async prepareSpoolDir(): Promise<string> {
    const spoolDir = this.spoolDir
    await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 })

    const { mode } = await fs.stat(spoolDir)
    const openBits = mode & 0o077
    if (openBits !== 0) {
      throw new Error(
        `das Spool-Verzeichnis ${spoolDir} ist fuer andere Konten dieses Rechners ` +
          `zugaenglich (Rechte ${(mode & 0o777).toString(8)}). Darin liegen die ` +
          'Aufnahmen selbst. Setze die Rechte auf 700 (chmod 700) und starte den ' +
          'Transkriptionsdienst neu, damit er es kuenftig selbst so anlegt'
      )
    }

    return spoolDir
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

/**
 * Remove a spool copy nothing points at. Best effort on purpose: every caller
 * is already handling a failure and must not be derailed by a second one.
 */
async function discard(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true }).catch(() => undefined)
}

/**
 * Whether an answered-but-refused request says "not now" rather than "no".
 * Such a status leaves the job in its state to be tried again; everything else
 * fails it, because repeating the identical request would not change it.
 *
 * - **401/403** - the service wants a key. Nobody wires one up before Task 7,
 *   so until then EVERY job would die on the first pass against a service
 *   that requires one. A missing key is a configuration problem of the
 *   installation, not a property of the recording.
 * - **429 and every 5xx** - the service is there and broke on its own side.
 *   FastAPI answers 500 for any unhandled exception in the submit or poll
 *   handler, a reverse proxy adds 502 and 504, and 503 is the service's own
 *   "models not loaded yet". None of those is a statement about this
 *   recording, and all of them pass.
 * - **2xx** - the client reports an unusable BODY by wrapping it in a
 *   `TranscriptionServiceError` that carries the ANSWER's own 2xx status
 *   (transcription-http-client.ts). The service accepted the request and is
 *   working: one garbled poll answer must not fail a job that has been
 *   computing for forty minutes, and a garbled submit answer must not fail a
 *   row for a job the service has already taken.
 *
 * What is left over - 400, 404 (handled before this is asked), 405, 413, 415 -
 * is the service saying no about THIS request, and repeating it identically
 * would not change the answer.
 */
function isRetryableStatus(status: number): boolean {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return true
  if (status === HTTP_TOO_MANY_REQUESTS || status >= 500) return true
  return status >= 200 && status < 300
}

// ── Singleton ────────────────────────────────────────────────────

/**
 * The one runner of this process.
 *
 * A singleton is not convenience here, it is correctness: every handle to a
 * job the service is working on lives in this instance's `tracked` map and is
 * deliberately not persisted. A second instance would read those jobs as
 * `running` without a handle, put them back into the queue and hand the same
 * audio over a second time - the double transcription the whole state machine
 * is built to avoid.
 */
let runnerInstance: TranscriptionJobRunner | null = null

export function getTranscriptionJobRunner(): TranscriptionJobRunner {
  if (!runnerInstance) {
    runnerInstance = new TranscriptionJobRunner()
  }
  return runnerInstance
}
