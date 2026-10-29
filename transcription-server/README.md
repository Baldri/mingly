# Mingly Transcription Server

Transkription mit Sprechertrennung. Audio rein, Segmente mit Sprechern und
Zeitstempeln raus — ueber HTTP, nach demselben Muster wie `rag-server`.

Policy, Mandanten, Audit, Job-Tabelle und Oberflaeche bleiben auf der
TypeScript-Seite. Dieser Dienst ist nur die Maschine.

## Herkunft und Lizenz

Die Pipeline ist aus **TranscriboZH** uebernommen
(<https://github.com/machinelearningZH/audio-transcription>, MIT, Kanton
Zuerich). Uebernommen wurden `src/transcription.py`, die `data_leaks`-Liste aus
`data/const.py` und der `get_prompt`-Patch aus `worker.py`. Der
MIT-Copyright-Hinweis steht im Kopf von `pipeline.py` und `const.py`.

**Nicht** uebernommen: das NiceGUI-Frontend (Mingly hat React), die
Qwen-Zusammenfassung (Mingly hat seine eigene LLM-Schicht mit Residenz-Policy)
und die dateisystembasierte Warteschlange `data/in` / `data/out` (Mingly hat
SQLite).

## Warum der `get_prompt`-Patch nicht optional ist

faster-whisper gibt das vorherige Segment immer als Kontext weiter. Auf langem
Audio laeuft Whisper damit in Wiederholungsschleifen: gemessen bis zu **58 %
des Materials verloren** und eine Wortfehlerrate um **46 %**. Mit
unterdrucktem Kontext: **5,96 %**
(`docs/superpowers/specs/2026-10-25-whisper-messung.md`, Abschnitt 4.1).

Der Patch ist genau diese Unterdrueckung. TranscriboZH hat denselben Befund
unabhaengig gefunden. Wer ihn entfernt, macht den Dienst unbrauchbar.

## Endpunkte

| Methode | Pfad | Antwort |
|---|---|---|
| `POST` | `/transcribe` | `{ "job_id": str }` |
| `GET` | `/jobs/{job_id}` | `{ "state": str, "progress": float, "segments": [...], "error": str \| null }` |
| `GET` | `/health` | `{ "status": str, "model_loaded": bool, "device": str }` |

`POST /transcribe` nimmt `{ "audio_path": str, "num_speakers": int \| null,
"language": str }`. `num_speakers` weglassen heisst: erkennen lassen.

Ein Segment ist `{ "start_ms": int, "end_ms": int, "speaker": str, "text": str }`.

`progress` ist ein Bruch von **0 bis 1**, nicht 0 bis 100.

Zustaende: `queued | running | done | failed`. Abbrechen kennt dieser Dienst
nicht — das liegt beim Job-Runner auf der TypeScript-Seite.

`/health` ist der einzige Endpunkt ohne Token — damit der Client "Dienst aus"
von "Dienst laeuft, aber falsch konfiguriert" unterscheiden kann.

Fehlerfaelle: `401` ohne oder mit falschem Token, `400` wenn das Audio nicht
nutzbar ist (absichtlich ohne Angabe, *warum*), `404` bei unbekannter
Job-Kennung, `422` bei ungueltigem Anfragekoerper, `503` solange kein Modell
geladen ist.

## Betriebsregeln

- **Modelle werden einmal beim Start geladen**, nicht pro Anfrage.
- **Genau ein Worker pro Prozess.** Mehr als einer sprengt das VRAM — das
  README von TranscriboZH sagt das ausdruecklich. Die Kapazitaetsgrenze einer
  Installation ist damit *ein Worker pro GPU*, nicht der Durchsatz.
- **Jobs liegen im Speicher und werden hier absichtlich nicht persistiert.**
  Ein Neustart verliert die Warteschlange; die Wiederaufnahme ist Aufgabe des
  Job-Runners in Mingly (Spec 6.2).
- Der Dienst bindet standardmaessig auf `127.0.0.1`. Fuer jede andere Bindung
  gilt der naechste Abschnitt — ohne API-Schluessel **startet er dann nicht**.

## Sicherheit

Zwei Dinge haengen zusammen und ergeben sonst einen Exfiltrationsweg:
`POST /transcribe` nimmt einen **Pfad**, und `GET /jobs/{id}` gibt den
**Text** zurueck. Ohne Schranken transkribiert dieses Paar jede Audiodatei auf
dem Host und liefert das Transkript aus — und ein Dienst auf localhost ist von
einer Webseite aus per DNS-Rebinding erreichbar. Deshalb:

1. **Pfad-Einschraenkung.** Eingereichte Pfade muessen **innerhalb von
   `TRANSCRIPTION_SPOOL_DIR`** aufgeloest werden. Verglichen wird mit
   `Path.resolve()` und `is_relative_to`, nicht per Zeichenketten-Praefix
   (sonst passiert `/spool-evil` die Pruefung fuer `/spool`). Symlinks werden
   grundsaetzlich abgewiesen, auch solche, die nach innen zeigen.
