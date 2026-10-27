/**
 * IPC Handlers — Transcription (submit, status, segments, cancel, delete, export)
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
import { dialog } from 'electron'
import { IPC_CHANNELS, TRANSCRIPTION_WAITING_STATES } from '../../shared/types'
import type { TranscriptionJobView, TranscriptExportFormat } from '../../shared/types'
import { DEFAULT_TENANT_ID } from '../database/index'
import { TranscriptionModel } from '../database/models/transcription'
import type { TranscriptionJob, TranscriptionSegment } from '../database/models/transcription'
import { getActivityLogger } from '../audit/activity-logger'
import { getTranscriptionJobRunner } from '../transcription/job-runner'
import { deleteJob } from '../transcription/retention'
import { exportTranscript } from '../transcription/transcript-export'
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

interface DeletedReply {
  success: true
  jobId: string
}

/**
 * A written file, or an abort.
 *
 * The abort is NOT an error: nothing failed and nothing left the app, so there
 * is no message for the caller to show. A failure arrives the way every other
 * refusal on this surface does - as `{ success: false, error }` from
 * `wrapHandler` - which is what tells the two apart.
 */
type ExportReply = { success: true; filePath: string } | { success: false; canceled: true }

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

// ── Export ───────────────────────────────────────────────────────

/** The formats the export channel writes. Each name is also its extension. */
const EXPORT_FORMATS: readonly TranscriptExportFormat[] = ['txt', 'srt']

/** What the save dialog offers per format, in the language of this surface. */
const EXPORT_FILTERS: Record<TranscriptExportFormat, { name: string; extensions: string[] }> = {
  txt: { name: 'Textdatei', extensions: ['txt'] },
  srt: { name: 'SRT-Untertitel', extensions: ['srt'] }
}

/**
 * The entity type and the actor mirror the job runner's and the retention
 * module's entries, so that everything about one job forms ONE trail - the
 * same two values under three names: `AUDIT_ENTITY_TYPE` with `LOCAL_USER_ACTOR`
 * in transcription/job-runner.ts, `AUDIT_ENTITY_TYPE` with `USER_ACTOR` in
 * transcription/retention.ts. Repeated rather than imported, for the reason
 * retention.ts already gives: a third module needing a constant must not be
 * what turns another module's internals into API.
 */
const AUDIT_ENTITY_TYPE = 'transcription_job'
const USER_ACTOR = { actorType: 'user', actorId: 'local' }

/**
 * The requested format, or a refusal naming the ones that exist.
 *
 * Matched against the list rather than cast, so no `as` carries an arbitrary
 * string from the renderer into the exporter. Its own `default` branch stays
 * the second line of defence (see transcript-export.ts); this is the first,
 * and unlike that one it says what IS allowed.
 */
function requireExportFormat(value: unknown): TranscriptExportFormat {
  for (const format of EXPORT_FORMATS) {
    if (value === format) return format
  }
  throw new Error(`Unbekanntes Exportformat. Erlaubt sind: ${EXPORT_FORMATS.join(', ')}.`)
}

/**
 * The document, or a German refusal carrying the original reason.
 *
 * `exportTranscript` throws for a non-finite `index`, a cue that ends before
 * it starts, a timestamp that is not a millisecond value, a U+0000 in text or
 * speaker, and an unknown format - and its messages are in English, while
 * every other refusal on this surface is in German. The reason is passed
 * through VERBATIM rather than translated: a second wording of the same
 * condition would drift from the one in transcript-export.ts, which is where
 * those conditions are defined and measured.
 */
