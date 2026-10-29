/**
 * Retention and deletion for transcription jobs.
 *
 * This is the one module of the feature whose mistakes cannot be undone, so
 * three properties are built in rather than tested for afterwards:
 *
 * 1. **Nothing is deleted without its tenant.** Every statement filters by
 *    tenant, and `deleteJob` refuses a job that is not the caller's instead of
 *    quietly doing nothing - a silent no-op would look like a successful
 *    deletion to whoever asked for it.
 * 2. **Segments are deleted EXPLICITLY, never by cascade.** The foreign key on
 *    `transcription_segments` declares ON DELETE CASCADE, but sql.js resets
 *    PRAGMA foreign_keys to 0 on every `export()`, i.e. on every
 *    `saveDatabase()`, so the cascade does not run (migration 12 says the same
 *    at the schema). Without the explicit DELETE the transcript text would
 *    stay behind as orphan rows - "Löschen muss löschen" (design 8) failed in
 *    the one way nobody would notice.
 * 3. **Only a file inside the spool directory is ever unlinked.** Not a
 *    formality: `audio_path` does NOT always hold the spool copy. A recording
 *    that was refused before it was ever copied carries the USER'S OWN path
 *    (`refuse` in job-runner.ts creates the row with the submitted path), and
 *    deleting a job must not take the user's recording with it. The job is
 *    deleted either way, the foreign file is left where it is, and a delete
 *    that executes whatever path a row holds is a class of risk a read is not.
 *
 * What this module does NOT do is run on its own. It provides the operations;
 * nothing in stage 1 schedules `purgeExpired`, because a deletion that happens
 * without anyone having asked for it is exactly the thing that must not be
 * wired up on the side.
 */

import fs from 'fs'
import path from 'path'
import { dbRun, dbAll, dbGet, DEFAULT_TENANT_ID } from '../database/index'
import { getActivityLogger } from '../audit/activity-logger'
import { isPathSafe } from '../../shared/file-access-types'
import { createLogger } from '../../shared/logger'

const logger = createLogger('TranscriptionRetention')

const DAY_MS = 86_400_000

/** Upper bound for a period, so an obvious typo is refused instead of stored. */
const MAX_RETENTION_DAYS = 36_500

/**
 * The entity type and the actor ids mirror the job runner's audit entries
 * (`AUDIT_ENTITY_TYPE`, `LOCAL_USER_ACTOR` in transcription/job-runner.ts), so
 * that the entries about one job form ONE trail instead of two. They are
 * repeated rather than imported because the runner keeps them private; a
 * deletion must not be the reason the runner's internals become API.
 */
const AUDIT_ENTITY_TYPE = 'transcription_job'
const USER_ACTOR = { actorType: 'user', actorId: 'local' }
const SYSTEM_ACTOR = { actorType: 'system', actorId: 'transcription-retention' }

/**
 * Same message whether the job belongs to another tenant or does not exist -
 * the discipline the IPC surface already follows. Telling the two apart would
 * answer "does this id exist somewhere else".
 */
const NOT_FOUND = 'Transkriptionsauftrag nicht gefunden'

/**
 * What a caller is told when a recording could not be removed. The REASON goes
 * into the log, not into the message: it is about the state of the machine,
 * and the caller can do nothing with it but learn where things lie.
 */
const DELETE_REFUSED =
  'Dieser Auftrag konnte nicht gelöscht werden. Er bleibt unverändert bestehen.'

/**
 * States whose work is not over. Their audio is left alone by the retention
 * run: pulling the recording out from under a job that is queued or running
 * breaks the transcription, and the file is the only copy the service can
 * read.
 *
 * Deliberately its own list, although it holds the same two states as
 * `TRANSCRIPTION_WAITING_STATES` and the runner's `CANCELLABLE_STATES`. Those
 * answer "may a reason be shown on this row" and "can this still be called
 * off"; neither answer settles whether the recording may be deleted, and
 * merging the three would tie unrelated decisions together.
 *
 * The price of this decision: a job that never leaves the queue - an endpoint
 * that stays unreachable - keeps its recording past the deadline. It is the
 * lesser of the two, because the alternative destroys a transcription in
 * progress, and it ends as soon as the job reaches a final state. The
 * `attempts` column added in migration 13 is where the cap that bounds this
 * belongs.
 */
