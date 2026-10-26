import { dbRun, dbAll, dbGet } from '../index'
import { generateId } from '../../utils/id-generator'

export type TranscriptionJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TranscriptionJob {
  id: string
  tenantId: string
  workspaceId: string
  audioPath: string
  state: TranscriptionJobState
  /** Stored as given; the scale is defined by the transcription service, not by this model. */
  progress: number
  targetId: string
  /**
   * Why the job is not progressing — and it is NOT only set for failures.
   *
   * The job runner also uses it to say why a job is WAITING, prefixed with
   * `Wartet: ` (service unreachable, no API key configured, models not loaded
   * yet). There is no separate column for that, and a job sitting in the queue
   * for an invisible reason is worse than a reused field.
   *
   * So read `state` to find out whether the job failed, never this field. It is
   * cleared by the next state change without an error, and by the runner as
   * soon as whatever it was waiting for is over.
   */
  error?: string
  createdAt: number
  updatedAt: number
}

export interface TranscriptionSegment {
  jobId: string
  index: number
  startMs: number
  endMs: number
  speaker: string
  text: string
}

const JOB_COLUMNS =
  'id, tenant_id, workspace_id, audio_path, state, progress, target_id, error, created_at, updated_at'

const SEGMENT_COLUMNS = 'job_id, segment_index, start_ms, end_ms, speaker, text'

// Name of the savepoint that makes saveSegments atomic. A savepoint (unlike
// BEGIN) also works when a caller already runs inside a transaction.
const SAVE_SEGMENTS_SAVEPOINT = 'save_transcription_segments'

export class TranscriptionModel {
  static createJob(
    tenantId: string,
    workspaceId: string,
    audioPath: string,
    targetId: string
  ): TranscriptionJob {
    const id = generateId()
    const now = Date.now()

    dbRun(
      `INSERT INTO transcription_jobs (id, tenant_id, workspace_id, audio_path, state, progress, target_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      [id, tenantId, workspaceId, audioPath, targetId, now, now]
    )

    return {
      id, tenantId, workspaceId, audioPath,
      state: 'queued', progress: 0, targetId,
      createdAt: now, updatedAt: now
    }
  }

  /** Move a job to a new state. Without `error` any previous error message is cleared. */
  static setState(id: string, state: TranscriptionJobState, error?: string): void {
    dbRun(
      'UPDATE transcription_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?',
      [state, error ?? null, Date.now(), id]
    )
  }

  /**
   * Set or clear `error` WITHOUT touching the state.
   *
   * For a reason that does not move the job: the runner records why a job is
   * waiting while it stays queued or running. Writing the state back from a
   * value read seconds earlier would revert a state change made in between —
   * a cancellation landing during a 30-second submit request, for instance.
   */
  static setError(id: string, error: string | null): void {
    dbRun(
      'UPDATE transcription_jobs SET error = ?, updated_at = ? WHERE id = ?',
      [error, Date.now(), id]
    )
  }

  static setProgress(id: string, progress: number): void {
    dbRun(
      'UPDATE transcription_jobs SET progress = ?, updated_at = ? WHERE id = ?',
      [progress, Date.now(), id]
    )
  }

  /** Jobs of one tenant in one state, oldest first (queue order). */
  static listByState(state: TranscriptionJobState, tenantId: string): TranscriptionJob[] {
    const rows = dbAll(
      `SELECT ${JOB_COLUMNS} FROM transcription_jobs
       WHERE state = ? AND tenant_id = ? ORDER BY created_at ASC, rowid ASC`,
      [state, tenantId]
    )

    return rows.map(TranscriptionModel.rowToJob)
  }

  /**
   * Store the transcript of a job, replacing any segments saved before, in one
   * atomic step: on failure the previous segments stay untouched.
   *
   * The `jobId` argument is authoritative (`segment.jobId` is not read), and the
   * segments inherit the tenant of their job. Throws if the job does not exist;
   * that is checked here because the foreign key is not enforced at runtime
   * (see migration 12).
   */
  static saveSegments(jobId: string, segments: TranscriptionSegment[]): void {
    const job = dbGet('SELECT tenant_id FROM transcription_jobs WHERE id = ?', [jobId])
    if (!job) {
      throw new Error(`Cannot save segments: transcription job ${jobId} does not exist`)
    }
    const tenantId = job.tenant_id as string

    dbRun(`SAVEPOINT ${SAVE_SEGMENTS_SAVEPOINT}`)
    try {
      dbRun('DELETE FROM transcription_segments WHERE job_id = ?', [jobId])
      for (const s of segments) {
        dbRun(
          `INSERT INTO transcription_segments (job_id, tenant_id, segment_index, start_ms, end_ms, speaker, text)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [jobId, tenantId, s.index, s.startMs, s.endMs, s.speaker, s.text]
        )
      }
      dbRun(`RELEASE ${SAVE_SEGMENTS_SAVEPOINT}`)
    } catch (err) {
      dbRun(`ROLLBACK TO ${SAVE_SEGMENTS_SAVEPOINT}`)
      dbRun(`RELEASE ${SAVE_SEGMENTS_SAVEPOINT}`)
      throw err
    }
  }

  /** Segments of a job in transcript order. Empty for a job of another tenant. */
  static getSegments(jobId: string, tenantId: string): TranscriptionSegment[] {
    const rows = dbAll(
      `SELECT ${SEGMENT_COLUMNS} FROM transcription_segments
       WHERE job_id = ? AND tenant_id = ? ORDER BY segment_index ASC`,
      [jobId, tenantId]
    )

    return rows.map(TranscriptionModel.rowToSegment)
  }

  private static rowToJob(row: Record<string, unknown>): TranscriptionJob {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      workspaceId: row.workspace_id as string,
      audioPath: row.audio_path as string,
      state: row.state as TranscriptionJobState,
      progress: row.progress as number,
      targetId: row.target_id as string,
      error: (row.error as string | null) ?? undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }
  }

  private static rowToSegment(row: Record<string, unknown>): TranscriptionSegment {
    return {
      jobId: row.job_id as string,
      index: row.segment_index as number,
      startMs: row.start_ms as number,
      endMs: row.end_ms as number,
      speaker: row.speaker as string,
      text: row.text as string
    }
  }
}
