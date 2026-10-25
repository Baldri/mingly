# Transkription Stufe 1 — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine Audiodatei wird in Mingly zu einem Transkript mit Sprechern und
Zeitstempeln, ohne dass die Datei das vom Arbeitsbereich erklaerte Rechtsgebiet
verlaesst.

**Architecture:** Ein schlanker Python-Dienst uebernimmt die WhisperX-Pipeline aus
TranscriboZH (MIT) und wird ueber HTTP angesprochen — dasselbe Muster wie der
vorhandene RAG-Server (`src/main/rag/rag-http-client.ts`). Der Main-Prozess haelt
Jobs in SQLite, entscheidet per Residenz-Policy, welches Transkriptionsziel erlaubt
ist, und liefert Ergebnisse ueber IPC an den Renderer. Die Residenz fuer Audio wird
**deklariert** (Arbeitsbereich), nicht aus dem Inhalt klassifiziert — Begruendung in
Abschnitt 4 der Spec.

**Tech Stack:** TypeScript (strict, keine `any`), Electron Main, sql.js, vitest ·
Python 3.13 mit FastAPI, WhisperX 3.2.0, pyannote.audio 3.1.1

**Spec:** `docs/superpowers/specs/2026-10-25-transkriptions-service-design.md`
(Messbelege: `docs/superpowers/specs/2026-10-25-whisper-messung.md`)

**Nicht in diesem Plan** (eigene Subsysteme, eigene Plaene): der audiosynchrone
Editor, die mobile Aufnahme, der von digital opua betriebene Dienst (Stufe 2).

## Global Constraints

- TypeScript strict, **keine `any`-Typen**; camelCase fuer Variablen/Funktionen,
  PascalCase fuer Typen und Klassen.
- Python: Type hints fuer alle Funktionen, Pydantic fuer Datenmodelle, snake_case.
- Tailwind fuer Styling, kein CSS-in-JS.
- Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`).
- **Jede** Tabelle und **jeder** Audit-Eintrag traegt eine Mandanten-Kennung, auch
  wenn Stufe 1 pro Installation genau einen Mandanten hat (Spec 10.2, Punkt 1).
- Der uebernommene TranscriboZH-Code behaelt seinen MIT-Copyright-Hinweis.
- `--max-context 0` beziehungsweise der `get_prompt`-Patch ist **nicht optional** —
  ohne ihn liegt die Fehlerrate bei 46 % statt 6 % (Messreport Abschnitt 4.1).
- Serverstandort Europa: der Python-Dienst laeuft `on-device` oder in der
  Infrastruktur des Kunden, niemals bei einem Dritten ausserhalb der Policy.

## Review Focus

Fuenf Eingaben, die die Spec voraussetzt, ohne dass ein Task sie von sich aus
pruefen wuerde. Jede Zeile hat ihren Test im zugehoerigen Task.

1. **Leere oder beschaedigte Audiodatei** — der Job muss mit klarer Meldung
   scheitern, nicht haengen bleiben (Task 6).
2. **Arbeitsbereich ohne erklaerte Schutzstufe** — muss auf die **strenge** Seite
   fallen (`critical`), nicht auf die bequeme (Task 4).
3. **Transkriptionsdienst nicht erreichbar** — der Job bleibt `queued` und wird
   wieder aufgenommen; kein stiller Verlust (Task 6).
4. **Altdaten ohne Mandanten-Kennung nach der Migration** — duerfen nicht leise
   einem fremden Mandanten zufallen (Task 1).
5. **Aufnahme ueber einer Stunde** — der Job darf nicht an einem Timeout sterben,
   nachdem schon 40 Minuten gerechnet wurde (Task 6).

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/main/database/models/transcription.ts` | Job- und Segment-Persistenz, `TranscriptionModel` |
| `src/main/transcription/transcription-http-client.ts` | HTTP-Zugriff auf den Python-Dienst |
| `src/main/transcription/transcription-targets.ts` | Transkriptionsziele als `RegistryEntry` mit Residenz |
| `src/main/transcription/audio-residency.ts` | deklarierte Schutzstufe → erlaubtes Ziel (nutzt `policy-engine`) |
| `src/main/transcription/job-runner.ts` | Warteschlange, Zustaende, Fortschritt, Wiederaufnahme |
| `src/main/ipc/transcription-handlers.ts` | IPC-Oberflaeche |
| `transcription-server/server.py` | FastAPI-Dienst |
| `transcription-server/pipeline.py` | uebernommene TranscriboZH-Pipeline (MIT) |
| `transcription-server/const.py` | uebernommene `data_leaks`-Liste (MIT) |