const PROTECTED_STATES: readonly string[] = ['queued', 'running']

export interface RetentionSettings {
  audioDays: number
  transcriptDays: number
}

/**
 * What a workspace gets until someone sets something else.
 *
 * The two numbers differ because the two purposes differ, and the purpose is
 * what the law goes by: Art. 6 Abs. 4 DSG requires personal data to be
 * destroyed or anonymised as soon as it is no longer needed for the purpose it
 * was gathered for. There is no retention PERIOD for a recording to look up -
 * the period is derived from the purpose, which makes the shortest span that
 * still serves it the only defensible default.
 *
 * For the recording that span ends with the verified transcript. What is kept
 * past it serves exactly one purpose: transcribing again when the first run
 * came out wrong. Seven days is a working week to notice - and what gets
 * deleted is Mingly's own spool COPY, so removing it costs the user nothing
 * they still have. (The one case where `audio_path` is the user's own file, a
 * refusal before the copy was made, is never deleted here at all.)
 *
 * The transcript is the work product the user came for. How long a business
 * keeps its own work product is its documentation question, not ours - so a
 * year is a placeholder for a decision, and deleting it after a month without
 * anyone having asked would be data loss dressed up as data protection.
 *
 * Both are defaults, not recommendations: the periods belong to the customer,
 * who is the controller, and the commentary on Art. 6 Abs. 4 expects them to be
 * written down in a retention policy rather than inherited from a vendor.
 *
 * One thing this file used to assert and should not have: that a voice is a
 * biometric datum. Art. 5 lit. c Ziff. 4 DSG covers biometric data "that
 * uniquely identifies a natural person", and no source consulted for the
 * research note addresses the voice at all. It may well be - it is not settled,
 * and the answer decides whether the stricter regime applies to this whole
 * feature. Sources and the open questions:
 * docs/superpowers/specs/2026-10-27-aufbewahrungsfristen-recherche.md
 */
const DEFAULT_RETENTION: RetentionSettings = { audioDays: 7, transcriptDays: 365 }

/**
 * The tenant these two settings functions read and write for.
 *
 * Their signatures take a workspace and no tenant (plan, task 9), and stage 1
 * is one tenant per installation - the same reason `callerTenantId()` exists
 * in the IPC handlers. The COLUMN is there either way, so stage 2 changes this
 * function and nothing else. `purgeExpired` and `deleteJob` are handed their
 * tenant, because they are also called for a tenant that is not the caller's.
 */
function settingsTenantId(): string {
  return DEFAULT_TENANT_ID
}

/** The periods of one workspace, or the default when it has none of its own. */
export function getRetention(workspaceId: string): RetentionSettings {
  return retentionFor(settingsTenantId(), requireWorkspaceId(workspaceId))
}

/**
 * Set the periods of one workspace. Refuses anything that is not a whole
 * number of days in range, rather than storing it: a NaN would silently make
 * every comparison false, which looks exactly like "nothing has expired yet".
 */
export function setRetention(workspaceId: string, settings: RetentionSettings): void {
  const workspace = requireWorkspaceId(workspaceId)
  const audioDays = requireDays(settings.audioDays, 'Audio-Frist')
  const transcriptDays = requireDays(settings.transcriptDays, 'Transkript-Frist')

  // INSERT OR REPLACE rather than an UPDATE/INSERT pair: the primary key is
  // (tenant_id, workspace_id), nothing references this table, and the row has
  // no column a replace would have to preserve.
  dbRun(
    `INSERT OR REPLACE INTO transcription_retention
     (tenant_id, workspace_id, audio_days, transcript_days) VALUES (?, ?, ?, ?)`,
    [settingsTenantId(), workspace, audioDays, transcriptDays]
  )
}