2. **Bearer-Token** auf allen Endpunkten **ausser `/health`**, verglichen mit
   `hmac.compare_digest` (konstante Zeit). Faellt **geschlossen** aus: ist Auth
   verlangt, aber kein Schluessel gesetzt, wird abgewiesen, nicht erlaubt.
3. **Auth ist auf jeder Nicht-Loopback-Bindung erzwungen**, unabhaengig von
   `TRANSCRIPTION_REQUIRE_AUTH`. Wer auf eine Netzwerkschnittstelle bindet,
   kann Authentisierung nicht abwaehlen — und **ohne Schluessel startet der
   Dienst dann nicht** (keine Warnung, Abbruch).
4. **`TrustedHostMiddleware`** mit der konfigurierten Adresse plus
   `127.0.0.1` und `localhost`. Das ist die Schranke gegen DNS-Rebinding: ein
   Browser laesst sich auf 127.0.0.1 lenken, schickt aber weiterhin den
   fremden Namen im `Host`-Header. **Kein CORS** — anders als `rag-server`,
   das `allow_origins=["*"]` setzt.
5. **Generische Fehlermeldungen.** Ein `400` sagt nur "Audio file is not
   usable" und gibt den eingereichten Pfad nicht zurueck; welche Pruefung
   angesprochen hat und ob ein Pfad existiert, steht nur im Dienst-Log. Auch
   unbrauchbare Pfade (Nullbyte, zu lange Namen) ergeben diesen `400` und
   keinen `500` mit Traceback.
6. **Keine `/docs`, `/redoc`, `/openapi.json`.** FastAPI legt diese Routen
   sonst automatisch an, und sie tragen **keine** Auth-Abhaengigkeit — der
   Dienst haette damit vier unauthentisierte Endpunkte. Sie sind abgeschaltet;
   die drei echten Endpunkte stehen in der Tabelle oben.
7. **Die Auth-Entscheidung haengt am echten Gegenueber, nicht nur an der
   Konfiguration.** `uvicorn server:app --host 0.0.0.0` bindet das Netz,
   waehrend `TRANSCRIPTION_HOST` weiter `127.0.0.1` sagt — eine Pruefung nur
   gegen die Umgebungsvariable wuerde genau diesen Fall durchlassen. Deshalb
   wird zusaetzlich die **Adresse des Aufrufers** geprueft: eine Anfrage von
   ausserhalb des Hosts braucht immer einen Token. Gemessen und darum so
   gebaut: der ASGI-Kontext enthaelt die Bind-Adresse **nicht**
   (`scope["server"]` ist die lokale Adresse der einzelnen Verbindung), die
   Gegenstelle dagegen schon.
8. **Kein vorgelagerter Proxy. Niemals mit Proxy-Headern betreiben.** Die
   Adresse des Aufrufers ist nur so lange echter Transportzustand, wie sie
   niemand ueberschreibt. `uvicorn.Config` hat `proxy_headers=True` als
   **Standard**, und `ProxyHeadersMiddleware` ersetzt die Gegenstelle dann
   durch den Wert aus `X-Forwarded-For`, sobald der Transport-Peer als
   vertrauenswuerdig gilt — und `FORWARDED_ALLOW_IPS=*`, das in vielen
   Container-Anleitungen steht, vertraut jedem. Ein entfernter Angreifer
   koennte sich damit als `127.0.0.1` ausgeben. Darum zwei Schichten:
   `server.py` uebergibt **`proxy_headers=False`**, und zusaetzlich gilt jede
   Anfrage mit `X-Forwarded-For` oder `Forwarded` als **nicht direkt** und
   braucht einen Token — der **Wert** dieser Header wird nie gelesen, nur
   ihr Vorhandensein. Gemessen: selbst mit `proxy_headers=True` **und**
   `FORWARDED_ALLOW_IPS=*` wird eine Anfrage mit gefaelschtem
   `X-Forwarded-For: 127.0.0.1` mit `401` abgewiesen.
   **Verhaltensaenderung, bitte beachten:** ein lokaler Aufrufer, der
   `X-Forwarded-For` mitschickt, bekommt jetzt `401`, wo er vorher bedient
   wurde. Der Electron-Client spricht direkt mit dem Dienst und ist nicht
   betroffen. Wer den Dienst wirklich hinter einen Proxy stellt, muss einen
   `TRANSCRIPTION_API_KEY` setzen — die Gegenstelle ist dann kein Ersatz fuer
   Authentisierung mehr.