---

### Task 1: Mandanten-Kennung im Datenmodell

**Files:**
- Modify: `src/main/database/index.ts` (Migration auf `schema_version` 2)
- Test: `tests/unit/database-tenant-migration.test.ts`

**Interfaces:**
- Consumes: `runMigrations`, `getSchemaVersion`, `setSchemaVersion`, `dbRun`, `dbAll`
- Produces: Spalte `tenant_id TEXT NOT NULL DEFAULT 'default'` auf allen elf
  bestehenden Tabellen; Konstante `export const DEFAULT_TENANT_ID = 'default'`

- [ ] **Step 1: Write the failing tests**

```typescript
it('legt tenant_id auf allen Tabellen an', () => {
  initializeDatabase(tmpPath)
  for (const table of ['conversations','messages','settings','tracking_events',
      'message_attachments','prompt_templates','comparison_sessions',
      'comparison_results','conversation_sessions','activity_log']) {
    const cols = dbAll(`PRAGMA table_info(${table})`) as { name: string }[]
    expect(cols.map(c => c.name)).toContain('tenant_id')
  }
})

it('ordnet Altdaten dem Default-Mandanten zu, nicht NULL', () => {
  // Datenbank auf schema_version 1 mit einer Konversation vorbereiten,
  // dann migrieren
  expect(dbGet('SELECT tenant_id FROM conversations')).toEqual({ tenant_id: 'default' })
})

it('erhoeht schema_version auf 2', () => {
  expect(getSchemaVersion(db)).toBe(2)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/database-tenant-migration.test.ts`
Expected: FAIL — `tenant_id` nicht in `table_info`

- [ ] **Step 3: Migration auf Version 2 in `runMigrations` ergaenzen**