/**
 * Delete what has outlived its period, for ONE tenant, and say how much.
 *
 * `now` is a parameter and not `Date.now()` so that the clock this decides by
 * is the caller's and can be seen in a test. An unusable value is refused:
 * with NaN every comparison is false and the run would report "nothing
 * expired" for a reason that has nothing to do with the data.
 *
 * The two numbers count JOBS, not files or rows, and they are independent: a
 * job whose audio AND transcript expire in the same run is counted in both,
 * because two separate deletions happened to it. `audio` counts the jobs whose
 * recording is gone from disk AFTER this run - a file that was already missing
 * counts once, here, and never again (a missing file is not a reason to keep
 * reporting a deletion). `transcripts` counts only jobs that actually HAD
 * segments; a failed job without a transcript is not a deleted transcript.
 *
 * What it does not touch: the job row itself and the audit entries. Once audio
 * and transcript are gone the row holds no CONTENT - a path, a state, two
 * timestamps - and it is what makes the audit trail of that job readable at
 * all. One reservation, left open rather than hidden: for a job whose recording
 * was refused before it was copied, that path is the user's own file name, and
 * a file name can describe a conversation. Emptying it belongs with the
 * question of whether the row should expire too, which nobody has decided.
 *
 * DEBT: nothing calls this, so the deletion deadlines exist as a setting and not
 * as behaviour - the spool keeps every recording for as long as the process has
 * ever run → wire a scheduler as soon as `src/preload/index.ts` bridges
 * `transcription:submit`, because from that moment recordings arrive from the UI
 * and accumulate.
 *
 * Why that matters beyond tidiness: Art. 6 Abs. 4 DSG requires personal data to
 * be destroyed or anonymised as soon as it is no longer needed for the purpose -
 * there is no retention PERIOD for a recording, there is a duty to be rid of it.
 * The commentary on that article names automated deletion in the software as the
 * practical way to meet it (OK-Gaul, Art. 6 Abs. 3-5 DSG, N 36). The periods
 * themselves are the customer's to set, which is why they are per workspace;
 * `DEFAULT_RETENTION` is a placeholder until they are decided. Sources and the
 * open legal questions: docs/superpowers/specs/2026-10-27-aufbewahrungsfristen-recherche.md
 */