function renderTranscript(
  segments: TranscriptionSegment[],
  format: TranscriptExportFormat
): string {
  try {
    return exportTranscript(segments, format)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Dieses Transkript kann nicht exportiert werden: ${reason}`)
  }
}

/**
 * The file name the save dialog opens with.
 *
 * A job carries no title, so the name is built from WHEN THE RECORDING WAS
 * QUEUED (`createdAt`, not the moment of export): that is what tells two
 * transcripts apart in a folder, and it sorts. Local time, because the person
 * reading the name is the person who made the recording.
 *
 * The chat export filters its name with `replace(/[^a-zA-Z0-9-_ ]/g, '')`
 * because its name is a user-supplied conversation title. This one is built
 * from digits and hyphens, so there is nothing for such a filter to remove -
 * adding one would look like a safeguard without being one. What keeps that
 * true is the test, not this comment.
 */
function defaultExportName(job: TranscriptionJob, format: TranscriptExportFormat): string {
  const made = new Date(job.createdAt)
  const stamp =
    `${made.getFullYear()}-${pad2(made.getMonth() + 1)}-${pad2(made.getDate())}` +
    `-${pad2(made.getHours())}${pad2(made.getMinutes())}${pad2(made.getSeconds())}`
  // The format name doubles as the extension; see TranscriptExportFormat.
  return `Transkript-${stamp}.${format}`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Record that a transcript left the app - and NOT where it went.
 *
 * What goes in: tenant, workspace, format and the number of segments, i.e. who
 * exported what kind of document and how much of it. What stays out is the
 * TARGET PATH, deliberately. "Where did the data go" is the obvious purpose of
 * an export audit, and it is the wrong question here: the destination is a
 * place on the user's own machine that the user picked in a dialog, so there
 * is no new recipient to record - while the path itself names directories, and
 * directory names describe clients, employers and cases. These entries also
 * outlive the job, because the deletion leaves them standing on purpose
 * (retention.ts), so a path in them would outlive the transcript it described.
 * The chosen path goes to the caller that just chose it instead, where it is
 * of use and does not accumulate.
 *
 * What this gives up: the log cannot answer "which file was that again". The
 * reader of this log is a supervisory authority, not a user hunting a file.
 *
 * Never a segment, a text or a speaker name, for the reason the job runner and
 * the retention module both state: this log is the document a customer hands
 * to that authority, and content in it would be the data protection problem
 * instead of its proof.
 */
function auditExport(
  job: TranscriptionJob,
  format: TranscriptExportFormat,
  segmentCount: number
): void {
  getActivityLogger().log({
    actorType: USER_ACTOR.actorType,
    actorId: USER_ACTOR.actorId,
    action: 'transcription.exported',
    entityType: AUDIT_ENTITY_TYPE,
    entityId: job.id,
    tenantId: job.tenantId,
    details: { workspaceId: job.workspaceId, format, segmentCount }
  })
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

  /**
   * Delete a job for good: recording, transcript, row. The audit entries stay.
   *
   * The ONE channel here without `requireFeature`, on purpose. The gate
   * decides whether this installation may HAVE the feature, and a plan that
   * ran out would otherwise lock the user out of their own recordings and
   * transcripts - the subscription state would decide whether personal data
   * can be erased, which is the one thing that must never depend on it
   * ("Loeschen muss loeschen", design 8). It hands nothing out either: the
   * only answer is that the job is gone.
   *
   * The tenant filter stays in front of it twice over, as everywhere on this
   * surface - once here for the uniform refusal, once in `deleteJob`.
   */
  wrapHandler(IPC_CHANNELS.TRANSCRIPTION_DELETE, (jobId: unknown): DeletedReply => {
    const job = requireOwnJob(jobId)
    deleteJob(job.id, callerTenantId())
    return { success: true, jobId: job.id }
  })

  /**
   * Hand one finished transcript to the user as a txt or SRT file.
   *
   * This follows the house pattern for an export (`EXPORT_CONVERSATION` in
   * content-handlers.ts) with two deliberate differences.
   *
   * 1. **It writes an AUDIT ENTRY, which the chat export does not.** A chat is
   *    the user's own conversation with a model; a transcript carries the
   *    VOICES OF THIRD PARTIES, who were recorded and did not ask for this
   *    file. Handing those out is the kind of act the activity log exists to
   *    document. Do not drop the entry to make the two channels look alike.
   * 2. **The document is rendered BEFORE the dialog opens**, where the chat
   *    export renders after. `exportTranscript` refuses five kinds of
   *    unrenderable data; a refusal arriving after the user picked a location
   *    would have cost them a dialog for nothing and left open whether a
   *    half-written file exists. This way nothing is created until the content
   *    is complete.
   *
   * `requireFeature` is here, where TRANSCRIPTION_DELETE above deliberately
   * has none. The two are not inconsistent, they are opposites: deleting must
   * stay possible when a plan runs out, or the subscription state would decide
   * whether personal data can be erased. Exporting lets data LEAVE the app, so
   * it belongs behind the same gate as the channels that read.
   *
   * There is no path check, and that is not an omission. `showSaveDialog`
   * resolves the path question: the destination is the user's own choice, so
   * there is no application-chosen write target left to confine. (The known
   * hole in `FILE_ACCESS_ADD_NETWORK_SHARE`, which `requireAllowedRecording`
   * above has to work around, does not touch this way in: nothing here reads
   * the granted-directory list.)
   *
   * Line endings and encoding are whatever `exportTranscript` produced, written
   * as UTF-8. No byte order mark: whether a given subtitle player wants one is
   * not measured here, the same reservation that module records about LF.
   */
  wrapHandler(
    IPC_CHANNELS.TRANSCRIPTION_EXPORT,
    async (jobId: unknown, format: unknown): Promise<ExportReply> => {
      requireFeature(FEATURE)
      const job = requireOwnJob(jobId)
      const exportFormat = requireExportFormat(format)

      // A job that has not finished has nothing to hand out, and an empty file
      // would be a claim that the transcript exists and is empty. The state is
      // NAMED in the refusal, unlike the refusals above that keep their reason
      // to the log: the job is the caller's own, and TRANSCRIPTION_STATUS hands
      // the same value out, so there is nothing here the caller may not know.
      if (job.state !== 'done') {
        throw new Error(
          'Nur ein abgeschlossener Auftrag kann exportiert werden. Dieser Auftrag ist im ' +
            `Zustand "${job.state}".`
        )
      }

      // The tenant again, although the job was just read for this tenant: this
      // is the query that hands out content, the same reason the segments
      // channel repeats it.
      const segments = TranscriptionModel.getSegments(job.id, callerTenantId())

      // A SECOND guard, and not a spare copy of the first: `done` does NOT
      // imply a transcript. `observe` sets the state first and saves the
      // segments second (transcription/job-runner.ts), and the HTTP client
      // accepts an empty segment list - it only checks that `segments` is a
      // list (transcription-http-client.ts). A service answering 'done' with
      // no segments leaves exactly such a row, and `exportTranscript` returns
      // the empty string for it, so the state check alone writes an empty file.
      // Measured, not reasoned: the test for this was red before this check
      // existed, and the empty file was written.
      //
      // The runner's one guard in this area is narrower than it looks. It
      // turns a `done` row into a failure only when `saveSegments` THREW
      // (`recordUnexpectedError`), which an empty but successful save does not.
      if (segments.length === 0) {
        throw new Error('Dieser Auftrag hat kein Transkript, das exportiert werden koennte.')
      }

      const content = renderTranscript(segments, exportFormat)

      const result = await dialog.showSaveDialog({
        defaultPath: defaultExportName(job, exportFormat),
        filters: [EXPORT_FILTERS[exportFormat]]
      })

      // Nothing has left the app, so nothing is written and nothing is logged.
      if (result.canceled || result.filePath === undefined) {
        return { success: false, canceled: true }
      }

      await fs.writeFile(result.filePath, content, 'utf-8')

      // After the write, never before: an entry about an export that then
      // failed would be a false record in the one table that documents what
      // left the app.
      auditExport(job, exportFormat, segments.length)

      return { success: true, filePath: result.filePath }
    }
  )
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
