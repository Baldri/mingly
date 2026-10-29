# Transkriptions-Dienst in Mingly — Design

**Datum:** 2026-10-25
**Status:** Entwurf zur Abnahme. Nichts implementiert.
**Firma:** digital opua GmbH
**Ausloeser:** <https://transcribo.gpt.liip.ch/> — eine Instanz von TranscriboZH

---

## 1. Zweck und Warum

Unternehmen haben Aufnahmen, die sie nicht an einen US-Dienst geben duerfen oder wollen:
Sitzungsprotokolle, Mandantengespraeche, Interviews, Personalgespraeche, Einvernahmen.
Der Markt bietet dafür heute entweder bequeme US-Cloud (Otter, Fireflies, MS Teams) oder
Eigenbau mit Whisper auf der Kommandozeile. Zwischen diesen beiden gibt es wenig.

TranscriboZH schliesst diese Luecke bereits — aber als Anwendung, die eine Organisation
selbst betreiben muss. Mingly bringt das mit, was dort fehlt: eine Policy-Schicht, die
pro Inhalt entscheidet, wohin Daten gehen duerfen, plus eine Mandanten-, Lizenz- und
Audit-Schicht. Der Gedanke ist deshalb nicht "Transcribo nachbauen", sondern
**Transkription als weiteres Ziel unter die bestehende Residenz-Policy haengen.**

### Was Mingly dafuer schon hat (gemessen am Code, 2026-10-25)

| Baustein | Fundstelle | Relevanz |
|---|---|---|
| Residenz-Policy, deklarativ und versioniert | `src/main/policy/policy-types.ts`, `policy-engine.ts` | `PolicyRule {minSensitivity, allowedResidency}` ist **nicht** LLM-spezifisch |
| Residenz-Guard, an den Trust-Guard gekettet | `src/main/policy/residency-guard.ts` | beide Achsen muessen passen, getrennt gehalten |
| Provider-Herkunft inkl. Lizenz und AVV | `src/main/routing/provider-registry.ts` | `ProviderOrigin` fuehrt `residency`, `operator`, `weightsLicense`, `hostingMode`, `dpaStatus` |
| Residenz-Werte inkl. Geraet | `src/shared/provider-types.ts:210` | `'CH' \| 'EU' \| 'US' \| 'on-device' \| 'unknown'` |
| Betriebsformen | `src/shared/deployment-types.ts:15` | `DeploymentMode = 'standalone' \| 'server' \| 'hybrid'` |
| Headless-Server, REST + WebSocket | `src/server/index.ts`, `Dockerfile.server` | Private Cloud ist eine vorhandene Form, Port 3939, API-Key-Auth |
| Lokales ML-Modell im eigenen Worker | `src/main/privacy/ner-worker.ts`, `model-manager.ts` | fertiges Muster: Download nach `~/.mingly/models`, Status, Progress, Loeschen |
| Privacy-Kette (Regex, NER, CH-Detektor, Anonymisierung, Rehydrierung) | `src/main/privacy/` | greift auf Text — also auf das **Transkript** |
| Rollen, Rechte, Organisation, Team (als **Typen**) | `src/main/security/rbac-manager.ts` (855 Zeilen) | Vokabular vorhanden, aber in einer Konfigurationsdatei, **nicht** in der Datenbank - siehe Korrektur in 10.2 |
| Abo-Stufen und Feature-Gates | `src/main/services/feature-gate-manager.ts`, `license-activation.ts` | kommerzielle Schicht existiert |
| Audit-Schreiber | `src/main/policy/audit-writer.ts`, `src/main/audit/` | Policy-Version reist in jeden Eintrag |

**Was fehlt:** alles Audio-spezifische. Suche nach `transcri`, `whisper`, `.wav`, `audioContext`
ueber `src/` ergab null Treffer, bei angeschlagener Positivkontrolle (`residency` → 10 Dateien).

---

## 2. Entschieden (von Holger, 2026-10-25)

1. **Zwei Betriebsformen, beide:** Online-Loesung in einer Private Cloud **und** lokale
   Loesung in der App.
2. **Breite Einsetzbarkeit:** moeglichst viele Unternehmen, nicht ein Grosskunde.
3. **Datenschutzkonform.** Firmensitz Schweiz, also nDSG als Messlatte, DSGVO wo Kunden
   in der EU sitzen.
4. **Kommerziell.**
5. **Mobile Aufnahme** (ergaenzt im Gespraech am 2026-10-25): eine App, die man im
   Meeting auf den Tisch legt, die mitlaeuft, und aus der Aufnahme Notizen und ein
   Protokoll erzeugt.
6. **Lieferant zuerst, Betrieb als zweite Stufe** (Holger, 2026-10-25): Wir verkaufen
   zuerst die App und den Container und betreiben nichts selbst. Der Betrieb wird
   geplant, aber nicht ausgeschlossen. Was daraus folgt, steht in Abschnitt 10.2 -
   insbesondere die Dinge, die Stufe 1 **nicht** verbauen darf.
7. **Die Pipeline aus TranscriboZH uebernehmen, nicht die Anwendung** (Holger,
   2026-10-25): `src/transcription.py`, `data_leaks` und der `get_prompt`-Patch
   kommen mit, unter MIT mit Copyright-Hinweis. Frontend, Zusammenfassung und
   Job-Verwaltung bleiben draussen - Mingly hat fuer alle drei schon etwas Besseres.
   Begruendung und Fundstellen in Abschnitt 10.3.
8. **Die Einwilligung ist ein aktiver Schritt vor der Aufnahme** (Holger, 2026-10-25):
   Wer aufnimmt, startet sie vorher. Die Aufnahme beginnt also nicht mit einem
   Druck auf "Rec", sondern mit einem Einwilligungsschritt, den der Aufnehmende
   ausloest - damit ist die Zustimmung aller Beteiligten Teil des Ablaufs und nicht
   eine Obliegenheit im Kleingedruckten.