export function purgeExpired(tenantId: string, now: number): { audio: number; transcripts: number } {
  const tenant = requireTenantId(tenantId)
  if (!Number.isFinite(now)) {
    throw new Error(`Aufbewahrung kann nicht gegen eine unbrauchbare Uhrzeit geprüft werden: ${now}`)
  }

  const spool = resolveSpoolRoot()
  const spoolRoot = spool.root
  if (spoolRoot === undefined) {
    // Not fatal for the whole run: deleting transcripts touches no file at
    // all, and refusing that too would make a missing environment variable
    // stop a deletion it has nothing to do with.
    logger.warn('Retention run cannot delete recordings', { reason: spool.refusal })
  }

  const jobs = dbAll(
    `SELECT id, workspace_id, audio_path, state, created_at, audio_deleted_at
     FROM transcription_jobs WHERE tenant_id = ? ORDER BY created_at ASC, rowid ASC`,
    [tenant]
  )

  // One lookup per workspace, not per job: a tenant has few workspaces and
  // many jobs.
  const periods = new Map<string, RetentionSettings>()
  let audio = 0
  let transcripts = 0

  for (const row of jobs) {
    const jobId = row.id as string
    const workspaceId = row.workspace_id as string
    const createdAt = Number(row.created_at)

    if (PROTECTED_STATES.includes(row.state as string)) continue

    let retention = periods.get(workspaceId)
    if (retention === undefined) {
      retention = retentionFor(tenant, workspaceId)
      periods.set(workspaceId, retention)
    }

    // Without a spool directory nothing is deleted and nothing is marked, so
    // the job stays due for the next run with a usable configuration.
    if (spoolRoot !== undefined && row.audio_deleted_at === null &&
        hasExpired(createdAt, retention.audioDays, now)) {
      const removal = removeRecording(spoolRoot, row.audio_path as string)
      if (removal.outcome === 'removed') {
        dbRun('UPDATE transcription_jobs SET audio_deleted_at = ? WHERE id = ?', [now, jobId])
        audio += 1
        audit(SYSTEM_ACTOR, 'audio_purged', jobId, tenant, {
          workspaceId,
          retentionDays: retention.audioDays
        })
      } else {
        // Not marked, so the job stays due - and one unusable record must not
        // end the run for the healthy ones, so the loop goes on. A job whose
        // recording was never copied into the spool (a refusal before the
        // copy) says this on every run; there is nothing of Mingly's to delete
        // for it, and claiming a deletion in `audio_deleted_at` would be a
        // false entry in the one table that documents deletions.
        logger.warn('Retention run kept a recording', {
          jobId,
          outcome: removal.outcome,
          reason: removal.reason
        })
      }
    }

    if (hasExpired(createdAt, retention.transcriptDays, now)) {
      if (deleteSegments(jobId) > 0) {
        transcripts += 1
        audit(SYSTEM_ACTOR, 'transcript_purged', jobId, tenant, {
          workspaceId,
          retentionDays: retention.transcriptDays
        })
      }
    }
  }

  return { audio, transcripts }
}

/**
 * Delete one job of one tenant: spool copy, segments, row. The audit entries
 * stay - they carry no transcript, and they are what a customer hands to a
 * supervisory authority (design 8).
 *
 * A recording that is NOT Mingly's spool copy is left on disk and the job is
 * deleted anyway (see `Removal`); the audit entry says so with
 * `recordingKept`. Only a spool copy that could not be removed stops the
 * deletion, because then the row is still the only thing that points at it.
 *
 * Unlike `purgeExpired` this deletes a job in ANY state, because it is
 * somebody's explicit decision and not a deadline. A job the service is
 * working on is dropped by the next pass: its row is gone, so no state change
 * lands and no transcript is stored for it.
 *
 * The file goes first, the rows second. The other order has a failure mode
 * that cannot be repaired from inside the app: the row is the only thing that
 * points at the spool copy, and deleting it first would leave the recording on
 * disk with nothing left to find it by.
 *
 * Every database write here is synchronous and there is no `await` between
 * them, so no transcription pass can run in between and save segments for a
 * row that is about to disappear.
 */
export function deleteJob(jobId: string, tenantId: string): void {
  const id = requireJobId(jobId)
  const tenant = requireTenantId(tenantId)

  const row = dbGet(
    'SELECT workspace_id, audio_path FROM transcription_jobs WHERE id = ? AND tenant_id = ?',
    [id, tenant]
  )
  if (row === null) throw new Error(NOT_FOUND)

  // Without a resolvable spool root the provenance cannot be established, so
  // the recording counts as foreign and is left alone - exactly like a path
  // outside the spool. Refusing here instead produced the one outcome the
  // `not-ours` reasoning below rules out, and it produced it in the DEFAULT
  // configuration: with no `TRANSCRIPTION_SPOOL_DIR`, `enqueue` still records
  // the job through `refuse()`, and that row carries the user's OWN recording
  // path - which could then never be deleted, keeping the filename of a
  // private recording for good. Refusal is right for one case only: a spool
  // copy that was identified and could not be removed, which is `failed`.
  const spool = resolveSpoolRoot()
  const removal: Removal =
    spool.root === undefined
      ? { outcome: 'not-ours', reason: spool.refusal }
      : removeRecording(spool.root, row.audio_path as string)
  if (removal.outcome === 'failed') {
    // The spool copy is still there and the row is the only thing that points
    // at it. Deleting the row now would strand the recording on disk for good,
    // so the deletion does not happen and the caller is told.
    logger.warn('Job deletion refused', { jobId: id, reason: removal.reason })
    throw new Error(DELETE_REFUSED)
  }

  // `not-ours` does NOT stop the deletion: the job goes, the foreign file
  // stays. That case is a recording refused before it was copied, where the
  // row carries the user's own recording - and a user who cannot delete such a
  // job can never erase the row, the state and the audit trail that belong to
  // it, which is the one outcome "Löschen muss löschen" rules out.
  const recordingKept = removal.outcome === 'not-ours'
  if (recordingKept) {
    logger.info('Job deleted, recording left alone', { jobId: id, reason: removal.reason })
  }

  dbRun('DELETE FROM transcription_segments WHERE job_id = ? AND tenant_id = ?', [id, tenant])
  dbRun('DELETE FROM transcription_jobs WHERE id = ? AND tenant_id = ?', [id, tenant])

  audit(USER_ACTOR, 'deleted', id, tenant, {
    workspaceId: row.workspace_id as string,
    recordingKept
  })
}