`ALTER TABLE … ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'` je Tabelle,
dem bestehenden Versionsschema folgend. `DEFAULT 'default'` ist der Grund, dass
Altdaten nicht `NULL` werden — Review-Focus 4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/database-tenant-migration.test.ts` · Expected: PASS
Run: `npm run typecheck` · Expected: Exit 0

- [ ] **Step 5: Commit**

```bash
git add src/main/database/index.ts tests/unit/database-tenant-migration.test.ts
git commit -m "feat(db): Mandanten-Kennung auf allen Tabellen"
```

---

### Task 2: Job- und Segment-Modell

**Files:**
- Create: `src/main/database/models/transcription.ts`
- Modify: `src/main/database/index.ts` (Migration auf `schema_version` 3)
- Test: `tests/unit/transcription-model.test.ts`

**Interfaces:**
- Consumes: `dbRun`, `dbAll`, `dbGet`, `scheduleSave`, `generateId`, `DEFAULT_TENANT_ID`
- Produces:
  ```typescript
  export type TranscriptionJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  export interface TranscriptionJob {
    id: string; tenantId: string; workspaceId: string; audioPath: string
    state: TranscriptionJobState; progress: number; targetId: string
    error?: string; createdAt: number; updatedAt: number
  }
  export interface TranscriptionSegment {
    jobId: string; index: number; startMs: number; endMs: number
    speaker: string; text: string
  }
  export class TranscriptionModel {
    static createJob(tenantId: string, workspaceId: string, audioPath: string, targetId: string): TranscriptionJob
    static setState(id: string, state: TranscriptionJobState, error?: string): void
    static setProgress(id: string, progress: number): void
    static listByState(state: TranscriptionJobState, tenantId: string): TranscriptionJob[]
    static saveSegments(jobId: string, segments: TranscriptionSegment[]): void
    static getSegments(jobId: string, tenantId: string): TranscriptionSegment[]
  }
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
it('erzeugt einen Job im Zustand queued mit Fortschritt 0', () => { … })
it('speichert Segmente und liest sie in Reihenfolge zurueck', () => { … })
it('gibt Jobs eines anderen Mandanten NICHT zurueck', () => {
  TranscriptionModel.createJob('tenant-a', 'ws1', '/a.wav', 'local')
  expect(TranscriptionModel.listByState('queued', 'tenant-b')).toHaveLength(0)
})
it('setzt bei failed eine Fehlermeldung', () => { … })
```

- [ ] **Step 2: Run tests to verify they fail** — Run: `npx vitest run tests/unit/transcription-model.test.ts` · Expected: FAIL (Modul fehlt)

- [ ] **Step 3: Modell und Migration auf Version 3 implementieren**

Tabellen `transcription_jobs` und `transcription_segments`, beide mit `tenant_id`.
Fremdschluessel `transcription_segments.job_id → transcription_jobs.id`
(`PRAGMA foreign_keys` ist an). Nach jeder Schreiboperation `scheduleSave()`,
wie in den bestehenden Modellen.

- [ ] **Step 4: Run tests and typecheck** — beide Expected: PASS / Exit 0

- [ ] **Step 5: Commit** — `feat(db): Transkriptions-Jobs und -Segmente`

---

### Task 3: Python-Dienst mit der uebernommenen Pipeline

**Files:**
- Create: `transcription-server/pipeline.py`, `transcription-server/const.py`,
  `transcription-server/server.py`, `transcription-server/requirements.txt`,
  `transcription-server/README.md`
- Test: `transcription-server/tests/test_pipeline.py`

**Interfaces:**
- Produces: `POST /transcribe` → `{ "job_id": str }`, `GET /jobs/{job_id}` →
  `{ "state": str, "progress": float, "segments": [{"start_ms": int,
  "end_ms": int, "speaker": str, "text": str}] }`, `GET /health` →
  `{ "status": str, "model_loaded": bool, "device": str }`

- [ ] **Step 1: Pipeline und `data_leaks` aus TranscriboZH uebernehmen**

Quelle: `github.com/machinelearningZH/audio-transcription` (MIT), Dateien
`src/transcription.py` und `data/const.py`. **Mitnehmen:** die fuenfstufige
Pipeline, die `data_leaks`-Liste und den `get_prompt`-Patch (im Original in
`worker.py:258` per `types.MethodType` eingehaengt). **Nicht** mitnehmen: NiceGUI,
die Qwen-Zusammenfassung, die dateisystembasierte Warteschlange.
MIT-Copyright-Hinweis in den Dateikopf.

- [ ] **Step 2: Write the failing test**

```python
def test_get_prompt_laesst_previous_tokens_weg_ohne_prefix():
    """Der Kern des Patches: ohne Hotwords kein Kontext aus dem Vorsegment.
    Ohne das liegt die Fehlerrate bei 46 % statt 6 % (Messreport 4.1)."""
    prompt = get_prompt(FakeModel(), FakeTokenizer(), previous_tokens=[1, 2, 3],
                        without_timestamps=True, prefix=None)
    assert 1 not in prompt and 2 not in prompt and 3 not in prompt

def test_data_leaks_entfernt_zdf_halluzination():
    seg = {"text": " Untertitel im Auftrag des ZDF, 2017"}
    assert clean_segments([seg], "de") == []
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd transcription-server && python3 -m pytest tests/test_pipeline.py -v`
Expected: FAIL (Modul fehlt)

- [ ] **Step 4: FastAPI-Dienst implementieren**

`transcribe(audio_path: str, num_speakers: int | None, language: str = "de") -> list[Segment]`
in `pipeline.py`; `server.py` haelt Jobs im Speicher und laedt die Modelle **einmal
beim Start** (nicht pro Anfrage). Genau **ein** Worker pro Prozess — mehr als einer
sprengt das VRAM (Spec 10.3).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd transcription-server && python3 -m pytest tests/ -v` · Expected: PASS
(**nicht** `rtk pytest` — meldet "No tests collected", obwohl Tests rot sind)

