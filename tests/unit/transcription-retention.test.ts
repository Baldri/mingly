/**
 * Retention and deletion tests.
 *
 * This is the one module of the transcription feature whose mistakes cannot be
 * taken back: a wrong tenant filter, a wrong deadline or a wrong clock removes
 * recordings and transcripts nobody can restore. Every deletion test therefore
 * carries a SURVIVOR in the same run - something that must still be there
 * afterwards. A deletion test without a survivor only shows that the code
 * deletes, not that it deletes the right thing.
 *
 * Nothing here is mocked away: a real sql.js database in a temp directory and
 * real files in a real spool directory. A deletion against a mock proves
 * nothing about a deletion.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  initializeDatabase,
  closeDatabase,
  dbRun,
  dbAll,
  dbGet,
  DEFAULT_TENANT_ID
} from '../../src/main/database/index'
import {
  TranscriptionModel,
  type TranscriptionSegment
} from '../../src/main/database/models/transcription'
import { getActivityLogger } from '../../src/main/audit/activity-logger'
import {
  getRetention,
  setRetention,
  purgeExpired,
  deleteJob
} from '../../src/main/transcription/retention'
import { configureLogger } from '../../src/shared/logger'

const DAY_MS = 86_400_000

const FOREIGN_TENANT = 'anderer-mandant'

/**
 * The defaults are spelled out here instead of imported from the module under
 * test. A test that takes its expectation from its subject agrees with every
 * change, including the wrong one (memory note
 * `testinstrument-darf-nicht-aus-dem-pruefling-stammen`).
 */
const EXPECTED_DEFAULT_AUDIO_DAYS = 7
const EXPECTED_DEFAULT_TRANSCRIPT_DAYS = 365