// ── Internals ────────────────────────────────────────────────────

function retentionFor(tenantId: string, workspaceId: string): RetentionSettings {
  const row = dbGet(
    `SELECT audio_days, transcript_days FROM transcription_retention
     WHERE tenant_id = ? AND workspace_id = ?`,
    [tenantId, workspaceId]
  )
  if (row === null) return { ...DEFAULT_RETENTION }

  return {
    audioDays: Number(row.audio_days),
    transcriptDays: Number(row.transcript_days)
  }
}

/**
 * Whether a recording made at `createdAt` has outlived `days`.
 *
 * `created_at` decides, not `updated_at`. What the two carry was read before
 * this was written: `created_at` is set once, when the recording is queued,
 * and nothing writes it again (models/transcription.ts); `updated_at` is
 * bumped by every state change, every progress value and every wait reason the
 * runner records - once per pass, i.e. every five seconds for a job that is
 * not getting anywhere. A period measured from it would be a period measured
 * from the last time a machine touched the row: a job in a retry loop would
 * push its own deadline ahead of itself for ever, and would never be deleted.
 * Retention is about how long the data has been HELD, which is the age of the
 * recording.
 */
function hasExpired(createdAt: number, days: number, now: number): boolean {
  return createdAt <= now - days * DAY_MS
}

function deleteSegments(jobId: string): number {
  dbRun('DELETE FROM transcription_segments WHERE job_id = ?', [jobId])

  // `changes()` belongs to the DELETE above: it is the last write on this
  // connection, and the only thing that ran in between is a debounced save
  // timer, which executes no SQL. Same technique as
  // TranscriptionModel.compareAndSetState, for want of a rows-affected count
  // on dbRun.
  const changed = dbGet('SELECT changes() AS changed')
  return Number(changed?.changed ?? 0)
}

type SpoolRoot = { root: string; refusal?: undefined } | { root?: undefined; refusal: string }

/**
 * The spool directory, resolved - or why there is none.
 *
 * Read from the environment on every call, from the SAME variable the job
 * runner reads (`TRANSCRIPTION_SPOOL_DIR`); the runner's own constructor
 * option is not visible here, so a runner configured with an explicit
 * directory in a test configures nothing for this module.
 */
function resolveSpoolRoot(): SpoolRoot {
  const configured = process.env.TRANSCRIPTION_SPOOL_DIR
  if (configured === undefined || configured === '') {
    return {
      refusal:
        'kein Spool-Verzeichnis konfiguriert (TRANSCRIPTION_SPOOL_DIR); ohne es ist nicht ' +
        'feststellbar, ob ein gespeicherter Pfad überhaupt zu einer Aufnahme gehört'
    }
  }

  try {
    return { root: fs.realpathSync(configured) }
  } catch (error) {
    return { refusal: `Spool-Verzeichnis ${configured} nicht auflösbar: ${String(error)}` }
  }
}