- [ ] **Step 6: Commit** — `feat(transcription): Python-Dienst mit WhisperX-Pipeline`

---

### Task 4: Transkriptionsziele und deklarierte Residenz

**Files:**
- Create: `src/main/transcription/transcription-targets.ts`,
  `src/main/transcription/audio-residency.ts`
- Test: `tests/unit/audio-residency.test.ts`

**Interfaces:**
- Consumes: `evaluate` und `DEFAULT_POLICY` aus `src/main/policy/policy-engine`,
  `Classification` aus `policy-types`, `RegistryEntry` aus `routing/provider-registry`,
  `PIISensitivity` aus `privacy/pii-types`
- Produces:
  ```typescript
  export const TRANSCRIPTION_TARGETS: RegistryEntry[]   // 'local' = on-device, 'ch-endpoint' = CH
  export function resolveTarget(declaredLevel: PIISensitivity | undefined,
    policy: PolicySet): { allowed: true; targetId: string } | { allowed: false; reason: string }
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
it('erlaubt das lokale Ziel fuer critical', () => {
  expect(resolveTarget('critical', DEFAULT_POLICY)).toEqual({ allowed: true, targetId: 'local' })
})

it('faellt ohne erklaerte Stufe auf critical, nicht auf low', () => {
  // Review-Focus 2: Voreinstellung auf der strengen Seite
  expect(resolveTarget(undefined, DEFAULT_POLICY)).toEqual({ allowed: true, targetId: 'local' })
})

it('nennt bei verbotenem Ziel einen Grund mit Policy-Version', () => {
  const res = resolveTarget('critical', POLICY_NUR_US)
  expect(res.allowed).toBe(false)
  expect(res.reason).toContain(POLICY_NUR_US.version)
})
```

- [ ] **Step 2: Run tests to verify they fail** — Expected: FAIL (Modul fehlt)

- [ ] **Step 3: Implementieren**

`resolveTarget` baut eine `Classification` mit
`reason: 'declared by workspace'` und ruft `evaluate`. Der Policy-Kern bleibt
**unveraendert** — das ist der Kern der Entscheidung in Spec Abschnitt 4.
`bySource` bleibt auf Null, wie `residency-guard.ts` es fuer abgeleitete Stufen
vormacht: nicht erfundene Zahlen, sondern null.

- [ ] **Step 4: Run tests and typecheck** — Expected: PASS / Exit 0

- [ ] **Step 5: Commit** — `feat(transcription): Residenz-Policy fuer Audio`

---

### Task 5: HTTP-Client zum Dienst

**Files:**
- Create: `src/main/transcription/transcription-http-client.ts`
- Test: `tests/unit/transcription-http-client.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface TranscriptionServerConfig { host: string; port: number; protocol: 'http' | 'https' }
  export interface TranscriptionHealth { status: string; modelLoaded: boolean; device: string }
  export class TranscriptionHttpClient {
    healthCheck(): Promise<TranscriptionHealth>
    submit(audioPath: string, numSpeakers?: number): Promise<{ jobId: string }>
    poll(jobId: string): Promise<{ state: string; progress: number; segments: TranscriptionSegment[] }>
  }
  export function getTranscriptionHttpClient(): TranscriptionHttpClient
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
it('wandelt snake_case der Antwort in camelCase', async () => { … })
it('wirft einen benannten Fehler, wenn der Dienst nicht erreichbar ist', async () => {
  await expect(client.healthCheck()).rejects.toThrow(/nicht erreichbar/)
})
```

