# piiranha-v1 NER Layer — Design Spec (Phase 7b.4)

**Datum:** 2026-03-16
**Status:** Approved
**Scope:** Layer 3 NER-Erkennung fuer Personennamen in Mingly Privacy Pipeline

## Kontext

Die PII Detection Pipeline hat 3 Layer. Layer 1 (Regex) und Layer 2 (Swiss) sind implementiert. Layer 3 (NER) fehlt — damit werden Personennamen, Organisationen und kontextuelle Adressen nicht erkannt.

**Modell:** piiranha-v1-detect-personal-information (HuggingFace)
- 400M Parameter, ONNX-Format
- Sprachen: DE (99.4%), EN, FR, IT
- Latenz: <50ms on-device (CPU)
- Task: Token-Classification (NER)

## Entscheidungen

| Entscheidung | Wahl | Begruendung |
|-------------|------|-------------|
| Modell-Bereitstellung | Lazy-Download | Mobile-Kompatibilitaet, Bundle-Size, Modell-Updates ohne App-Update |
| Fallback ohne Modell | Graceful Degradation | Layer 1+2 fangen ~80% PII ab, User sieht Hinweis |
| Sprach-Scope | DE+EN+FR+IT (alle) | piiranha erkennt Sprache automatisch, kein Extra-Aufwand |
| Runtime | @xenova/transformers in Worker Thread | Dependency vorhanden, Main-Process bleibt frei |

## Architektur

```
detector-pipeline.ts
  |-- Layer 1: RegexDetector         (bestehend)
  |-- Layer 2: SwissDetector         (bestehend)
  +-- Layer 3: NERDetector (NEU)
         |
         |-- ner-detector.ts         — API-Schicht, sendet Text an Worker
         |-- ner-worker.ts           — Worker Thread, laedt Modell, Inference
         +-- model-manager.ts        — Download, Cache, Versionierung
```

### Speicherort Modell

```
~/.mingly/models/piiranha-v1/
  |-- onnx/model_quantized.onnx
  |-- tokenizer.json
  |-- tokenizer_config.json
  +-- config.json
```

## Komponenten

### 1. model-manager.ts — Modell-Lifecycle

- Download von HuggingFace Hub via @xenova/transformers Cache-Mechanismus
- Speicherort: `~/.mingly/models/piiranha-v1/`
- Status-Events: `not_downloaded | downloading | ready | error`
- Progress-Callback bei Download (fuer UI-Fortschrittsbalken)
- Versionspruefung: lokale Version vs. Remote-Manifest
- Kein automatischer Download — nur via explizite User-Aktion

### 2. ner-worker.ts — Worker Thread

- Laedt `@xenova/transformers` Pipeline (`token-classification`)
- Warmup beim ersten Aufruf (Modell in RAM, ~2-3s)
- Message-basierte Kommunikation (postMessage/onmessage)
- Messages: `{ type: 'detect', text }` -> `{ type: 'result', entities }` | `{ type: 'error', message }`
- Erkennt: PERSON, ORGANIZATION, LOCATION, ADDRESS
- Crash-safe: Worker kann neu gestartet werden

### 3. ner-detector.ts — Schnittstelle fuer Pipeline

- `detectWithNER(text): Promise<PIIEntity[]>`
- Startet Worker lazy beim ersten Aufruf
- Timeout: 5s pro Inference (Fallback auf leeres Array)
- `isAvailable(): boolean` — prueft ob Modell geladen
- `warmup(): Promise<void>` — optional, laedt Modell vor
- Gibt `[]` zurueck wenn Modell nicht verfuegbar (graceful degradation)

## Datenfluss

```
User tippt: "Hallo, ich bin Hans Mueller aus Zuerich"

Layer 1 (Regex):    -> []  (keine Regex-Matches)
Layer 2 (Swiss):    -> [{ "Zuerich", LOCATION, confidence: 0.8 }]
Layer 3 (NER):      -> [{ "Hans Mueller", PERSON, confidence: 0.97 },
                        { "Zuerich", LOCATION, confidence: 0.95 }]

Deduplizierung:     -> [{ "Hans Mueller", PERSON, 0.97, source:'ner' },
                        { "Zuerich", LOCATION, 0.95, source:'ner' }]
```

## Deduplizierungs-Regeln (erweitert)

Bestehende Prioritaet bleibt, neue Regel fuer NER:

1. **Swiss > Regex** bei gleicher Kategorie (bestehend)
2. **NER > Regex** bei gleicher Kategorie (NER hat Kontext-Verstaendnis)
3. **Swiss > NER** bei Swiss-spezifischen Typen (AHV, CH-IBAN — Checksumme schlaegt NER)
4. Hoehere Confidence > niedrigere (bestehend)
5. Laengerer Match > kuerzerer (bestehend)

## IPC-Erweiterung

Neue Channels in `privacy-handlers.ts`:

| Channel | Richtung | Beschreibung |
|---------|----------|-------------|
| `PRIVACY_NER_STATUS` | Main -> Renderer | `'not_downloaded' \| 'downloading' \| 'ready' \| 'error'` |
| `PRIVACY_NER_DOWNLOAD` | Renderer -> Main | Startet Download, Progress-Events zurueck |
| `PRIVACY_NER_DELETE` | Renderer -> Main | Loescht lokales Modell, gibt Speicher frei |

## UI-Erweiterung

`PrivacySettingsTab.tsx` erhaelt NER-Sektion:

- Status-Badge: nicht geladen (grau) / wird geladen (gelb) / bereit (gruen) / fehler (rot)
- Download-Button mit Fortschrittsbalken (~200MB)
- Modellgroesse-Anzeige nach Download
- Loeschen-Button mit Bestaetigung
- Info-Text: "Erkennt Personennamen in DE, EN, FR, IT"

## Testplan

| Testdatei | Tests | Fokus |
|-----------|-------|-------|
| `ner-detector.test.ts` | ~12 | Worker-Kommunikation, Timeout, Fallback, isAvailable |
| `model-manager.test.ts` | ~10 | Download-Simulation, Cache-Hit, Status-Events, Delete |
| `detector-pipeline-ner.test.ts` | ~10 | 3-Layer-Merge, NER vs Swiss Deduplizierung, graceful degradation |

NER-Inference wird mit gemocktem Worker getestet (kein 200MB-Modell in CI).

## Bekannte Grenzen v0.7

- Kein Fine-Tuning — piiranha-v1 as-is von HuggingFace
- Kein Streaming-NER — ganzer Text wird auf einmal analysiert
- Kein GPU — CPU-only (Apple Silicon / x86)
- Kein automatischer Download — User muss explizit aktivieren
- Session-Map Persistence fehlt weiterhin (in-memory only)