/**
 * What `removeRecording` did:
 *
 * - `removed` - no file of this job is left in the spool. A file that was
 *   already gone satisfies that: a run must not stop at a path whose file
 *   somebody removed by hand, and a missing file must not be reported as a
 *   fresh deletion on every later run either.
 * - `not-ours` - the path does not lie in the spool directory, so it is not
 *   Mingly's copy to delete. The ordinary case is a recording that was refused
 *   before it was ever copied: the row then carries the user's own file.
 * - `failed` - it IS a spool copy and it could not be removed.
 */
type Removal =
  | { outcome: 'removed'; reason?: undefined }
  | { outcome: 'not-ours'; reason: string }
  | { outcome: 'failed'; reason: string }

/**
 * Remove one recording, if the stored path really is Mingly's own copy.
 *
 * Both sides of the comparison are resolved, not just the stored path. On
 * macOS `/var` is a symlink to `/private/var` and `/tmp` to `/private/tmp`, so
 * comparing a resolved file against an unresolved directory makes a path
 * inside the spool look as if it were outside it. Resolving the file also
 * means a symlink lying IN the spool and pointing out of it is refused rather
 * than followed - which is the attack this check exists for.
 */
function removeRecording(spoolRoot: string, audioPath: string): Removal {
  if (typeof audioPath !== 'string' || audioPath === '') {
    return { outcome: 'not-ours', reason: 'der Datensatz enthält keinen Pfad' }
  }

  const resolved = resolveAsFarAsItExists(audioPath)
  // `isPathSafe` also accepts the directory ITSELF; a recording is never the
  // spool directory, and deleting that would take every other job's audio
  // with it.
  if (resolved === spoolRoot || !isPathSafe(resolved, spoolRoot)) {
    return {
      outcome: 'not-ours',
      reason: `der Pfad liegt nicht im Spool-Verzeichnis ${spoolRoot} (aufgelöst: ${resolved})`
    }
  }

  try {
    fs.rmSync(resolved, { force: true })
    return { outcome: 'removed' }
  } catch (error) {
    return { outcome: 'failed', reason: String(error) }
  }
}

/**
 * The path with every symlink on it resolved, as far as the path exists.
 *
 * `realpathSync` throws for a file that is gone, and a path that cannot be
 * resolved at all cannot be confined either - so the longest existing prefix
 * is resolved and the rest appended. A recording that is already missing can
 * then still be judged by WHERE it was, instead of being refused for having
 * been deleted already.
 */
function resolveAsFarAsItExists(target: string): string {
  const absolute = path.resolve(target)
  const missing: string[] = []
  let head = absolute

  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...missing)
    } catch {
      const parent = path.dirname(head)
      // The root resolves or nothing on this path does.
      if (parent === head) return absolute
      missing.unshift(path.basename(head))
      head = parent
    }
  }
}

function audit(
  actor: { actorType: string; actorId: string },
  action: string,
  jobId: string,
  tenantId: string,
  details: Record<string, unknown>
): void {
  // Never a segment, a text or a path: the audit log is the document a
  // customer hands to a supervisory authority, and content in it would be the
  // data protection problem instead of its proof. Same rule as the job
  // runner's audit entries.
  getActivityLogger().log({
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: `transcription.${action}`,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: jobId,
    tenantId,
    details
  })
}

function requireDays(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_RETENTION_DAYS) {
    throw new Error(
      `${label}: ${value} ist keine brauchbare Angabe. Erlaubt sind ganze Tage von 0 bis ${MAX_RETENTION_DAYS}.`
    )
  }
  return value
}

function requireWorkspaceId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Kein Arbeitsbereich übergeben')
  }
  return value
}

function requireTenantId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Keine Mandanten-Kennung übergeben')
  }
  return value
}

function requireJobId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Keine Auftragskennung übergeben')
  }
  return value
}