Mustervorlage: `src/main/rag/rag-http-client.ts` (gleiche Struktur, Singleton-Zugriff).

- [ ] **Step 2: Run tests to verify they fail** — Expected: FAIL

- [ ] **Step 3: Implementieren** (`fetch`, Zeitlimit je Anfrage, kein Zeitlimit auf den Job)

- [ ] **Step 4: Run tests and typecheck** — Expected: PASS / Exit 0

- [ ] **Step 5: Commit** — `feat(transcription): HTTP-Client zum Transkriptionsdienst`

---

### Task 6: Job-Runner

**Files:**
- Create: `src/main/transcription/job-runner.ts`
- Test: `tests/unit/transcription-job-runner.test.ts`

**Interfaces:**
- Consumes: `TranscriptionModel` (Task 2), `resolveTarget` (Task 4),
  `getTranscriptionHttpClient` (Task 5)
- Produces:
  ```typescript
  export class TranscriptionJobRunner {
    enqueue(tenantId: string, workspaceId: string, audioPath: string,
      declaredLevel?: PIISensitivity): Promise<TranscriptionJob>
    tick(): Promise<void>            // ein Durchlauf, von Tests direkt aufrufbar
    resumeInterrupted(): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing tests** — hier liegen vier der fuenf Review-Focus-Punkte

```typescript
it('setzt den Job auf failed mit Meldung bei leerer Audiodatei', async () => {
  // Review-Focus 1
})
it('laesst den Job queued, wenn der Dienst nicht erreichbar ist', async () => {
  // Review-Focus 3: kein stiller Verlust, Zustand bleibt queued
})
it('nimmt einen beim Absturz running gebliebenen Job wieder auf', async () => {
  // Review-Focus 5: 40 Minuten Rechenzeit duerfen nicht verloren gehen
})
it('bricht einen laufenden Job nicht nach festem Zeitlimit ab', async () => {
  // Review-Focus 5: Fortschritt zaehlt, nicht Wanduhr
})
it('verweigert den Start, wenn resolveTarget kein Ziel erlaubt', async () => { … })
```

- [ ] **Step 2: Run tests to verify they fail** — Expected: FAIL

- [ ] **Step 3: Implementieren**

Audiodatei vor dem Einstellen pruefen (Existenz und Groesse > 0). Kein Zeitlimit auf
den Job; Abbruch nur, wenn der Fortschritt eine konfigurierte Zeit stillsteht.
`resumeInterrupted` setzt beim Start `running` → `queued` zurueck.

- [ ] **Step 4: Audit-Eintrag je Zustandswechsel**

Test zuerst:

```typescript
it('schreibt je Zustandswechsel einen Audit-Eintrag mit Mandant', async () => {
  await runner.enqueue('tenant-a', 'ws1', '/a.wav', 'critical')
  const entries = readAuditEntries('tenant-a')
  expect(entries.map(e => e.event)).toEqual(['transcription.queued'])
  expect(entries[0].tenantId).toBe('tenant-a')
})
```

Dann implementieren, ueber den vorhandenen Schreiber in `src/main/audit/`. Der
Eintrag traegt Mandant, Arbeitsbereich, erklaerte Stufe, gewaehltes Ziel und
Policy-Version — **nie** Transkriptinhalt (Spec Abschnitt 8). Mandantenbezogen,
weil Punkt 5 des Stufenplans es verlangt und es nachtraeglich nicht herstellbar ist.

- [ ] **Step 5: Run tests and typecheck** — Expected: PASS / Exit 0

- [ ] **Step 6: Commit** — `feat(transcription): Job-Runner mit Wiederaufnahme und Audit`

---

### Task 7: IPC-Oberflaeche und Feature-Gate

**Files:**
- Create: `src/main/ipc/transcription-handlers.ts`
- Modify: `src/main/ipc/index.ts` (Registrierung), `src/shared/types.ts`
  (`IPC_CHANNELS`), `src/main/services/feature-gate-manager.ts`
  (`FEATURE_MIN_TIER`, `TIER_LIMITS`)
- Test: `tests/unit/transcription-handlers.test.ts`

**Interfaces:**
- Consumes: `wrapHandler`, `requireFeature` aus `ipc/ipc-utils`, `TranscriptionJobRunner`
- Produces: Kanaele `TRANSCRIPTION_SUBMIT`, `TRANSCRIPTION_STATUS`,
  `TRANSCRIPTION_SEGMENTS`, `TRANSCRIPTION_CANCEL`; `GatedFeature` `'transcription'`;
  Mengengrenze **in Audiominuten pro Monat** (nicht Dateien — Rechenzeit ist der
  Kostentreiber, Spec Abschnitt 9)

- [ ] **Step 1: Write the failing tests**

```typescript
it('verweigert den Zugriff unter der erforderlichen Abo-Stufe', async () => { … })
it('gibt Segmente nur fuer den eigenen Mandanten heraus', async () => { … })
```

- [ ] **Step 2: Run tests to verify they fail** — Expected: FAIL

- [ ] **Step 3: Implementieren** nach dem Muster von `rag-handlers.ts`

- [ ] **Step 4: Run tests and typecheck** — Expected: PASS / Exit 0

- [ ] **Step 5: Commit** — `feat(transcription): IPC-Oberflaeche und Feature-Gate`

---

### Task 8: Export nach txt und SRT

**Files:**
- Modify: `src/main/services/export-service.ts`
- Test: `tests/unit/transcription-export.test.ts`

**Interfaces:**
- Consumes: `TranscriptionSegment` (Task 2)
- Produces: `exportTranscript(segments: TranscriptionSegment[], format: 'txt' | 'srt'): string`

- [ ] **Step 1: Write the failing tests**

```typescript
it('schreibt SRT-Zeitstempel als HH:MM:SS,mmm', () => {
  const srt = exportTranscript([{ jobId:'j', index:0, startMs: 3661500, endMs: 3665000,
    speaker: 'SPEAKER_00', text: 'Guten Tag' }], 'srt')
  expect(srt).toContain('01:01:01,500 --> 01:01:05,000')
})
it('stellt im txt-Format den Sprecher vor den Text', () => { … })
```

- [ ] **Step 2: Run tests to verify they fail** — Expected: FAIL

- [ ] **Step 3: Implementieren** (SRT-Zeitformat ist der einzige nicht offensichtliche Teil)

- [ ] **Step 4: Run full suite and typecheck**

Run: `npm test` · Expected: PASS (alle 91+ Dateien)
Run: `npm run typecheck` · Expected: Exit 0

- [ ] **Step 5: Commit** — `feat(transcription): Export nach txt und SRT`

---

### Task 9: Aufbewahrung und Loeschung pro Arbeitsbereich

**Files:**
- Create: `src/main/transcription/retention.ts`
- Modify: `src/main/ipc/transcription-handlers.ts` (Kanal `TRANSCRIPTION_DELETE`)
- Test: `tests/unit/transcription-retention.test.ts`

**Interfaces:**
- Consumes: `TranscriptionModel` (Task 2), Audit-Schreiber aus `src/main/audit/`
- Produces:
  ```typescript
  export interface RetentionSettings { audioDays: number; transcriptDays: number }
  export function getRetention(workspaceId: string): RetentionSettings
  export function setRetention(workspaceId: string, settings: RetentionSettings): void
  export function purgeExpired(tenantId: string, now: number): { audio: number; transcripts: number }
  export function deleteJob(jobId: string, tenantId: string): void
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
it('loescht Audiodatei, Job und Segmente, aber NICHT den Audit-Eintrag', () => {
  // Spec Abschnitt 8: "Loeschen muss loeschen" - Audio, Transkript,
  // Zwischendateien. Der Audit-Eintrag bleibt, er enthaelt kein Transkript.
  deleteJob(job.id, 'tenant-a')
  expect(fs.existsSync(audioPath)).toBe(false)
  expect(TranscriptionModel.getSegments(job.id, 'tenant-a')).toHaveLength(0)
  expect(readAuditEntries('tenant-a').length).toBeGreaterThan(0)
})