describe('Transkriptions-Aufbewahrung', () => {
  let tmpDir: string
  let spoolDir: string
  let now: number

  beforeAll(() => {
    configureLogger({ level: 'error' })
  })

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-retention-'))
    spoolDir = path.join(tmpDir, 'spool')
    fs.mkdirSync(spoolDir, { mode: 0o700 })
    vi.stubEnv('TRANSCRIPTION_SPOOL_DIR', spoolDir)
    await initializeDatabase(tmpDir)
    now = Date.now()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Helpers ────────────────────────────────────────────────────

  function spoolFile(name: string): string {
    const file = path.join(spoolDir, name)
    fs.writeFileSync(file, 'RIFF-nicht-wirklich-audio', { mode: 0o600 })
    return file
  }

  function segment(jobId: string, text: string): TranscriptionSegment {
    return { jobId, index: 0, startMs: 0, endMs: 1000, speaker: 'SPEAKER_00', text }
  }

  interface JobOptions {
    tenantId?: string
    workspaceId?: string
    /** How old the RECORDING is, i.e. what `created_at` is set to. */
    ageDays?: number
    state?: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
    transcript?: string | null
    /** Overrides the stored path AFTER the job was created. */
    audioPath?: string
  }

  interface Fixture {
    id: string
    audioPath: string
  }

  function makeJob(name: string, options: JobOptions = {}): Fixture {
    const tenantId = options.tenantId ?? DEFAULT_TENANT_ID
    const audioPath = spoolFile(`${name}.wav`)
    const job = TranscriptionModel.createJob(
      tenantId,
      options.workspaceId ?? 'ws1',
      audioPath,
      'local'
    )

    const transcript = options.transcript === undefined ? `Transkript ${name}` : options.transcript
    if (transcript !== null) TranscriptionModel.saveSegments(job.id, [segment(job.id, transcript)])

    TranscriptionModel.setState(job.id, options.state ?? 'done')

    // created_at LAST, so the state change above cannot overwrite the age.
    // updated_at keeps the value that state change wrote - which is what makes
    // the created_at/updated_at test below meaningful.
    dbRun('UPDATE transcription_jobs SET created_at = ? WHERE id = ?', [
      now - (options.ageDays ?? 0) * DAY_MS,
      job.id
    ])

    if (options.audioPath !== undefined) {
      dbRun('UPDATE transcription_jobs SET audio_path = ? WHERE id = ?', [options.audioPath, job.id])
      return { id: job.id, audioPath: options.audioPath }
    }

    return { id: job.id, audioPath }
  }

  function segmentCount(jobId: string): number {
    const row = dbGet('SELECT COUNT(*) AS n FROM transcription_segments WHERE job_id = ?', [jobId])
    return Number(row?.n ?? 0)
  }

  function jobExists(jobId: string): boolean {
    return dbGet('SELECT id FROM transcription_jobs WHERE id = ?', [jobId]) !== null
  }

  function auditEntries(tenantId: string): Record<string, unknown>[] {
    return dbAll('SELECT * FROM activity_log WHERE tenant_id = ?', [tenantId])
  }

  /** The details of the one deletion entry for this job, parsed. */
  function detailsOfDeletion(jobId: string): { recordingKept?: boolean } {
    const entries = auditEntries(DEFAULT_TENANT_ID).filter(
      (e) => e.entity_id === jobId && e.action === 'transcription.deleted'
    )
    expect(entries).toHaveLength(1)
    return JSON.parse(String(entries[0].details)) as { recordingKept?: boolean }
  }

  // ── Schema ─────────────────────────────────────────────────────

  describe('Migration 13', () => {
    it('laesst sich wiederholen, ohne die Datenbank unbrauchbar zu machen', async () => {
      // Migrationen laufen hier OHNE umschliessende Transaktion. Scheitert
      // eine nach ihrem ersten ALTER, bleibt das Schema halb angewandt und die
      // Versionsnummer ungeschrieben - der naechste Start wiederholt sie. Ein
      // nacktes ALTER TABLE ADD COLUMN stirbt dann an "duplicate column name",
      // und zwar bei jedem weiteren Start: die Datenbank waere von innen nicht
      // mehr zu oeffnen.
      const job = makeJob('vor-wiederholung', { ageDays: 10 })
      dbRun("UPDATE _meta SET value = '12' WHERE key = 'schema_version'")
      closeDatabase()

      await initializeDatabase(tmpDir)

      // Positivkontrolle im selben Lauf: Tabelle und Spalten sind danach nicht
      // nur vorhanden, sondern benutzbar.
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      expect(getRetention('ws1')).toEqual({ audioDays: 7, transcriptDays: 7 })
      expect(purgeExpired(DEFAULT_TENANT_ID, now)).toEqual({ audio: 1, transcripts: 1 })
      expect(fs.existsSync(job.audioPath)).toBe(false)
    })
  })

  // ── Fristen pro Arbeitsbereich ─────────────────────────────────

  describe('getRetention / setRetention', () => {
    it('haelt Fristen pro Arbeitsbereich, nicht global', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      setRetention('ws2', { audioDays: 30, transcriptDays: 30 })

      expect(getRetention('ws1')).toEqual({ audioDays: 7, transcriptDays: 365 })
      expect(getRetention('ws2')).toEqual({ audioDays: 30, transcriptDays: 30 })
    })

    it('wendet die Frist des jeweiligen Arbeitsbereichs an', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      setRetention('ws2', { audioDays: 30, transcriptDays: 365 })
      const abgelaufen = makeJob('ws1-alt', { workspaceId: 'ws1', ageDays: 10 })
      const nochNicht = makeJob('ws2-alt', { workspaceId: 'ws2', ageDays: 10 })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(counted.audio).toBe(1)
      expect(fs.existsSync(abgelaufen.audioPath)).toBe(false)
      // Der Ueberlebende: gleiches Alter, andere Frist.
      expect(fs.existsSync(nochNicht.audioPath)).toBe(true)
    })

    it('ueberschreibt eine bestehende Frist, statt eine zweite Zeile anzulegen', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      setRetention('ws1', { audioDays: 14, transcriptDays: 90 })

      expect(getRetention('ws1')).toEqual({ audioDays: 14, transcriptDays: 90 })
      const rows = dbAll('SELECT * FROM transcription_retention WHERE workspace_id = ?', ['ws1'])
      expect(rows).toHaveLength(1)
    })

    it('gibt fuer einen Arbeitsbereich ohne eigene Einstellung die Voreinstellung zurueck', () => {
      expect(getRetention('noch-nie-eingestellt')).toEqual({
        audioDays: EXPECTED_DEFAULT_AUDIO_DAYS,
        transcriptDays: EXPECTED_DEFAULT_TRANSCRIPT_DAYS
      })
    })

    it('wendet die Voreinstellung auch beim Aufraeumen an', () => {
      const alt = makeJob('ohne-einstellung-alt', { ageDays: EXPECTED_DEFAULT_AUDIO_DAYS + 1 })
      const jung = makeJob('ohne-einstellung-jung', { ageDays: EXPECTED_DEFAULT_AUDIO_DAYS - 1 })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(counted.audio).toBe(1)
      expect(fs.existsSync(alt.audioPath)).toBe(false)
      expect(fs.existsSync(jung.audioPath)).toBe(true)
    })

    it('liest die Frist eines fremden Mandanten NICHT', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      dbRun(
        `INSERT INTO transcription_retention (tenant_id, workspace_id, audio_days, transcript_days)
         VALUES (?, ?, ?, ?)`,
        [FOREIGN_TENANT, 'ws1', 1, 1]
      )

      // Positivkontrolle im selben Lauf: die fremde Zeile IST da, die eigene
      // Antwort kommt also aus dem Mandantenfilter und nicht aus einer leeren
      // Tabelle.
      expect(
        dbAll('SELECT * FROM transcription_retention WHERE tenant_id = ?', [FOREIGN_TENANT])
      ).toHaveLength(1)
      expect(getRetention('ws1')).toEqual({ audioDays: 7, transcriptDays: 365 })
    })

    it('weist unbrauchbare Fristen zurueck und laesst die bisherige stehen', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })

      expect(() => setRetention('ws1', { audioDays: -1, transcriptDays: 365 })).toThrow()
      expect(() => setRetention('ws1', { audioDays: 1.5, transcriptDays: 365 })).toThrow()
      expect(() => setRetention('ws1', { audioDays: Number.NaN, transcriptDays: 365 })).toThrow()
      expect(() => setRetention('ws1', { audioDays: 7, transcriptDays: -1 })).toThrow()
      expect(() => setRetention('', { audioDays: 7, transcriptDays: 365 })).toThrow()

      expect(getRetention('ws1')).toEqual({ audioDays: 7, transcriptDays: 365 })
    })
  })

  // ── purgeExpired ───────────────────────────────────────────────

  describe('purgeExpired', () => {
    it('loescht nur Abgelaufenes und zaehlt es', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      const alt1 = makeJob('alt1', { ageDays: 10 })
      const alt2 = makeJob('alt2', { ageDays: 8 })
      const frisch = makeJob('frisch', { ageDays: 1 })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(counted).toEqual({ audio: 2, transcripts: 2 })
      expect(fs.existsSync(alt1.audioPath)).toBe(false)
      expect(fs.existsSync(alt2.audioPath)).toBe(false)
      expect(segmentCount(alt1.id)).toBe(0)
      expect(segmentCount(alt2.id)).toBe(0)
      // Der Ueberlebende, im selben Lauf.
      expect(fs.existsSync(frisch.audioPath)).toBe(true)
      expect(segmentCount(frisch.id)).toBe(1)
    })

    it('meldet im zweiten Durchlauf nichts mehr', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      const alt = makeJob('alt', { ageDays: 10 })
      const frisch = makeJob('frisch', { ageDays: 1 })

      const first = purgeExpired(DEFAULT_TENANT_ID, now)
      const second = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(first).toEqual({ audio: 1, transcripts: 1 })
      expect(second).toEqual({ audio: 0, transcripts: 0 })
      expect(fs.existsSync(alt.audioPath)).toBe(false)
      expect(fs.existsSync(frisch.audioPath)).toBe(true)
      expect(segmentCount(frisch.id)).toBe(1)
    })

    it('loescht die Audiodatei und laesst das Transkript stehen, wenn nur die Audiofrist abgelaufen ist', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      const job = makeJob('zweistufig', { ageDays: 10 })

      const first = purgeExpired(DEFAULT_TENANT_ID, now)
      const second = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(first).toEqual({ audio: 1, transcripts: 0 })
      expect(fs.existsSync(job.audioPath)).toBe(false)
      // Der Ueberlebende ist hier das Transkript desselben Jobs.
      expect(segmentCount(job.id)).toBe(1)
      // Und der Job wird nicht bei jedem Lauf erneut gezaehlt.
      expect(second).toEqual({ audio: 0, transcripts: 0 })
    })

    it('entscheidet nach created_at, nicht nach updated_at', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      const alteAufnahme = makeJob('alt-zuletzt-angefasst', { ageDays: 400 })
      dbRun('UPDATE transcription_jobs SET updated_at = ? WHERE id = ?', [
        now - DAY_MS,
        alteAufnahme.id
      ])
      const neueAufnahme = makeJob('jung-lange-nicht-angefasst', { ageDays: 1 })
      dbRun('UPDATE transcription_jobs SET updated_at = ? WHERE id = ?', [
        now - 400 * DAY_MS,
        neueAufnahme.id
      ])

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(counted.audio).toBe(1)
      expect(fs.existsSync(alteAufnahme.audioPath)).toBe(false)
      expect(fs.existsSync(neueAufnahme.audioPath)).toBe(true)
    })

    it('laesst wartende und laufende Jobs unberuehrt', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      const wartend = makeJob('wartend', { ageDays: 400, state: 'queued', transcript: null })
      const laufend = makeJob('laufend', { ageDays: 400, state: 'running', transcript: null })
      // Positivkontrolle im selben Lauf: gleiches Alter, gleiche Frist, nur ein
      // abgeschlossener Zustand - dieser Job MUSS weg sein.
      const fertig = makeJob('fertig', { ageDays: 400, state: 'done' })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(counted.audio).toBe(1)
      expect(fs.existsSync(wartend.audioPath)).toBe(true)
      expect(fs.existsSync(laufend.audioPath)).toBe(true)
      expect(fs.existsSync(fertig.audioPath)).toBe(false)
    })

    it('raeumt abgebrochene und gescheiterte Jobs mit auf', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      const abgebrochen = makeJob('abgebrochen', { ageDays: 10, state: 'cancelled', transcript: null })
      const gescheitert = makeJob('gescheitert', { ageDays: 10, state: 'failed', transcript: null })
      const frisch = makeJob('frisch-abgebrochen', { ageDays: 1, state: 'cancelled', transcript: null })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(counted.audio).toBe(2)
      expect(fs.existsSync(abgebrochen.audioPath)).toBe(false)
      expect(fs.existsSync(gescheitert.audioPath)).toBe(false)
      expect(fs.existsSync(frisch.audioPath)).toBe(true)
    })

    it('zaehlt Audio und Transkript desselben Jobs in beiden Zahlen', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      makeJob('beides', { ageDays: 10 })

      expect(purgeExpired(DEFAULT_TENANT_ID, now)).toEqual({ audio: 1, transcripts: 1 })
    })

    it('zaehlt einen Job ohne Transkript nicht als geloeschtes Transkript', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      makeJob('ohne-transkript', { ageDays: 10, state: 'failed', transcript: null })

      expect(purgeExpired(DEFAULT_TENANT_ID, now)).toEqual({ audio: 1, transcripts: 0 })
    })

    it('haelt eine fehlende Audiodatei den Durchlauf nicht an', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      const erster = makeJob('erster', { ageDays: 10 })
      const kaputter = makeJob('kaputter', { ageDays: 10 })
      const dritter = makeJob('dritter', { ageDays: 10 })
      fs.rmSync(kaputter.audioPath)

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      // Die gesunden Datensaetze kommen beide dran - der kaputte steht
      // dazwischen, nicht am Ende.
      expect(fs.existsSync(erster.audioPath)).toBe(false)
      expect(fs.existsSync(dritter.audioPath)).toBe(false)
      expect(counted.audio).toBe(3)
      // Und die fehlende Datei wird nicht bei jedem Lauf erneut mitgezaehlt.
      expect(purgeExpired(DEFAULT_TENANT_ID, now)).toEqual({ audio: 0, transcripts: 0 })
    })

    it('loescht keine Datei ausserhalb des Spool-Verzeichnisses', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      const fremd = path.join(tmpDir, 'nicht-im-spool.wav')
      fs.writeFileSync(fremd, 'fremde Datei')
      const manipuliert = makeJob('manipuliert', { ageDays: 10, audioPath: fremd })
      // Positivkontrolle im selben Lauf: ein regulaerer Job derselben Frist.
      const regulaer = makeJob('regulaer', { ageDays: 10 })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(fs.existsSync(fremd)).toBe(true)
      expect(fs.existsSync(regulaer.audioPath)).toBe(false)
      expect(counted.audio).toBe(1)
      // Verweigert heisst nicht erledigt: der Job bleibt faellig.
      expect(purgeExpired(DEFAULT_TENANT_ID, now).audio).toBe(0)
      expect(fs.existsSync(fremd)).toBe(true)
    })

    it('folgt keinem Symlink aus dem Spool-Verzeichnis heraus', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
      const ziel = path.join(tmpDir, 'ziel-ausserhalb.wav')
      fs.writeFileSync(ziel, 'Datei ausserhalb des Spools')
      const link = path.join(spoolDir, 'verweis.wav')
      fs.symlinkSync(ziel, link)
      makeJob('mit-symlink', { ageDays: 10, audioPath: link })
      const regulaer = makeJob('regulaer', { ageDays: 10 })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(fs.existsSync(ziel)).toBe(true)
      expect(fs.existsSync(link)).toBe(true)
      // Positivkontrolle: der regulaere Job im selben Lauf ist weg.
      expect(fs.existsSync(regulaer.audioPath)).toBe(false)
      expect(counted.audio).toBe(1)
    })

    it('raeumt keinen Job eines anderen Mandanten auf', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      const eigener = makeJob('eigener', { ageDays: 10 })
      const fremder = makeJob('fremder', {
        ageDays: 10,
        tenantId: FOREIGN_TENANT,
        workspaceId: 'ws1'
      })

      const counted = purgeExpired(DEFAULT_TENANT_ID, now)

      expect(counted).toEqual({ audio: 1, transcripts: 1 })
      expect(fs.existsSync(eigener.audioPath)).toBe(false)
      expect(fs.existsSync(fremder.audioPath)).toBe(true)
      expect(segmentCount(fremder.id)).toBe(1)
    })

    it('weist eine unbrauchbare Uhrzeit zurueck, statt nichts zu tun', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      const job = makeJob('alt', { ageDays: 10 })

      expect(() => purgeExpired(DEFAULT_TENANT_ID, Number.NaN)).toThrow()
      expect(fs.existsSync(job.audioPath)).toBe(true)

      // Positivkontrolle im selben Lauf: mit brauchbarer Uhrzeit greift es.
      expect(purgeExpired(DEFAULT_TENANT_ID, now).audio).toBe(1)
    })

    it('schreibt je Loeschung einen Audit-Eintrag ohne Transkripttext', () => {
      setRetention('ws1', { audioDays: 7, transcriptDays: 7 })
      const job = makeJob('mit-audit', { ageDays: 10, transcript: 'Streng vertraulicher Satz' })

      purgeExpired(DEFAULT_TENANT_ID, now)

      const entries = auditEntries(DEFAULT_TENANT_ID).filter((e) => e.entity_id === job.id)
      const actions = entries.map((e) => e.action)
      expect(actions).toContain('transcription.audio_purged')
      expect(actions).toContain('transcription.transcript_purged')
      expect(JSON.stringify(entries)).not.toContain('Streng vertraulicher Satz')
    })
  })

  // ── deleteJob ──────────────────────────────────────────────────

  describe('deleteJob', () => {
    it('loescht auch ohne Spool-Verzeichnis, statt die Zeile fuer immer zu behalten', () => {
      // Positive control first, in the same run: with the spool configured the
      // recording goes and the entry says so.
      const removed = makeJob('mit-spool')
      deleteJob(removed.id, DEFAULT_TENANT_ID)
      expect(fs.existsSync(removed.audioPath)).toBe(false)
      expect(detailsOfDeletion(removed.id).recordingKept).toBe(false)

      // One variable: no spool directory. `enqueue` records a refused job in
      // exactly this state, and that row carries the user's own recording
      // path - so a refusal here would keep that filename for good.
      const kept = makeJob('ohne-spool')
      vi.stubEnv('TRANSCRIPTION_SPOOL_DIR', '')

      expect(() => deleteJob(kept.id, DEFAULT_TENANT_ID)).not.toThrow()
      expect(jobExists(kept.id)).toBe(false)
      expect(segmentCount(kept.id)).toBe(0)
      // The file cannot be shown to be ours, so it stays - and the entry says
      // that too, instead of claiming a deletion that did not happen.
      expect(fs.existsSync(kept.audioPath)).toBe(true)
      expect(detailsOfDeletion(kept.id).recordingKept).toBe(true)
    })

    it('loescht Audiodatei, Job und Segmente, aber NICHT den Audit-Eintrag', () => {
      const job = makeJob('zu-loeschen')
      getActivityLogger().log({
        actorType: 'system',
        actorId: 'transcription-job-runner',
        action: 'transcription.queued',
        entityType: 'transcription_job',
        entityId: job.id,
        tenantId: DEFAULT_TENANT_ID,
        details: { workspaceId: 'ws1' }
      })

      deleteJob(job.id, DEFAULT_TENANT_ID)

      expect(fs.existsSync(job.audioPath)).toBe(false)
      expect(TranscriptionModel.getSegments(job.id, DEFAULT_TENANT_ID)).toHaveLength(0)
      expect(jobExists(job.id)).toBe(false)
      const queued = auditEntries(DEFAULT_TENANT_ID).filter(
        (e) => e.entity_id === job.id && e.action === 'transcription.queued'
      )
      expect(queued).toHaveLength(1)
    })

    it('schreibt einen Audit-Eintrag ueber die Loeschung, ohne Transkripttext', () => {
      const job = makeJob('mit-audit', { transcript: 'Streng vertraulicher Satz' })

      deleteJob(job.id, DEFAULT_TENANT_ID)

      const deleted = auditEntries(DEFAULT_TENANT_ID).filter(
        (e) => e.entity_id === job.id && e.action === 'transcription.deleted'
      )
      expect(deleted).toHaveLength(1)
      expect(JSON.stringify(deleted)).not.toContain('Streng vertraulicher Satz')
    })

    it('loescht keinen Job eines anderen Mandanten', () => {
      const job = makeJob('fremder', { tenantId: FOREIGN_TENANT })

      expect(() => deleteJob(job.id, DEFAULT_TENANT_ID)).toThrow()

      expect(fs.existsSync(job.audioPath)).toBe(true)
      expect(TranscriptionModel.getSegments(job.id, FOREIGN_TENANT)).toHaveLength(1)
      expect(jobExists(job.id)).toBe(true)

      // Positivkontrolle im selben Lauf: der Eigentuemer darf.
      deleteJob(job.id, FOREIGN_TENANT)
      expect(jobExists(job.id)).toBe(false)
      expect(fs.existsSync(job.audioPath)).toBe(false)
    })

    it('loescht auch dann, wenn die Audiodatei schon weg ist', () => {
      const job = makeJob('ohne-datei')
      fs.rmSync(job.audioPath)

      expect(() => deleteJob(job.id, DEFAULT_TENANT_ID)).not.toThrow()

      expect(jobExists(job.id)).toBe(false)
      expect(segmentCount(job.id)).toBe(0)
    })

    it('loescht den Auftrag, laesst aber eine Aufnahme ausserhalb des Spools liegen', () => {
      // Das ist kein Sonderfall: eine vor dem Kopieren abgelehnte Aufnahme
      // bekommt die Zeile mit dem ORIGINALPFAD des Nutzers (`refuse` im
      // job-runner). Mingly loescht dessen eigene Datei nicht - der Auftrag
      // selbst muss aber loeschbar bleiben, sonst sind Zeile, Zustand und
      // Audit-Spur fuer immer da.
      const eigeneDateiDesNutzers = path.join(tmpDir, 'nicht-im-spool.wav')
      fs.writeFileSync(eigeneDateiDesNutzers, 'Aufnahme des Nutzers')
      const job = makeJob('abgelehnt', { audioPath: eigeneDateiDesNutzers })

      deleteJob(job.id, DEFAULT_TENANT_ID)

      expect(fs.existsSync(eigeneDateiDesNutzers)).toBe(true)
      expect(jobExists(job.id)).toBe(false)
      expect(segmentCount(job.id)).toBe(0)
    })

    it('folgt beim Loeschen keinem Symlink aus dem Spool heraus', () => {
      const ziel = path.join(tmpDir, 'ziel-ausserhalb.wav')
      fs.writeFileSync(ziel, 'Datei ausserhalb des Spools')
      const link = path.join(spoolDir, 'verweis.wav')
      fs.symlinkSync(ziel, link)
      const job = makeJob('mit-symlink', { audioPath: link })
      const regulaer = makeJob('regulaer')

      deleteJob(job.id, DEFAULT_TENANT_ID)

      expect(fs.existsSync(ziel)).toBe(true)
      expect(fs.existsSync(link)).toBe(true)
      expect(jobExists(job.id)).toBe(false)

      // Positivkontrolle im selben Lauf: eine echte Spool-Kopie wird sehr wohl
      // geloescht - ohne sie bestuende dieser Test auch gegen eine Fassung,
      // die ueberhaupt keine Datei anfasst.
      deleteJob(regulaer.id, DEFAULT_TENANT_ID)
      expect(fs.existsSync(regulaer.audioPath)).toBe(false)
    })

    it('loescht die Zeile NICHT, wenn die Spool-Kopie nicht entfernt werden kann', () => {
      // Die Zeile ist das Einzige, was auf die Spool-Kopie zeigt. Faellt sie
      // weg, waehrend die Aufnahme liegen bleibt, ist die Aufnahme von innen
      // nicht mehr auffindbar - genau darum geht die Datei zuerst und die
      // Zeile danach.
      const unterverzeichnis = path.join(spoolDir, 'gesperrt')
      fs.mkdirSync(unterverzeichnis)
      const audio = path.join(unterverzeichnis, 'unloeschbar.wav')
      fs.writeFileSync(audio, 'Spool-Kopie')
      const job = makeJob('unloeschbar', { audioPath: audio })
      fs.chmodSync(unterverzeichnis, 0o500)

      try {
        expect(() => deleteJob(job.id, DEFAULT_TENANT_ID)).toThrow()

        expect(fs.existsSync(audio)).toBe(true)
        expect(jobExists(job.id)).toBe(true)
        expect(segmentCount(job.id)).toBe(1)
      } finally {
        fs.chmodSync(unterverzeichnis, 0o700)
      }

      // Positivkontrolle im selben Lauf: sobald das Verzeichnis wieder
      // beschreibbar ist, geht dieselbe Loeschung durch.
      deleteJob(job.id, DEFAULT_TENANT_ID)
      expect(fs.existsSync(audio)).toBe(false)
      expect(jobExists(job.id)).toBe(false)
    })

    it('meldet einen unbekannten Auftrag, statt still nichts zu tun', () => {
      const vorhanden = makeJob('vorhanden')

      expect(() => deleteJob('gibt-es-nicht', DEFAULT_TENANT_ID)).toThrow()

      // Positivkontrolle im selben Lauf.
      deleteJob(vorhanden.id, DEFAULT_TENANT_ID)
      expect(jobExists(vorhanden.id)).toBe(false)
    })
  })
})