---

## 3. Ziele, Nicht-Ziele, Anti-Ziele

### Ziele
- Eine Aufnahme wird zu einem brauchbaren, korrigierbaren Transkript, ohne dass die Datei
  das vom Kunden gewaehlte Rechtsgebiet verlaesst.
- Dieselbe Policy, die heute ueber LLM-Anfragen entscheidet, entscheidet auch ueber Audio.
- Ein Unternehmen kann ohne Spezialwissen starten: lokal installieren oder einen Container
  betreiben.
- Der Weg vom Transkript zur Zusammenfassung laeuft durch die bestehende Privacy-Kette.

### Nicht-Ziele
- Keine Live-Transkription laufender Sitzungen, also kein Text, der waehrend des
  Sprechens erscheint (eigenes Produkt, eigene Latenzklasse). **Aufnehmen waehrend der
  Sitzung und danach verarbeiten ist dagegen ein Ziel** (Abschnitt 5a) - das ist nicht
  dasselbe, auch wenn es sich fuer den Nutzer aehnlich anfuehlt.
- Kein Meeting-Bot, der sich in Teams oder Zoom einwaehlt.
- Keine Dialekt-Verschriftung. Whisper liefert bei Schweizerdeutsch eine Uebersetzung
  nach Standarddeutsch (belegt: VarDial 2024, <https://arxiv.org/html/2404.19310v2>).
  Fuer Protokolle richtig, fuer Sprachforschung nicht.
- Keine eigene Modellentwicklung.

### Anti-Ziele (das Ding waere gescheitert, auch wenn es technisch laeuft)
- **Ein Transkript landet in einem Rechtsgebiet, das der Kunde ausgeschlossen hat.**
  Das ist der einzige Fehler, der das Produkt als Ganzes entwertet.
- Eine Policy, die nur fuer Text gilt, waehrend Audio daran vorbeigeht.
- Die lokale Variante ist so langsam, dass sie niemand benutzt, und die App verspricht
  sie trotzdem.
- Betrieb, der eine GPU voraussetzt und damit die "moeglichst viele Unternehmen" ausschliesst.

---

## 4. Der zentrale Befund: Audio passt nicht durch den heutigen Guard

`src/main/security/request-guard.ts` arbeitet in zwei Phasen (`guardInput`, `guardDispatch`,
zusammengesetzt als `preflightGuard`) und bekommt seine Bausteine injiziert (`GuardDeps`).
Alle diese Bausteine arbeiten auf **Text**: `sanitize(text)`, `scanSensitive(text)`,
`checkRouting(text, provider)`.

Eine Audiodatei hat keinen Text. Daraus folgt ein Henne-Ei-Problem:

> Die Klassifikation, die entscheidet, wohin die Datei darf, braucht den Text,
> den erst das Ziel erzeugt.

**Entscheidung (meine, nicht abgesprochen):** Fuer Audio wird die Residenz **deklariert,
nicht klassifiziert.** Die Schutzstufe kommt nicht aus dem Inhalt, sondern aus dem Ort,
an dem die Datei liegt: eine Mandanten- oder Arbeitsbereichs-Einstellung
("Dieser Bereich ist `critical`"). Erst das fertige Transkript geht durch den normalen
inhaltsbasierten Weg.

Damit bleibt die Policy-Engine unveraendert — sie bekommt eine `Classification`, deren
`reason` dann nicht "trust level X" lautet, sondern "declared by workspace". Das Feld
ist dafuer vorgesehen ("Why this level — for the audit entry").

### Die Kette

```
Audiodatei
  │  (1) Schutzstufe: deklariert durch Arbeitsbereich / Mandant
  ▼
evaluate(policy, classification, transcriptionCandidates)   ← unveraenderter Policy-Kern
  │  → erlaubte Transkriptions-Ziele
  ▼
(2) Transkription beim erlaubten Ziel
  │      on-device  → Whisper im lokalen Worker
  │      CH         → eigener oder gemieteter CH-Endpunkt
  ▼
Rohtranskript + Sprecherspuren
  │  (3) Editor: korrigieren, Sprecher benennen, Begriffe fixen
  ▼
Transkript
  │  (4) OPTIONAL, nur fuer Zusammenfassung/Analyse:
  │      bestehende Privacy-Kette (Anonymisierung) → preflightGuard → LLM → Rehydrierung
  ▼
Protokoll / Zusammenfassung
```

Schritt 4 ist der Punkt, an dem Mingly etwas kann, was TranscriboZH nicht tut: das
Transkript wird vor der Zusammenfassung pseudonymisiert und danach rehydriert.

---

## 5. Produktform

Drei Formen, abgebildet auf das bestehende `DeploymentMode`:

| Form | `DeploymentMode` | Transkription laeuft | Zielkunde |
|---|---|---|---|
| **Lokal in der App** | `standalone` | `on-device`, Whisper im Worker | Einzelpersonen, Kanzleien, Praxen, alle ohne IT-Abteilung |
| **Private Cloud** | `server` | im Container des Kunden | Unternehmen mit eigener Infrastruktur oder CH-Hosting |
| **Gemischt** | `hybrid` | App schickt Jobs an den Firmenserver, faellt lokal zurueck | Firmen mit Aussendienst |

Der Container ist der vorhandene `Dockerfile.server` plus ein Transkriptions-Dienst.
Ein Kunde bekommt eine `docker-compose.yml`, keinen Installationsworkshop.

### Was "moeglichst viele Unternehmen" technisch bedeutet

Der haerteste Punkt des ganzen Vorhabens ist nicht die Policy, sondern **Durchsatz ohne GPU.**
Whisper large-v3 auf einer CPU ist je nach Maschine ein Vielfaches der Echtzeit. Ich habe
das **nicht gemessen** und trage hier bewusst keine Zahl ein.

**GEMESSEN am 2026-10-25** auf Apple M5 (10 Kerne, 32 GB), whisper.cpp 1.9.5.
Voller Report: `2026-10-25-whisper-messung.md`.

| Modell | Rechenwerk | Faktor | Echtzeit | 1 Stunde Audio |
|---|---|---|---|---|
| large-v3 q5_0 | Metal | 0,088 | 11,4x | 5,3 min |
| turbo q5_0 | Metal | 0,036 | 27,6x | 2,2 min |
| large-v3 q5_0 | CPU, 4 Threads | 0,668 | 1,5x | 40 min |
| turbo q5_0 | CPU, 4 Threads | 0,429 | 2,3x | 26 min |

Wortfehlerrate auf sauberer Sprachsynthese: **5,96 %** (large-v3) und **7,72 %** (turbo),
bei 4 bzw. 3 Substitutionen auf 855 Woerter. Das ist eine **Untergrenze** - echte
Sitzungen mit Akzent, Nebengeraeuschen und Durcheinanderreden liegen darueber.

**Der eigentliche Befund ist ein Parameter, kein Leistungswert.** Ohne
`--max-context 0` laufen beide Modelle in Wiederholungsschleifen, verlieren bis zu
58 % des Materials und erreichen Fehlerraten um 46 %. Mit dem Parameter ist die
Verarbeitung zusaetzlich schneller. Ein naiver Aufruf von `whisper-cli` liefert bei
einer Stunde Sitzung unbrauchbares Material - weshalb die Parameterwahl ein
Produktmerkmal ist und nicht ein Implementierungsdetail.

**Ergebnis gegen die Kriterien:** (a) Apple Silicon **bestanden**, mit grossem Abstand.
(b) haengt am Modell: `large-v3` bleibt auf CPU bei 1,5x Echtzeit - zu knapp fuer einen
Dienst mit mehreren gleichzeitigen Nutzern. `turbo` erreicht 2,3x und ist auf CPU
brauchbar, bei 7,72 % statt 5,96 % Fehlerrate. **Aber:** gemessen auf
Apple-M5-Performance-Kernen, die staerker sind als Cloud-vCPUs - auf der Zielhardware
**ungemessen**. Entscheid 3 ist damit keine Ja/Nein-Frage, sondern: welches Modell in
welcher Betriebsform, plus eine Messung auf echter Container-Hardware.

**Weiterhin nicht gemessen:** Schweizerdeutsch (es gibt keine `de_CH`-Stimme, und beide
Korpora sind non-commercial - der lizenzfreie Weg ist eine eigene Referenzaufnahme von
zehn Minuten mit Hand-Transkript) und die Sprechertrennung (Material hatte eine Stimme).

Die Lehre dazu steht schon im Repo, in `model-manager.ts`:
*"Do not swap this back on a model card alone."* Ein frueheres Modell lieferte 2 von 20
statt der auf der Modellkarte versprochenen Werte. **Fuer Schweizerdeutsch gilt das doppelt.**

---

## 5a. Mobile Aufnahme (Phone im Meeting)

Das Geraet liegt auf dem Tisch, nimmt auf, und danach entstehen Notizen und ein Protokoll.
Technisch ist das **Aufnahme plus Nachverarbeitung**, nicht Live-Transkription - der
Unterschied entscheidet ueber den Aufwand.

### Das Hindernis: Mingly ist Electron

Electron hat keine Mobilvariante. Drei Wege, mit ihren Grenzen:

| Weg | Aufwand | Grenze |
|---|---|---|
| **PWA** vom Private-Cloud-Server ausgeliefert | gering, eine Codebasis, kein App Store | **iOS stoppt Hintergrund-Audio in installierten PWAs beim Sperren des Bildschirms** - mehrfach dokumentiert fuer Wiedergabe; fuer `MediaRecorder` **nicht belegt und zu testen** |
| **Native App** (Swift/Kotlin oder React Native) | zweite Codebasis, Store-Review | Hintergrundaufnahme ist auf iOS mit Background Mode "audio" moeglich, braucht aber eine Begruendung im Review |
| **Kein eigenes Mobile**: System-Diktiergeraet, Datei spaeter in Mingly ziehen | null | schlechteste Erfahrung, aber sofort verfuegbar |

**Zu messen, bevor hier etwas entschieden wird:** Laeuft `MediaRecorder` in einer auf dem
Homescreen installierten PWA auf aktuellem iOS weiter, wenn der Bildschirm sperrt? Die
Literatur beantwortet das fuer Audio-*Wiedergabe* mit nein und sagt zur *Aufnahme* nichts.
Fallt die Antwort negativ aus, ist "hinlegen und mitlaufen lassen" auf iOS **nur native**
erreichbar, und die PWA taugt bloss fuer Aufnahmen mit wachem Bildschirm.

### Wo transkribiert wird

Auf dem Phone (whisper.cpp laeuft auf iOS mit CoreML) oder auf dem Server. Bei einer
Sitzung von einer Stunde ist On-Device auf einem Telefon thermisch und beim Akku heikel,
und ein Phone hat nicht den Arbeitsspeicher eines Laptops. Realistisch: **das Phone nimmt
auf, der Server transkribiert.** Damit verlaesst die Datei das Geraet - also genau die
Residenzfrage aus Abschnitt 4, nur mobil. Die deklarierte Schutzstufe ist dafuer bereits
die richtige Antwort: der Arbeitsbereich, in den die Aufnahme laedt, bestimmt das Ziel.

### Was danach passiert, ist schon gebaut

Notizen und Protokoll sind der Schritt 4 der Kette: Transkript anonymisieren
(`src/main/privacy/`), durch `preflightGuard` an ein nach Policy erlaubtes Modell,
Ergebnis rehydrieren. Pendenzen, Entscheide und Teilnehmer aus einem Protokoll zu ziehen
ist eine Prompt-Aufgabe, keine Architekturaufgabe.

### Der Einwilligungsschritt

Entschieden (Holger, 2026-10-25): **die Aufnahme startet nicht direkt.** Zuerst ein
Schritt, den der Aufnehmende ausloest und der allen Anwesenden sichtbar macht, dass und
wozu aufgenommen wird; erst danach laeuft das Mikrofon. Was daraus technisch folgt:

- ein Zustand "wartet auf Einwilligung" vor dem Zustand "nimmt auf",
- ein sichtbarer Hinweis am Geraet, solange aufgenommen wird (nicht nur beim Start),
- ein Protokolleintrag: wann, durch wen, mit welchem genannten Zweck, welche Teilnehmer -
  derselbe Audit-Pfad wie bei den Policy-Entscheiden (`src/main/audit/`),
- eine Moeglichkeit, die Aufnahme sofort zu beenden und das Bisherige zu verwerfen.

Das ist wenig Code und viel Produktwert: es ist der Unterschied zwischen einem Werkzeug,
das ein Compliance-Verantwortlicher freigeben kann, und einem, das er verbieten muss.

### Der Punkt, der kein technischer ist

Ein Geraet, das in einer Sitzung mitlaeuft, nimmt **alle Anwesenden** auf. Siehe
Abschnitt 8 - das ist in der Schweiz Strafrecht, nicht Datenschutz-Feinheit, und es
gehoert in das Produkt, nicht in die AGB.

---

## 6. Architektur

### 6.1 Transkriptions-Ziele als Registry-Eintraege

Ein Transkriptions-Ziel ist ein Kandidat mit `ProviderOrigin` — dasselbe Vokabular wie
bei LLM-Anbietern, damit der Policy-Kern nichts Neues lernen muss:

| Ziel | `residency` | `hostingMode` | `weightsLicense` |
|---|---|---|---|
| Whisper lokal im Worker | `on-device` | eigen | MIT (Modell) |
| Whisper im Kunden-Container | `CH` / `EU` (vom Kunden gesetzt) | eigen | MIT |
| CH-Endpunkt (z.B. Infomaniak) | `CH` | gemietet | zu klaeren |
| OpenAI Whisper API | `US` | gemietet | geschlossen |

**Offener Punkt mit Konsequenz:** `TENANT_ORIGIN` in `provider-registry.ts` erzwingt
`residency: 'unknown'` fuer alles, was ein Mandant selbst registriert. Ein Unternehmen,
das seinen eigenen Whisper-Server in der Schweiz eintraegt, faellt damit durch jede
strenge Regel. Das ist heute fuer LLM-Endpunkte richtig (niemand soll sich eine Residenz
selbst zusprechen), fuer eine **selbst betriebene** Transkription aber falsch.
Loesungsrichtung: eine Residenz, die der Kunde fuer eigene Infrastruktur erklaeren kann,
klar getrennt von einer, die wir geprueft haben — und der Unterschied muss im Audit und
in der Oberflaeche sichtbar bleiben. Das ist eine Architekturentscheidung und braucht
Holgers Entscheid.

### 6.2 Job-Verwaltung

Eine Stunde Audio ist keine Request-Response-Angelegenheit. Gebraucht wird:

- eine Job-Tabelle in der bestehenden SQLite-Datenbank (`src/main/database`),
- Zustaende `queued | running | done | failed | cancelled` mit Fortschritt,
- Fortschrittsmeldungen ueber den vorhandenen WebSocket-Kanal des Servers,
- ein IPC-Handler-Modul `src/main/ipc/transcription-handlers.ts` nach dem Muster der
  dreizehn vorhandenen Handler-Dateien,
- Wiederaufnahme nach Abstuerzen, sonst verliert ein Nutzer 40 Minuten Rechenzeit.

### 6.3 Der Editor

Der Editor ist das, was Transcribo nuetzlich macht und was ein nacktes Whisper nicht hat:
Wiedergabe synchron zum Text, Sprecher benennen, Begriffe korrigieren, Export.
Export nach txt, SRT und einer eigenstaendigen HTML-Datei — letzteres deshalb, weil ein
Transkript oft an jemanden geht, der keine Software installieren darf.
`src/main/services/export-service.ts` existiert und bekommt ein Format mehr.

### 6.4 Modellverwaltung

`NERModelManager` wird zum Muster, nicht zur Vorlage zum Kopieren: Download mit Fortschritt
in `~/.mingly/models`, Statuspruefung, Loeschen. Fuer Whisper kommt hinzu, dass mehrere
Modellgroessen sinnvoll sind (eine schnelle und eine genaue) und dass die Wahl eine
Nutzerentscheidung ist, keine versteckte.

---

## 7. Lizenz- und Modelllage (recherchiert 2026-10-25)

| Komponente | Lizenz | Quelle | Status |
|---|---|---|---|
| TranscriboZH / `machinelearningZH/audio-transcription` | MIT | <https://www.opensource.admin.ch/de/softwares/jfys5j> | kommerzielle Nutzung erlaubt |
| Whisper large-v3 | MIT | OpenAI | erlaubt |
| `pyannote/speaker-diarization-3.0` (Sprechertrennung) | MIT, Copyright CNRS | HF-Modellkarte | **aber: Zugang auf Hugging Face beschraenkt, Bedingungen zustimmen + Token** |
| `pyannote/speaker-diarization-3.1` | MIT, bleibt offen | HF-Modellkarte | erlaubt |
| `pyannote/speaker-diarization-community-1` | CC-BY-4.0 | HF-Modellkarte | erlaubt, Namensnennung noetig |
| pyannoteAI (Precision-3 u.a.) | kommerzielle API | <https://www.pyannote.ai/pricing> | separates Bezahlprodukt |

**Nicht geklaert und vor einer Produktzusage zu klaeren:** Der Text der Hugging-Face-
Nutzungsbedingungen fuer die beschraenkten pyannote-Modelle. Eine MIT-Lizenz auf den
Gewichten und ein Zugangsgate sind zwei verschiedene Dinge; ob die Bedingungen ueber MIT
hinaus etwas fordern, habe ich **nicht** gelesen. Das ist bei einer **ausgelieferten App**
entscheidend, weil die Gewichte dann auf fremden Rechnern landen.

Ausweichweg, falls die Bedingungen stoeren: `community-1` unter CC-BY-4.0, mit Namensnennung.

---

## 8. Datenschutz

Firmensitz Schweiz, also nDSG. Was das konkret in das Produkt schreibt:

- **Aufbewahrung ist eine Einstellung, kein Zufall.** Pro Mandant: wie lange Audiodatei,
  wie lange Transkript, was beim Loeschen eines Jobs wirklich verschwindet.
- **Loeschen muss loeschen.** Audio, Transkript, Zwischendateien, Modell-Cache-Artefakte,
  und der Audit-Eintrag bleibt (er enthaelt kein Transkript).
- **Auftragsverarbeitung:** Die lokale Variante ist keine Auftragsverarbeitung — die Daten
  verlassen das Geraet nicht. Die Private Cloud beim Kunden ebenfalls nicht. Erst ein von
  digital opua betriebener Dienst macht uns zum Auftragsverarbeiter, mit AVV, Verzeichnis
  und Subprozessor-Liste. **Das ist ein Produktentscheid, nicht eine technische Frage:**
  Wollen wir Betreiber sein oder Lieferant? (offen)
- **Besondere Personendaten.** Eine Aufnahme eines Personalgespraechs oder einer
  Patientenbesprechung enthaelt regelmaessig besonders schuetzenswerte Daten. Die
  Voreinstellung fuer neue Arbeitsbereiche gehoert deshalb auf die strenge Seite,
  nicht auf die bequeme.
- **Stimme ist ein biometrisches Datum.** Sprechertrennung erzeugt Stimm-Einbettungen.
  Sie duerfen nicht ueber einen Job hinaus gespeichert werden, solange niemand das
  ausdruecklich will und begruendet hat.
- **Aufnehmen einer Sitzung ist in der Schweiz strafrechtlich geregelt, nicht nur
  datenschutzrechtlich.** Wer als Teilnehmer ein nicht oeffentliches Gespraech aufzeichnet,
  faellt unter **Art. 179ter StGB** (unbefugtes Aufnehmen von Gespraechen) und braucht die
  Zustimmung aller anderen Beteiligten. Wer nicht teilnimmt, faellt unter Art. 179bis.
  Der EDOEB verlangt, dass die Einwilligung **vorab** eingeholt wird und den **Zweck**
  nennt. Ausnahmen regelt Art. 179quinquies - **nicht im Detail geprueft**.
  Grundlage sind Sekundaerquellen (EDOEB-Seite, Lehrmaterial, Rechtsprechungsverweise);
  fuer eine verbindliche Einschaetzung braucht es den Gesetzestext und eine Fachperson.
  **Produktfolge:** Die Einwilligung muss das Produkt organisieren - sichtbarer
  Aufnahmehinweis am Geraet, Einwilligung protokolliert, Teilnehmer erfasst. Das ist
  ein Verkaufsargument gegenueber einem US-Dienst, der das nicht dokumentiert, und kein
  Hindernis.
- **Die Clerk-Ausnahme gilt hier nicht**, weil dieses Produkt keine Identitaetsdaten in
  die USA gibt — aber falls Mingly fuer die Mandanten-Anmeldung Clerk nutzt, gilt der
  bekannte DPF-Hinweis in der Datenschutzerklaerung weiter.

---

## 9. Kommerzielle Schicht

Nichts davon ist neu zu bauen, nur zu konfigurieren:

- Transkription wird ein `GatedFeature` in `FEATURE_MIN_TIER`
  (`src/main/services/feature-gate-manager.ts`).
- Mengengrenzen gehoeren in `TIER_LIMITS` — die natuerliche Einheit ist **Audiominuten
  pro Monat**, nicht Anzahl Dateien.
- Rollen und Mandanten ueber `rbac-manager.ts`: wer darf hochladen, wer darf Transkripte
  anderer sehen, wer darf exportieren.
- Preisgestaltung ist offen. Der relevante Kostentreiber ist Rechenzeit, nicht API-Tokens —
  das unterscheidet dieses Feature vom Rest von Mingly und muss sich im Modell abbilden.

---

## 10. Was offen ist (braucht Holgers Entscheid)

1. **Der Hugging-Face-Blocker fuer die Sprechertrennung.** Die Uebernahme der
   Pipeline ist entschieden; offen bleibt, wie die `pyannote`-Gewichte zum Kunden
   kommen. Beide Modelle sind gated, die Lizenzen (MIT bzw. CC-BY-4.0) erlauben
   Weitergabe aber ausdruecklich. **Naechster Schritt liegt bei Holger:** eingeloggt
   den Volltext der Bedingungen lesen. Details und die vier Wege in 10.3,
   Punkt "Der Blocker".
2. **Die `TENANT_ORIGIN`-Frage** aus 6.1: darf ein Kunde die Residenz seiner eigenen
   Infrastruktur erklaeren?
3. **Welches Modell in welcher Betriebsform?** (praezisiert nach der Messung)
   `large-v3` braucht GPU, `turbo` laeuft auf CPU bei 2,3x Echtzeit mit etwas hoeherer
   Fehlerrate. Zu messen bleibt echte Container-Hardware.
4. **Mobile: PWA oder native?** Haengt an der iOS-Messung aus Abschnitt 5a. Eine PWA
   kostet fast nichts und kommt ohne App Store; native kostet eine zweite Codebasis,
   loest aber die Hintergrundaufnahme sicher.
5. **Zielbranche fuer die erste Version.** "Moeglichst viele Unternehmen" ist das Ziel,
   aber die erste Version braucht einen Zuschnitt — Kanzlei, Verwaltung und Marktforschung
   wollen verschiedene Dinge zuerst.

## 10.1 Entscheidungsvorlage: Betreiber oder Lieferant

Die Frage ist nicht technisch. Derselbe Code laeuft in allen drei Betriebsformen
(Abschnitt 5) - entschieden wird, **wer die Daten in der Hand hat** und damit, welche
Pflichten, Kosten und Risiken bei digital opua landen.

| | **Lieferant** (Software-Hersteller) | **Betreiber** (Dienst) |
|---|---|---|
| Was wir verkaufen | die App und ein Container-Image | Zugang zu einem Dienst |
| Wo liegen die Daten | beim Kunden, immer | bei uns |
| Rolle nach nDSG | keine - der Kunde ist allein Verantwortlicher | **Auftragsverarbeiter** |
| Was das verlangt | Lizenzvertrag, Sicherheitsupdates, Doku | AVV mit jedem Kunden, Verzeichnis der Verarbeitungen, Subprozessor-Liste, TOM-Katalog, Loeschkonzept, Meldepflicht bei Datenpannen |
| Haftung im Ernstfall | Gewaehrleistung fuer Software | wir haften fuer **fremde Mandanten- und Personalgespraeche** |
| Laufende Kosten | nahe null | Hosting, GPU, Monitoring, Backups, Pikett |
| Umsatzform | Lizenz pro Platz oder Jahr | Abo, wiederkehrend |
| Marge | hoch, skaliert ohne Infrastruktur | sinkt mit der Rechenzeit |
| Wen wir erreichen | Firmen **mit** IT-Faehigkeit, plus Einzelne lokal | **auch KMU ohne IT** |
| Was weh tut | Support in fremden Umgebungen; "bei mir laeuft es nicht" | Betriebsverantwortung rund um die Uhr, Versicherung, Zertifizierungsdruck |

### Der Zusammenhang, der leicht uebersehen wird

"Moeglichst viele Unternehmen" (Abschnitt 2) und "Phone im Meeting" (Abschnitt 5a) ziehen
**beide in Richtung Betreiber.** Ein Betrieb mit zwanzig Leuten, der sein Telefon auf den
Sitzungstisch legen will, betreibt keinen Container - und die mobile Aufnahme braucht einen
Server-Gegenpart, weil auf dem Telefon nicht transkribiert wird. Wer diese zwei Ziele
ernst nimmt, waehlt damit faktisch den Betrieb.

### Entschieden (Holger, 2026-10-25)

**Als Lieferant anfangen, den Betrieb als zweite Stufe planen, nicht ausschliessen.**

- Die App und der Container sind ohne Betriebsrisiko verkaufbar und beweisen das Produkt.
- Die Entscheidung ist **nicht irreversibel**: `DeploymentMode` traegt alle drei Formen,
  derselbe Code laeuft lokal, beim Kunden und bei uns.
- Was dabei trotzdem jetzt entschieden werden muss, weil es spaeter teuer wird:
  Mandantentrennung im Datenmodell. Wer von Anfang an so baut, als liefe es fuer viele
  Mandanten auf einer Installation, kann spaeter betreiben. Wer es nicht tut, muss
  umbauen (`rbac-manager.ts` ist dafuer die Grundlage und schon vorhanden).
- **Die mobile App gehoert in die zweite Stufe**, nicht in die erste - sie setzt den
  Betrieb fast zwingend voraus.

---

## 10.2 Stufenplan und die Dinge, die Stufe 1 nicht verbauen darf

### Stufe 1 - Lieferant

| Enthalten | Nicht enthalten |
|---|---|
| Lokale App: Aufnahme importieren, `on-device` transkribieren, Editor, Export | kein von uns betriebener Dienst |
| Container fuer die Private Cloud des Kunden, GPU empfohlen | keine mobile App |
| Residenz-Policy fuer Audio (deklariert, Abschnitt 4) | kein AVV, kein Verzeichnis der Bearbeitungen - wir bearbeiten nichts |
| Aufbewahrung und Loeschung pro Arbeitsbereich einstellbar | keine Abrechnung nach Audiominuten |
| Lizenzstufe und Feature-Gate | |

### Stufe 2 - Betrieb

Von uns betriebene Instanz in der Schweiz mit GPU, dazu die ganze Kette der
Auftragsbearbeitung (AVV, Verzeichnis, Subprozessor-Liste, TOM-Katalog, Loeschkonzept,
Meldewege, Versicherung), Abrechnung nach Audiominuten, und die mobile Aufnahme
aus Abschnitt 5a samt Einwilligungsschritt.

### Was Stufe 1 nicht verbauen darf

Hier entscheidet sich, ob "nicht irreversibel" stimmt. Jede dieser Annahmen waere in
Stufe 1 bequem und in Stufe 2 ein Umbau:

1. **Mandantentrennung im Datenmodell von Anfang an.** Jede Aufnahme, jedes Transkript,
   jeder Job und jeder Audit-Eintrag traegt eine Mandanten-Kennung - auch wenn in
   Stufe 1 jede Installation genau einen Mandanten hat.

   **Korrektur einer frueheren Annahme in diesem Dokument (gemessen 2026-10-25):**
   `rbac-manager.ts` ist **nicht** die fertige Grundlage. Gemessen wurde:
   - Es exportiert `Role`, `Permission`, `Organization`, `OrgSettings`, `Team`,
     `BudgetLimit`, `UserProfile`, `AuditEntry`, `RBACConfig` - also das **Vokabular**.
   - Diese Daten leben in einer **Konfigurationsdatei** (`loadConfig`, `migrateConfig`),
     nicht in der Datenbank, und werden nur von `ipc/ipc-utils.ts` und
     `ipc/rbac-handlers.ts` benutzt.
   - **Keine** der elf SQLite-Tabellen traegt eine Besitzer- oder Mandanten-Spalte.
     `conversations` hat `id, title, provider, model, created_at, updated_at` - mehr nicht.
     (Geprueft auf `user_id`, `owner`, `org_id`, `tenant`, `account_id`, mit
     Positivkontrolle auf `CREATE TABLE`.)

   Mandantentrennung bedeutet also: eine Migration **aller** Tabellen plus die
   Verlagerung der RBAC-Daten aus der Konfigurationsdatei in die Datenbank. Das ist
   kein Nebensatz. Es ist jetzt billig, weil keine Kundendaten im Feld liegen, und
   spaeter teuer, weil es dann bei jedem Kunden eine Datenmigration ist - womit der
   Entscheid "Betrieb nicht ausschliessen" genau hier seinen Preis hat.
2. **Kein "ein Nutzer pro Installation".** Nichts darf annehmen, dass der Anwender
   gleich dem Besitzer der Daten ist.
3. **Speicherort konfigurierbar, nicht fest lokal.** Audio und Transkript liegen dort,
   wo die Konfiguration sagt - nicht hart in einem Benutzerverzeichnis.
4. **Aufbewahrungsfristen pro Mandant, nicht global.** Ein Betrieb hat je Kunde andere
   Fristen; eine globale Einstellung muesste spaeter zerlegt werden.
5. **Der Audit-Pfad ist mandantenbezogen.** Wer spaeter einem Kunden Rechenschaft
   schuldet, braucht dessen Eintraege getrennt - nachtraeglich ist das nicht herstellbar.

Punkte 2 bis 5 kosten in Stufe 1 wenig. Punkt 1 kostet eine Datenmodell-Migration,
und sie ist der eigentliche Preis des Entscheids "nicht ausschliessen". Ohne diese
fuenf Punkte ist Stufe 2 ein Neubau.

---

## 10.3 Befund zu TranscriboZH (gelesen am 2026-10-25)

Quelle: `github.com/machinelearningZH/audio-transcription`, MIT, shallow clone,
nur gelesen. Die Fragen waren: welche Parameter, wie werden lange Aufnahmen
segmentiert, wie ist die Sprechertrennung angebunden.

### Der Stack ist nicht der erwartete

Nicht plain Whisper, sondern **WhisperX 3.2.0** (`requirements.txt`), dazu
`pyannote.audio 3.1.1` und - fuer Apple Silicon - `mlx_whisper 0.4.1`
(`requirements-mps.txt`). Die Pipeline in `src/transcription.py` ist fuenfstufig:

1. Transkription (`model.transcribe(audio, batch_size=..., language=...)`;
   auf MPS stattdessen `mlx_whisper` mit `mlx-community/whisper-large-v3-mlx`),
2. **forced alignment** (`whisperx.load_align_model` + `whisperx.align`) - daher
   kommen die wortgenauen Zeitstempel, auf denen ein synchroner Editor aufsetzt,
3. optionale Spracherkennung **pro Segment** mit Schwelle 0.85 (mehrsprachige Sitzungen),
4. Diarisation (`diarize_model(audio_data, num_speakers=...)`, dann
   `whisperx.assign_word_speakers`),
5. **Text-Cleanup gegen `data_leaks`**.

### Die drei Dinge, die man nicht nachbaut

1. **`data_leaks` in `data/const.py`** - eine handgepflegte Liste von
   Whisper-Halluzinationen aus Untertitel-Trainingsdaten, pro Sprache. Fuer Deutsch
   unter anderem "Untertitel im Auftrag des ZDF, 2017" (und 2018, 2020, 2021),
   "Copyright WDR 2021", "Untertitel von Stephanie Geiges", Amara.org-Credits.
   Whisper reproduziert diese bei Stille oder unklarem Audio. **Das denkt sich
   niemand aus - das entsteht im Betrieb an echtem Material.**
2. **Der `get_prompt`-Patch** (`src/transcription.py`, eingehaengt in `worker.py:258`
   per `types.MethodType`). Er baut den Decoder-Prompt so um, dass `previous_tokens`
   **nur** noch mitgegeben wird, wenn auch ein `prefix` (Hotwords) vorliegt - im
   Original von faster-whisper immer. Das ist genau die Kontext-Unterdrueckung, die
   in der eigenen Messung (`2026-10-25-whisper-messung.md`) den Unterschied zwischen
   46 % und 5,96 % Fehlerrate gemacht hat. **Sie haben denselben Befund, als Code.**
3. **Die Verdrahtung** von Transkription, Alignment, Diarisation und
   Sprecher-Zuordnung inklusive Sprecher-ID-Offset beim Mischen mehrerer Spuren
   (`num_speakers_detected`, ffmpeg `amix` in `worker.py`).

### Antwort auf die Segmentierungsfrage

**Es gibt kein eigenes Chunking langer Dateien.** `multi_mode` und `amix` mischen
mehrere Eingabespuren zu einer (etwa eine Spur pro Teilnehmer); der
`num_speakers_detected`-Offset verhindert dabei Sprecher-ID-Kollisionen. Die
Segmentierung ist vollstaendig an WhisperX delegiert, das ueber
Sprachaktivitaetserkennung batcht - **in dieser Sitzung nicht im Bibliothekscode
verifiziert**, sondern aus dem Fehlen eigener Chunking-Logik geschlossen.

### Was das README unabhaengig bestaetigt

- "transcription on a CPU is **extremely slow**", Empfehlung **mindestens 8 GB
  VRAM**, besser 16 GB. Deckt sich mit der eigenen Messung (1,5x Echtzeit auf CPU).
- "up to **15 times faster than real-time**" - eigene Messung 11,4x auf Metal mit
  q5_0. Gleiche Groessenordnung, zwei unabhaengige Quellen.
- `BATCH_SIZE` 4 bei 8 GB VRAM, 32 bei 16 GB.
- Whisper large v3 **nicht quantisiert** (die eigene Messung nutzte q5_0 - deren
  Qualitaet ist also potenziell besser, der Speicherbedarf hoeher).
- **"Make sure not to run the worker script multiple times"** - mehr als ein Worker
  frisst das VRAM. Fuer einen Mehrbenutzer-Dienst ist damit **nicht der Durchsatz
  die Kapazitaetsgrenze, sondern ein Worker pro GPU**, Jobs streng serialisiert.
  Das gehoert in jede Kapazitaetsrechnung der Private Cloud.
- Das Repo fuehrt einen ausformulierten rechtlichen Hinweis, der den **EU AI Act**
  und Schweizer Recht nennt (`worker.py`). Die Autoren waren rechtlich beraten.

### Der Blocker

Das README verlangt: die **User Conditions von zwei Modellen** akzeptieren
(`pyannote/segmentation` und `pyannote/speaker-diarization-3.0`) und einen
**Hugging-Face-Token mit read- und write-Rechten** anlegen. Im Code:
`Pipeline.from_pretrained("pyannote/speaker-diarization", use_auth_token=os.getenv("HF_AUTH_TOKEN"))`.

Fuer eine **ausgelieferte App** heisst das: jeder Kunde braeuchte einen eigenen
Hugging-Face-Account und muesste zwei Modellbedingungen akzeptieren. Das ist fuer
ein kommerzielles Produkt nicht zumutbar.

**Geprueft am 2026-10-25 (Modellkarten):**

| | `speaker-diarization-3.1` | `speaker-diarization-community-1` |
|---|---|---|
| gated | **ja** | **ja** |
| Lizenz | MIT, "will always remain open-source" | CC-BY-4.0, "will always remain freely accessible" |
| zu akzeptieren | HF-Informationen teilen, dazu E-Mails ueber "premium pipelines and paid services" | dasselbe |
| zusaetzlich | auch `pyannote/segmentation-3.0` | - |
| Volltext der Bedingungen | nur eingeloggt sichtbar | nur eingeloggt sichtbar |

Damit ist der naheliegende Ausweg - ein ungated Alternativmodell - **widerlegt.**

**Was das Bild aber praeziser macht:** Das Gate ist eine **Zugangskontrolle plus
Datenschutz-Einwilligung** gegenueber pyannote, keine Lizenzbeschraenkung. Die
Lizenzen selbst (MIT bzw. CC-BY-4.0) erlauben Weitergabe ausdruecklich. Wer die
Gewichte einmal rechtmaessig bezogen hat, darf sie danach unter diesen Lizenzen
mit einem Produkt ausliefern - bei CC-BY-4.0 mit Namensnennung.

**Noch nicht geklaert, und nur mit Konto klaerbar:** der Volltext der Bedingungen.
Sollte er eine Weitergabebeschraenkung enthalten, widerspraeche das der
MIT-Lizenz - solche Widersprueche kommen vor und gehoeren vor dem Ausliefern
geklaert, nicht danach. **Das Akzeptieren der Bedingungen ist eine Vertragsannahme
und damit Holgers Handlung, nicht die von Claude.**

**Wege, in der Reihenfolge der Pruefung:**

1. **Bedingungen im Volltext lesen** (Holger, eingeloggt) und bei Weitergabeabsicht
   anwaltlich bestaetigen lassen. Das ist der kurze Weg, wenn er aufgeht.
2. **Gewichte mit dem Produkt ausliefern**, Lizenztexte und Namensnennung beilegen.
   Setzt Punkt 1 voraus.
3. **Stufe 1 ohne Sprechertrennung.** Senkt den Wert deutlich - ein Protokoll ohne
   Sprecherzuordnung ist fuer eine Sitzung mit sieben Personen halb so nuetzlich.
4. Eine andere Diarisation (sherpa-onnx, NeMo). Eigener Aufwand, eigene
   Qualitaetsfrage, und keine Messung dazu.

### Entschieden (Holger, 2026-10-25)

**Die Pipeline uebernehmen, nicht die Anwendung.** Konkret aus dem MIT-Repo
mitnehmen: `src/transcription.py`, `data/const.py` (`data_leaks`) und den
`get_prompt`-Patch, mit Copyright-Hinweis wie von MIT verlangt. **Nicht**
uebernehmen: das NiceGUI-Frontend (Mingly hat React), die Qwen-Zusammenfassung
(Mingly hat seine eigene LLM-Schicht mit Residenz-Policy) und die
dateisystembasierte Job-Warteschlange (`data/in`, `data/out` - Mingly hat SQLite).

Damit ist das Python-Subsystem klein und hat einen klaren Schnitt: Audio rein,
Segmente mit Sprechern und Zeitstempeln raus. Das passt zum vorhandenen Muster
(`rag-server`) und laesst Policy, Mandanten, Audit und Oberflaeche dort, wo sie
in Mingly schon sind.

---

## 11. Zu messen, bevor etwas zugesagt wird

- Durchsatz und Fehlerrate nach dem Exit-Kriterium in Abschnitt 5.
- Schweizerdeutsch-Qualitaet an eigenem Material, nicht an Modellkarten.
- Die Hugging-Face-Nutzungsbedingungen der Sprechertrennung (Abschnitt 7).
- Ob ein CH-Endpunkt (Infomaniak oder anderer) ueberhaupt Whisper anbietet und mit
  welchem `dpaStatus` — in der Memory-Notiz zu Infomaniak ist dieser Punkt als offen
  vermerkt.

---

## 12. Naechster Schritt

Dieses Dokument ist der Entwurf. Nach Abnahme folgt ein Plan
(`superpowers:writing-plans`) in `docs/superpowers/plans/`, und vor jeder Zeile
Produktionscode die Messung aus Abschnitt 5 — weil ein Produktversprechen ueber
Geschwindigkeit und Dialektqualitaet ohne Messung geraten waere.