it('loescht keinen Job eines anderen Mandanten', () => {
  expect(() => deleteJob(job.id, 'tenant-b')).toThrow()
  expect(fs.existsSync(audioPath)).toBe(true)
})

it('haelt Fristen pro Arbeitsbereich, nicht global', () => {
  setRetention('ws1', { audioDays: 7, transcriptDays: 365 })
  setRetention('ws2', { audioDays: 30, transcriptDays: 30 })
  expect(getRetention('ws1').audioDays).toBe(7)
})

it('purgeExpired loescht nur Abgelaufenes und zaehlt es', () => { … })
```

- [ ] **Step 2: Run tests to verify they fail** — Expected: FAIL (Modul fehlt)

- [ ] **Step 3: Implementieren**

Fristen pro Arbeitsbereich in `settings` (traegt seit Task 1 `tenant_id`), **nicht**
global — ein Betrieb hat je Kunde andere Fristen, und eine globale Einstellung
muesste in Stufe 2 zerlegt werden (Stufenplan Punkt 4).

- [ ] **Step 4: Run tests and typecheck** — Expected: PASS / Exit 0

- [ ] **Step 5: Commit** — `feat(transcription): Aufbewahrung und Loeschung pro Arbeitsbereich`

---

## Selbstpruefung (durchgefuehrt am 2026-10-25)

- **Spec-Abdeckung:** Luecke gefunden und geschlossen — Spec Abschnitt 8
  (Aufbewahrung, "Loeschen muss loeschen") und Stufenplan-Punkt 5 (mandantenbezogener
  Audit-Pfad) hatten keinen Task. Jetzt Task 9 beziehungsweise Task 6 Schritt 4.
- **Typkonsistenz:** `TranscriptionSegment` (Task 2) wird in Task 5, 8 und 9
  unveraendert verwendet; `resolveTarget` (Task 4) in Task 6; `DEFAULT_TENANT_ID`
  (Task 1) in Task 2.
- **Review Focus:** alle fuenf Punkte haben einen Test — 1, 3 und 5 in Task 6,
  2 in Task 4, 4 in Task 1.
- **Verhaeltnis:** 500 Planzeilen gegen 663 Spec-Zeilen. Der Plan ist kuerzer als
  die Spec, Code-Bloecke sind Testnamen und Signaturen, keine Implementierungen.
- **Offen gelassen, bewusst:** die Modellverwaltung in der Oberflaeche (der
  erstmalige Download der Whisper-Gewichte ist mehrere Gigabyte und braucht eine
  Fortschrittsanzeige). Der Dienst laedt die Modelle beim Start selbst (Task 3);
  die Anzeige gehoert zum Editor-Plan, weil sie Oberflaeche ist.

---

## Was dieser Plan offen laesst

- **Der Hugging-Face-Blocker** (Spec 10.3): Task 3 setzt voraus, dass die
  `pyannote`-Gewichte verfuegbar sind. Ist das zur Umsetzungszeit nicht geklaert,
  laeuft Task 3 ohne Diarisation und gibt `speaker: 'SPEAKER_00'` fuer alle
  Segmente zurueck — die Schnittstelle bleibt gleich, der Wert sinkt.
- **Wer den Python-Dienst startet.** In Stufe 1 lokal: offen, ob der Main-Prozess
  ihn als Kindprozess startet oder der Nutzer ihn startet. Der RAG-Server im Repo
  wird **nicht** von Mingly gestartet (geprueft: kein `spawn` in `src/main/rag/`).
  Fuer "ohne IT-Abteilung" (Spec Abschnitt 2) braucht es den Kindprozess — das ist
  ein neues Muster im Repo und eine Entscheidung fuer den Umsetzer, nicht fuer
  diesen Plan.
- **Zielbranche** (offener Entscheid 5): beeinflusst nur die Oberflaeche, keinen
  Task hier.