Auf `127.0.0.1` ohne Schluessel bleibt der Dienst absichtlich offen: das ist
der `on-device`-Fall, in dem nur lokale Prozesse ihn erreichen. Die
Pfad-Einschraenkung gilt auch dort.

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `TRANSCRIPTION_HOST` | `127.0.0.1` | Bind-Adresse |
| `TRANSCRIPTION_PORT` | `8765` | Port (`rag-server` belegt 8001) |
| `TRANSCRIPTION_SPOOL_DIR` | `<dienst>/spool` | **Einziges** erlaubtes Verzeichnis fuer Audio |
| `TRANSCRIPTION_REQUIRE_AUTH` | `false` | `true` erzwingt den Token auch auf Loopback |
| `TRANSCRIPTION_API_KEY` | — | Bearer-Token; **Pflicht** bei Nicht-Loopback-Bindung |
| `TRANSCRIPTION_DEVICE` | `cpu` | `cpu`, `cuda` oder `mps` |
| `TRANSCRIPTION_MODEL` | `large-v3` | Whisper-Modellgroesse |
| `TRANSCRIPTION_DIARIZATION_MODEL` | `pyannote/speaker-diarization` | Diarisationsmodell |
| `TRANSCRIPTION_BATCH_SIZE` | `4` | 4 bei 8 GB VRAM, 32 bei 16 GB |
| `TRANSCRIPTION_MODEL_ROOT` | — | Ablage der Whisper-Gewichte (offline) |
| `TRANSCRIPTION_LOG_LEVEL` | `INFO` | Log-Stufe |
| `HF_AUTH_TOKEN` | — | Hugging-Face-Token fuer die Diarisation |

Auf Apple Silicon laeuft das Whisper-Modell zwingend auf der CPU — ctranslate2,
die Laufzeit von faster-whisper, hat kein Metal-Backend. `mps` gilt nur fuer
pyannote. Laut dem README von TranscriboZH ist CPU-Transkription
**"extremely slow"**; eigene Messung: 1,5x Echtzeit auf CPU.

## Offene Punkte, die eine Entscheidung brauchen

1. **Die Diarisationsgewichte sind zugangsbeschraenkt.** `pyannote` verlangt
   einen Hugging-Face-Token und akzeptierte Modellbedingungen. Das Akzeptieren
   ist eine Vertragsannahme und damit eine Handlung des Produktverantwortlichen
   (Spec 10.3). Ohne Token startet der Dienst, meldet `model_loaded: false` und
   weist Jobs mit `503` ab. Welches Modell ausgeliefert wird, ist deshalb
   konfigurierbar und hier nicht entschieden.
2. **Beschleunigung auf Apple Silicon.** TranscriboZH nutzt dafuer
   `mlx_whisper` mit `mlx-community/whisper-large-v3-mlx`. Dieser Zweig ist
   hier **absichtlich nicht uebernommen** (zusaetzlicher Modellstapel,
   zusaetzliche Abhaengigkeit). Solange er fehlt, ist die lokale Transkription
   auf dem Mac CPU-langsam. Das ist eine Produktentscheidung.
3. **Python-Version.** `torch==2.5.1` veroeffentlicht Wheels nur fuer
   cp39–cp313 (gegen PyPI geprueft am 2026-10-25). Ein echter Betrieb braucht
   **Python 3.12 oder 3.13**; upstream pinnt 3.12.7. Python 3.14 funktioniert
   nicht.

## Installation und Start

```bash
# Betrieb: Python 3.12 oder 3.13, NICHT 3.14
python3.12 -m venv .venv
.venv/bin/pip install torch           # passend zum Beschleuniger, siehe requirements.txt
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py
```

## Tests

```bash
transcription-server/.venv/bin/python -m pytest transcription-server/tests/ -v
```

45 Tests in zwei Dateien: `test_pipeline.py` fuer `get_prompt` und
`clean_segments`, `test_security.py` fuer Token-Pruefung, Pfad-Einschraenkung,
die angebotene Endpunkt-Oberflaeche und die Startverweigerung. Die HTTP-Tests
fahren einen echten uvicorn-Server in einem Thread und sprechen ihn ueber
`urllib` an — `fastapi.testclient` braucht `httpx`, das hier absichtlich nicht
installiert ist. Fuer einen Aufrufer **von ausserhalb** des Hosts wird die
ASGI-Anwendung direkt aufgerufen: eine Verbindung von 192.168.x.x laesst sich
ueber Loopback nicht herstellen.

Die Tests laufen **ohne Modelle, ohne GPU und ohne Hugging-Face-Konto**. Das
ist der Grund fuer die Importaufteilung in `pipeline.py`: `whisperx`, `torch`,
`pandas` und `pyannote` werden erst *innerhalb* der Funktionen importiert, die
sie brauchen. `get_prompt` und `clean_segments` bleiben damit pruefbar. **Diese
Aufteilung nicht rueckbauen.**

Nicht von Tests abgedeckt und nur mit Modellen pruefbar: die vier
Pipeline-Stufen selbst (Transkription, Alignment, Diarisation,
Sprecherzuordnung) und damit `transcribe`, `load_models` und `_assign_speakers`.
