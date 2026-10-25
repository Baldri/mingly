/**
 * TranscriptionModel tests.
 * Uses a real sql.js database in a temp directory (no mocks): tenant isolation,
 * ordering, foreign keys and the atomicity of saveSegments only mean something
 * against a real SQL engine.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  initializeDatabase,
  closeDatabase,
  getDatabase,
  getSchemaVersion,
  dbAll,
  dbGet,
  DEFAULT_TENANT_ID
} from '../../src/main/database/index'
import {
  TranscriptionModel,
  type TranscriptionSegment
} from '../../src/main/database/models/transcription'
import { configureLogger } from '../../src/shared/logger'

// First migration that creates the transcription tables. Later migrations raise
// the version further, so tests assert "at least" instead of pinning the latest.
const TRANSCRIPTION_MIGRATION_VERSION = 12

function segment(jobId: string, index: number, text: string): TranscriptionSegment {
  return { jobId, index, startMs: index * 1000, endMs: index * 1000 + 900, speaker: `S${index}`, text }
}

describe('TranscriptionModel', () => {
  let tmpDir: string

  beforeAll(() => {
    // Migration progress is logged at info level; keep the test output clean
    configureLogger({ level: 'error' })
  })

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-transcription-'))
    await initializeDatabase(tmpDir)
  })

  afterEach(() => {
    vi.useRealTimers()
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('createJob', () => {
    it('erzeugt einen Job im Zustand queued mit Fortschritt 0', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')

      expect(job).toMatchObject({
        tenantId: 'tenant-a',
        workspaceId: 'ws1',
        audioPath: '/a.wav',
        targetId: 'local',
        state: 'queued',
        progress: 0
      })
      expect(job.id).not.toBe('')
      expect(job.error).toBeUndefined()
      expect(job.updatedAt).toBe(job.createdAt)
    })

    it('persistiert den Job so, wie er zurückgegeben wurde', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')

      expect(TranscriptionModel.listByState('queued', 'tenant-a')).toEqual([job])
    })

    it('vergibt für jeden Job eine eigene Kennung', () => {
      const first = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      const second = TranscriptionModel.createJob('tenant-a', 'ws1', '/b.wav', 'local')

      expect(first.id).not.toBe(second.id)
    })
  })

  describe('listByState', () => {
    it('gibt Jobs eines anderen Mandanten NICHT zurück', () => {
      TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')

      // Positive control: the job is visible to its own tenant, so the empty
      // result for tenant-b really comes from the tenant filter.
      expect(TranscriptionModel.listByState('queued', 'tenant-a')).toHaveLength(1)
      expect(TranscriptionModel.listByState('queued', 'tenant-b')).toHaveLength(0)
    })

    it('filtert nach Zustand', () => {
      const queued = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      const running = TranscriptionModel.createJob('tenant-a', 'ws1', '/b.wav', 'local')
      TranscriptionModel.setState(running.id, 'running')

      expect(TranscriptionModel.listByState('queued', 'tenant-a').map(j => j.id)).toEqual([queued.id])
      expect(TranscriptionModel.listByState('running', 'tenant-a').map(j => j.id)).toEqual([running.id])
      expect(TranscriptionModel.listByState('done', 'tenant-a')).toEqual([])
    })

    it('liefert die ältesten Jobs zuerst (Warteschlangen-Reihenfolge)', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(3000)
      const late = TranscriptionModel.createJob('tenant-a', 'ws1', '/late.wav', 'local')
      vi.setSystemTime(1000)
      const early = TranscriptionModel.createJob('tenant-a', 'ws1', '/early.wav', 'local')
      vi.setSystemTime(2000)
      const middle = TranscriptionModel.createJob('tenant-a', 'ws1', '/middle.wav', 'local')

      expect(TranscriptionModel.listByState('queued', 'tenant-a').map(j => j.id)).toEqual([
        early.id,
        middle.id,
        late.id
      ])
    })
  })

  describe('setState', () => {
    it('setzt bei failed eine Fehlermeldung', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')

      TranscriptionModel.setState(job.id, 'failed', 'Audiodatei ist leer')

      expect(TranscriptionModel.listByState('queued', 'tenant-a')).toHaveLength(0)
      const failed = TranscriptionModel.listByState('failed', 'tenant-a')
      expect(failed).toHaveLength(1)
      expect(failed[0].state).toBe('failed')
      expect(failed[0].error).toBe('Audiodatei ist leer')
    })

    it('löscht die Fehlermeldung bei einem Zustandswechsel ohne Fehler', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      TranscriptionModel.setState(job.id, 'failed', 'Dienst nicht erreichbar')

      TranscriptionModel.setState(job.id, 'queued')

      const requeued = TranscriptionModel.listByState('queued', 'tenant-a')
      expect(requeued).toHaveLength(1)
      expect(requeued[0].error).toBeUndefined()
    })

    it('führt updatedAt nach, lässt createdAt unverändert', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1000)
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')

      vi.setSystemTime(5000)
      TranscriptionModel.setState(job.id, 'running')

      const [running] = TranscriptionModel.listByState('running', 'tenant-a')
      expect(running.createdAt).toBe(1000)
      expect(running.updatedAt).toBe(5000)
    })
  })

  describe('setProgress', () => {
    it('speichert den Fortschritt und führt updatedAt nach', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1000)
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')

      vi.setSystemTime(2000)
      TranscriptionModel.setProgress(job.id, 0.42)

      const [stored] = TranscriptionModel.listByState('queued', 'tenant-a')
      expect(stored.progress).toBe(0.42)
      expect(stored.updatedAt).toBe(2000)
      expect(stored.state).toBe('queued')
    })
  })

  describe('saveSegments / getSegments', () => {
    it('speichert Segmente und liest sie in Reihenfolge zurück', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      // Deliberately saved out of order: the order on read comes from `index`,
      // not from insertion order.
      const segments = [segment(job.id, 2, 'drittes'), segment(job.id, 0, 'erstes'), segment(job.id, 1, 'zweites')]

      TranscriptionModel.saveSegments(job.id, segments)

      expect(TranscriptionModel.getSegments(job.id, 'tenant-a')).toEqual([
        segment(job.id, 0, 'erstes'),
        segment(job.id, 1, 'zweites'),
        segment(job.id, 2, 'drittes')
      ])
    })

    it('gibt Segmente eines anderen Mandanten NICHT zurück', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      TranscriptionModel.saveSegments(job.id, [segment(job.id, 0, 'vertraulich')])

      // Positive control, see listByState
      expect(TranscriptionModel.getSegments(job.id, 'tenant-a')).toHaveLength(1)
      expect(TranscriptionModel.getSegments(job.id, 'tenant-b')).toEqual([])
    })

    it('ordnet Segmente dem Mandanten ihres Jobs zu', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')

      TranscriptionModel.saveSegments(job.id, [segment(job.id, 0, 'a'), segment(job.id, 1, 'b')])

      expect(dbAll('SELECT DISTINCT tenant_id FROM transcription_segments WHERE job_id = ?', [job.id])).toEqual([
        { tenant_id: 'tenant-a' }
      ])
    })

    it('ersetzt vorhandene Segmente, statt sie zu verdoppeln oder abzulehnen', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      TranscriptionModel.saveSegments(job.id, [segment(job.id, 0, 'alt'), segment(job.id, 1, 'alt')])

      // Second save for the same job: a run that crashed between saving the
      // segments and marking the job done saves again after the resume.
      TranscriptionModel.saveSegments(job.id, [segment(job.id, 0, 'neu')])

      expect(TranscriptionModel.getSegments(job.id, 'tenant-a')).toEqual([segment(job.id, 0, 'neu')])
    })

    it('lässt die bisherigen Segmente unverändert, wenn das Speichern fehlschlägt', () => {
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      TranscriptionModel.saveSegments(job.id, [segment(job.id, 0, 'alt'), segment(job.id, 1, 'alt')])

      // Duplicate index violates the primary key halfway through the insert.
      expect(() =>
        TranscriptionModel.saveSegments(job.id, [segment(job.id, 0, 'neu'), segment(job.id, 0, 'doppelt')])
      ).toThrow()

      expect(TranscriptionModel.getSegments(job.id, 'tenant-a')).toEqual([
        segment(job.id, 0, 'alt'),
        segment(job.id, 1, 'alt')
      ])
    })

    it('verweigert Segmente für einen unbekannten Job', () => {
      expect(() => TranscriptionModel.saveSegments('gibt-es-nicht', [segment('gibt-es-nicht', 0, 'x')])).toThrow(
        /gibt-es-nicht/
      )
      expect(dbGet('SELECT COUNT(*) AS count FROM transcription_segments')).toEqual({ count: 0 })
    })

    it('trennt die Segmente verschiedener Jobs', () => {
      const first = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      const second = TranscriptionModel.createJob('tenant-a', 'ws1', '/b.wav', 'local')
      TranscriptionModel.saveSegments(first.id, [segment(first.id, 0, 'eins')])
      TranscriptionModel.saveSegments(second.id, [segment(second.id, 0, 'zwei')])

      expect(TranscriptionModel.getSegments(first.id, 'tenant-a').map(s => s.text)).toEqual(['eins'])
      expect(TranscriptionModel.getSegments(second.id, 'tenant-a').map(s => s.text)).toEqual(['zwei'])
    })
  })

  describe('Schema', () => {
    it('trägt die Mandanten-Kennung auf beiden Tabellen (TEXT NOT NULL DEFAULT \'default\')', () => {
      for (const table of ['transcription_jobs', 'transcription_segments']) {
        const col = (dbAll(`PRAGMA table_info(${table})`) as Array<Record<string, unknown>>).find(
          c => c.name === 'tenant_id'
        )
        expect(col, table).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: `'${DEFAULT_TENANT_ID}'` })
      }
    })

    it('erhöht schema_version auf mindestens 12', () => {
      expect(getSchemaVersion(getDatabase())).toBeGreaterThanOrEqual(TRANSCRIPTION_MIGRATION_VERSION)
    })

    // These two tests check that the DDL declares the foreign key and the
    // cascade. They switch enforcement on themselves: sql.js resets
    // PRAGMA foreign_keys on every export() (i.e. every saveDatabase()), so the
    // running application does not enforce it. Once that is fixed in
    // database/index.ts, the explicit PRAGMA below becomes redundant.
    describe('Fremdschlüssel-Deklaration', () => {
      beforeEach(() => {
        getDatabase().run('PRAGMA foreign_keys = ON')
      })

      it('weist ein Segment ohne zugehörigen Job ab', () => {
        expect(() =>
          getDatabase().run(
            `INSERT INTO transcription_segments (job_id, tenant_id, segment_index, start_ms, end_ms, speaker, text)
             VALUES ('ohne-job', 'tenant-a', 0, 0, 1, 'S0', 'x')`
          )
        ).toThrow(/FOREIGN KEY/i)
      })

      it('löscht die Segmente mit ihrem Job (ON DELETE CASCADE)', () => {
        const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
        TranscriptionModel.saveSegments(job.id, [segment(job.id, 0, 'a')])

        getDatabase().run('DELETE FROM transcription_jobs WHERE id = ?', [job.id])

        expect(TranscriptionModel.getSegments(job.id, 'tenant-a')).toEqual([])
      })
    })

    it('legt die Tabellen beim Upgrade einer Datenbank auf Version 11 an', async () => {
      // Build a genuine version-11 database: drop the new tables again and stamp
      // the old version. The next initializeDatabase() has to upgrade it.
      const legacy = getDatabase()
      legacy.run('DROP TABLE transcription_segments')
      legacy.run('DROP TABLE transcription_jobs')
      legacy.run("UPDATE _meta SET value = '11' WHERE key = 'schema_version'")
      closeDatabase()

      await initializeDatabase(tmpDir)

      expect(getSchemaVersion(getDatabase())).toBeGreaterThanOrEqual(TRANSCRIPTION_MIGRATION_VERSION)
      const job = TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
      expect(TranscriptionModel.listByState('queued', 'tenant-a')).toEqual([job])
    })
  })
})
