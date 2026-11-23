# Alle Entscheide (Rulings) dieser Umsetzung

Mechanisch aus progress.md gezogen (5031 Zeilen).
`final-review.md` verlangt, dass JEDER Entscheid, den der Controller an
Holgers Stelle getroffen hat, in den Abschlussbericht wandert, mit dem, was
er kostet, wenn er falsch ist. Diese Datei ueberlebt eine Kompaktierung des
Gespraechskontexts; das Gedaechtnis nicht. Reihenfolge = Ledger-Reihenfolge.

Nur Entscheid-SAETZE, keine Ueberschriften und keine Rueckverweise. Wer mehr
Zusammenhang braucht, liest die genannte Zeilennummer in progress.md.

---

### progress.md:62
### Rulings

- **R1** — `CodingRunOptions` zieht von `agent-executor.ts` nach `src/shared/coding-types.ts` (Task 2). Grund: `tool-registry` braucht den Typ für `ToolContext`, und `agent-executor` importiert `getToolRegistry` aus `tool-registry` — die Gegenrichtung wäre ein Importzyklus. Der Renderer (Task 14) braucht ihn ohnehin aus `shared`. Kosten bei Irrtum: ein Typ liegt eine Ebene zu allgemein, folgenlos.
- **R2** — `EditProposalStore.propose` bekommt `fileContent: string` als vierten Parameter und bleibt synchron, statt async zu werden und selbst zu lesen. Grund: der Store bleibt ohne Dateisystem testbar, und das Lesen gehört dem Handler, der die Pfadprüfungen schon gemacht hat. Kosten bei Irrtum: der Handler liest eine Datei zweimal.
- **R3** — Task 11 prüft vor der Schreibung **zusätzlich**, dass `oldText` im aktuellen Dateiinhalt noch genau einmal vorkommt. Grund: `propose` prüfte gegen den Inhalt zum Vorschlagszeitpunkt; ändert der Nutzer die Datei zwischen Vorschlag und Abnahme, trifft die Ersetzung etwas anderes als im abgenommenen Diff. Der Spec nennt diesen Fall nicht. Kosten bei Irrtum: eine berechtigte Schreibung wird abgelehnt und muss neu vorgeschlagen werden.
- **R4** — `planCommand` bekommt `npmScripts?: readonly string[]` und bleibt rein; der Consumes-Eintrag von Task 12 nennt `projectPath` statt `ProjectWorkspace`. Grund: Argumentprüfung gegen die package.json ist gefordert, eine unreine Funktion wäre schlechter testbar, und das Arbeitsverzeichnis des Befehls ist die Projektwurzel, nicht `.mingly/`. Kosten bei Irrtum: der Aufrufer liest package.json, was er sowieso tut.

### progress.md:171
- **R9 — Policy-Fail-open ist vom Coding-Pfad NICHT erreichbar.** Der Implementer
  meldete als Concern, das generische `atLeast` gebe für einen Level ausserhalb
  seiner Tabelle `false` zurück, was den bekannten `policy-engine`-Fail-open
  bedient. Am Code nachgegangen statt geparkt, weil es ein Anti-Ziel des Designs
  berührt:
  - `policy-engine.ts:59-61` ist tatsächlich fail-open: kein passendes Rule →

### progress.md:221
- **R10 — Umfang von `hasPermission`.** Gemessen: die `read`/`read-create`-Logik liegt
  heute dreimal dupliziert — `file-access-manager.ts:441` (Lesen), `:494` (Anlegen) und
  `transcription-handlers.ts:212` (`READING_PERMISSIONS`). Entscheid: `hasPermission`
  **ersetzt die zwei Stellen in `file-access-manager.ts`** (dieselbe Datei, in der
  Dateiliste von Task 3, und der Task handelt genau von diesem Berechtigungsmodell).
  `transcription-handlers.ts` bleibt **unberührt** — anderes Subsystem, eigener PR.

### progress.md:239
- **R11 — Die 29 übersprungenen Tests sind vorbestehend und umgebungsbedingt.**
  Im Report tauchte erstmals «29 skipped» auf. Gemessen statt angenommen:
  dieser Commit fügt **keinen** Skip hinzu (`git show 319e97e -- tests/` gegen
  `^\+.*(\.skip|\.todo|xit\(|xdescribe)` → leer). Die Quellen sind
  `it.skipIf(process.platform === 'win32')` in `symlink-escape-real-fs.test.ts:288,307`,
  `describe.skip` hinter `run3Layer` in `red-team.test.ts:487`, und

### progress.md:252
- **R12 — `getPermissionLabel` kennt `edit` nicht: Anforderung für Task 14, nicht
  Minor.** `FileAccessTab.tsx:57-61` ist eine `if`-Kaskade über `read`, `create`,
  `read-create`; ein Grant mit `['read','create','edit']` fällt auf «Read + Create»,
  die gefährlichste Berechtigung ist unsichtbar. In Task 3 bewusst **nicht** behoben
  (Datei ausserhalb der Dateiliste, ein Drive-by dort wäre ungereviewt). In den Plan
  als **Pflicht** für Task 14 geschrieben (Commit `abdadb7`), nicht als geparkter

### progress.md:280
- **R13 — Ruling zu Important 1**, weil der Reviewer Varianten anbot statt zu
  entscheiden: die Park-Bedingung wird von «nichts überlebt» auf «nichts überlebt
  **und** Marker unbrauchbar» verengt. Ein Grant mit brauchbarem Marker und leerer
  Berechtigungsliste **bleibt** auf der Allowlist — er gewährt nichts, also ist das
  Behalten harmlos und der wahrheitsgemässe Zustand; ihn mit «Dropped unconfirmed»
  in den Park-Schlüssel zu schieben sagt dem Nutzer, er müsse etwas neu gewähren,

### progress.md:313
- **R14 — Finding 2 war nicht behoben, und mein eigenes Ruling R13 hat den Pfad
  geöffnet.** Selbst am Code nachgelesen (`file-access-manager.ts:92-115`), der
  Re-Review-Befund stimmt Zeile für Zeile:
  - `:105` `surviving.length < dir.permissions.length` und `:106`
    `dir.permissions.filter(...)` greifen **ungeschützt** auf `dir.permissions` zu.
  - Marker vorhanden + `permissions: null` → `survivingPermissions` liefert `[]`

### progress.md:428
- **R15 — Der inkrementelle Guard läuft für JEDEN Agent-Run, die
  Provider-Wechsel-Sperre nur im Coding-Modus.** Der Spec (§6.1) schreibt «vor
  **jedem** `sendMessageWithTools`-Aufruf in der Schleife» ohne Einschränkung auf
  Coding, nennt aber die Wechsel-Sperre ausdrücklich «im Coding-Modus». Der Befund
  aus Abschnitt 2 besteht unabhängig vom Coding-Modus: auch in Agent-Vergleich und
  Subagent-Läufen gehen Tool-Ergebnisse ungeprüft an den Provider.

### progress.md:511
### Rulings zu den drei Concerns von Task 4

- **R17 — Die verworfene `sanitized`-Umschreibung bleibt bewusst offen.** `guardInput`
  liefert `sanitizedText`; der Loop verwirft sie, also reist ein Ergebnis mit
  mittlerem Risiko (Score 1-79) roh mit. Entscheid: **nicht anwenden** in dieser Phase.
  Eine Umschreibung auf ein Tool-Ergebnis verändert Quelltext, den der Agent
  anschliessend bearbeitet — das kann die Datei beschädigen, um die es gerade geht,
  und ist schlimmer als das Restrisiko, solange die Blockschwelle die schweren Fälle

### progress.md:542
- **R18 — `LoopGuardContext.coding` wird entfernt.** Der Implementer hat gemeldet, dass
  nach R16 keine Entscheidung im File das Feld liest, und ausdrücklich **nicht** selbst
  entschieden. Vor der Antwort nach einem späteren Verbraucher gesucht: Task 5s
  `CodingConsentRequest` trägt `runId`, `stepNumber`, `toolName`, `filePath`, `matches`,
  `offers` — die Datei-Zuordnung kommt aus `origins`, nicht aus dem Coding-Kontext;
  der Audit-Eintrag späterer Tasks entsteht im Executor. Also auch downstream unnötig.

### progress.md:661
- **R22 — `postflightGuard` liefert die blockierende Teilmenge.** Der Implementer
  meldete, die Severity-Liste `critical|high` liege nach R21 an **zwei** Stellen
  (`request-guard.ts:183` und im Executor) und drifte damit still, wenn sich die
  Schwelle verschiebt — und hat die gemeinsame Signatur **nicht** unaufgefordert
  geändert. Richtig in beidem.
  Entscheid: `PostflightResult` bekommt die Teilmenge, die `postflightGuard` ohnehin

### progress.md:779
- **R23 — `shield` wird unbedingt verwendet, der Fallback-Zweig entfällt.**
  Seine Beobachtung (1) selbst geprüft: `PrivacyMode` existiert im Main-Prozess als
  **Typ** (`src/main/privacy/pii-types.ts:61`), der konfigurierte **Wert** liegt aber
  in `src/renderer/stores/privacy-store.ts` — im Renderer. Mein Ruling «konfigurierter
  Modus, sonst `shield`» hat damit keinen Primärzweig. Dieselbe Begründung wie R18:
  ein Fallback ohne Primär lehrt den nächsten Leser, es gäbe eine Auswahl.

### progress.md:812
- **R24 — die Anonymisierung dieses Pfades nutzt `vault`, nicht `shield`.**
  Form von R23 bleibt (fester Modus), Begruendung ist neu und belegt:
  1. Ein Knopf «anonymisiert senden» darf nicht von einer Anzeige-Vorliebe
     geschwaecht werden: unter `transparent` gibt der Anonymisierer den Text
     **unveraendert** zurueck (`anonymizer.ts:116`) — der Knopf wuerde das Original
     senden und darueber luegen. Daher fester Modus, nicht der konfigurierte.

### progress.md:835
- **R25 — ein offenes Dialog-Promise bekommt eine Obergrenze, die auf `drop-file`
  faellt.** Ausgeloest von einem automatischen Security-Review (MEDIUM), selbst
  nachgeprueft und **bestaetigt**: der Run-Timeout wird fuer die Dauer der Frage
  geloescht (`agent-executor.ts:374`), und `ask()` wird ausschliesslich durch
  `settle` aufgeloest. Der erreichbare Fall ist **nicht** der langsame Leser, sondern
  ein Renderer **ohne** Consent-Listener: `publishToWindow` wirft nur, wenn gar kein

### progress.md:878
- **R26 — Befund 1 ist echt und geht in die Fix-Runde.** `respond(runId, choice)` sucht
  nur ueber `runId` und validiert gegen die Offers der **aktuell** offenen Frage. Eine
  verspaetete oder doppelt geklickte Antwort kann damit das «send» fuer Datei A auf eine
  spaetere Frage zu Datei B anwenden. Genau die Eigenschaft, fuer die dieses Feature
  gebaut ist. Fix: jede Frage bekommt eine eigene Id, die Antwort fuehrt sie mit, und
  `respond` weist eine Antwort mit fremder Id ab.
- **R27 — Befund 2 ist echt, aber KEIN Task-5-Defekt; er wird zur Anforderung an die
  Lese-Werkzeuge.** `origins` wird in `agent-executor.ts:336-338` nur aus dem Werkzeugnamen
  gebaut, `filePath` bleibt leer. Gemessen: es gibt heute keinerlei dateilesendes Werkzeug
  — `tool-registry.ts` fuehrt `echo` (339) und `decompose_task` (358), dazu MCP-Werkzeuge
  mit beliebigen Argumenten. `filePath` ist im Brief optional (`filePath?: string`), und
  beide Verbraucher behandeln `undefined` (`loop-guard.ts:60`, `consent-broker.ts:100-102`).

### progress.md:893
- **R28 — Befund 3 ist echt, per Mutation belegt.** Nicht auf Zusage geglaubt: ich habe
  `- consentWaitMs` aus `agent-executor.ts` entfernt und
  `tests/unit/agent-loop-guard.test.ts` laufen lassen → **16 Tests bestanden, Exit 0**,
  der Mutant hat ueberlebt (danach `git checkout --` zurueckgenommen, Baum sauber). Der
  Test kann die Anforderung des Briefs also nicht pruefen: die Fake-Timer laufen nach der
  Antwort nie weiter. Geht in die Fix-Runde, und der neue Test muss **unter derselben

### progress.md:906
- **R29 — eine als Minor gemeldete Sache ziehe ich in die Fix-Runde hoch, weil sie MEINE
  ist.** Die Notiz lautet `[Content withheld by user: ...]`. R25 hat einen Pfad geschaffen,
  auf dem das **System** zurueckhaelt (Ablauf der Frist), nicht der Nutzer. Meine Aenderung
  hat diese Formulierung falsch gemacht. Kein Dismissal eines Befundes, sondern eine
  Hochstufung mit Begruendung.


### progress.md:999
- **R30 — die fehlende Verdrahtung gehoert Task 7, und es ist dieselbe Klasse wie R27.**
  Gemessen: `compactToolResult` hat jetzt `targetDir?`, wird in `agent-executor.ts:431`
  aber **ohne** Ziel gerufen, und **kein** Task ruft `ensureProjectWorkspace`. Die vier
  Tasks, die den Executor anfassen (4, 5, 7, 9), verdrahten es alle nicht. Plan-Zeile 613
  behauptete die Durchreichung, wies sie aber niemandem zu. Jetzt Pflicht in Task 7,
  mit Testanforderung gegen die Verdrahtung statt gegen die Teile.

### progress.md:1244
- **R32 — `mode: 'off'` legt keinen Arbeitsbereich an. Skip, nicht Refuse.**
  Im Code bestaetigt (`agent-executor.ts:246-255`): `if (coding)` prueft den Modus-Abgleich
  und ruft dann **bedingungslos** `ensureProjectWorkspace`. Ein `off`-Run ist funktional
  ein normaler Chat-Run, legt aber Verzeichnisse an, chmodet, haengt evtl. an die
  `.gitignore` an und **kann werfen** (schreibgeschuetzte `.gitignore` ohne Eintrag,
  nicht beschreibbares Projekt, Symlink). Dann stirbt ein Run, der keine

### progress.md:1258
- **R33 — Concern 4 ist echt und wird Anforderung an Task 9** (im Plan ergaenzt):
  `ToolContext` fuehrt den `ProjectWorkspace` nicht, der Executor haelt die Instanz nur
  lokal. Task 9 erweitert `ToolContext` und bekommt die **eine** Instanz hineingegeben;
  ein Handler darf kein eigenes `ensureProjectWorkspace` rufen. Er hat richtig
  entschieden, `ToolContext` nicht ueber seinen Brief hinaus zu erweitern.
  **Dritter Vorfall der Klasse R27/R30/R33** — zu jedem produzierten Wert gehoert in

### progress.md:1325
- **R35 — I-3 wird Anforderung an Task 14** (im Plan ergaenzt): `coding.projectPath` ist
  heute ein blosser `string` vom Aufrufer, der Store prueft nur den Modus. Der Pfad muss
  im **Main-Prozess** aus dem Grant zu `directoryId` abgeleitet werden, niemals aus dem
  Renderer. Ein Test muss belegen, dass ein unpassender Pfad **abgelehnt** wird, nicht
  korrigiert. Gleiche Klasse wie `renderer-kann-verzeichnis-allowlist-selbst-erweitern`.
  Heute nicht ausnutzbar, weil die IPC noch kein `coding` uebergibt — genau deshalb

### progress.md:1462
- **R37 — der `.env`-Widerspruch ist MEINER, und er wird fail-closed aufgeloest.**
  Mein Brief listet `.env.example.md` (Zeile 34) unter «muss erlaubt bleiben» und
  begruendet es Zeile 44 als Fehlalarm-Probe, waehrend `.env*` auf der absoluten
  Blockliste steht. Er hat **nicht** still eine Seite gewaehlt, sondern genau diese eine
  Lockerung markiert und zur Entscheidung gestellt — richtig gehandelt.
  Mein Beispiel war schlecht gewaehlt: der strukturelle Punkt (ein Muster, das an einer

### progress.md:1475
- **R38 — Blockliste erweitert** (strengend, also in Scope): `*.pfx` (Geschwister von
  `*.p12`), `id_ed25519*`/`id_ecdsa*`/`id_dsa*` (`id_rsa*` allein ist veraltet),
  `credentials.json`, `secrets.yaml`/`.yml`, `.npmrc`, `.netrc`, `*.db`. **Nicht** zu
  `id_*` verallgemeinert — das fienge `id_generator.ts`. Jeder Eintrag bekommt einen
  Test **und** einen Nachbarnamen, der erlaubt bleibt.
- **R39 — Blockliste muss ZWEIMAL laufen (Anforderung an Task 9).** Sein Befund 2, von
  ihm korrekt als abgeleitet und nicht gemessen gekennzeichnet: ein Link
  `src/config.ts -> ../.env` innerhalb des Grants besteht die Namenspruefung (er heisst
  `config.ts`) **und** die Containment-Pruefung (Ziel im Grant) — und liefert `.env`.
  Also: `isBlockedPath` vor der Aufloesung (verraet nichts) **und erneut auf dem
  `realpath`**. Test muss genau diesen Link legen.
- **R40 — `list_files` filtert jeden Eintrag (Anforderung an Task 9).** Sonst verraet die
  Liste, welche geblockten Dateien existieren; die Ablehnung beim Lesen kommt zu spaet.
- **Seine Zusaetze bleiben, einer mit dokumentierter Begruendung.**
  `CODING_READ_BASENAMES` (Dockerfile, Makefile, `.gitignore`) ist notwendig — eine reine
  Endungsliste wuerde alle endungslosen Dateien ablehnen, und das sind genau die, die
  jemand braucht, der eine Codebase erklaert bekommt.

### progress.md:1542
- **R41 — zweite Erweiterung, diesmal nach FAMILIEN.** I1 fand `secrets.json`,
  `secrets.toml`, `.docker/config.json`, `.yarnrc.yml`, `service-account.json`,
  `.git/modules/*/config`, `.git/config.worktree` lesbar. Zwei davon sind
  **Inkonsistenzen in R38 selbst**: `secrets.yaml` ja / `.json` nein, `.npmrc` ja /
  `.yarnrc.yml` nein. **Lehre, als Regel notiert:** R38 trug Instanzen nach, und das
  Review fand sofort die naechsten. Eine instanzweise wachsende Denyliste laedt die

### progress.md:1550
- **R42 — Doppelpunkt im projektrelativen Pfad wird abgelehnt.** `a.key::$DATA` besteht
  heute die Namenspruefung und faellt nur zufaellig durch die Endungsliste — und
  «zufaellig geblockt ist nicht geblockt» war meine eigene Begruendung fuer R38. Windows
  ist Build-Ziel. Der Reviewer sagte ausdruecklich, er habe es nicht auf NTFS getestet;
  dafuer braucht es keinen Beweis, weil Ablehnen billig und fail-closed ist.
- **R43 — vier Testluecken hochgestuft, mit Begruendung.** Von neun Mutationen ueberlebten
  fuenf: `!== ".."`, der Glob-Syntax-`throw`, der `dot <= 0`-Guard und zwei
  nahezu-aequivalente Mutanten. Die zwei letzten lasse ich bewusst liegen —
  near-equivalent mutants sind ein bekanntes Artefakt der Methode, kein Defekt.
  Dazu: **der `ü.pem`-Test kann aus dem genannten Grund nicht fallen**, weil `*.pem` die
  Datei bei jeder Normalform blockt — Klasse «gruen aus dem falschen Grund». Fix am

### progress.md:1630
- **R44 — `secrets.*` wird auf Datei-Endungen eingeengt.** Nebeneffekt seiner Runde:
  `src/secrets.ts` wurde geblockt. Das ist ein Fehlalarm auf genau der Art Datei, die der
  Agent lesen soll — ein TypeScript-Modul namens `secrets.ts` ist **Code**, vermutlich
  der Code, der Geheimnisse liest, und enthaelt keine. Die gewollte Familie ist «eine
  **Datendatei** namens secrets», nicht «alles namens secrets». Bleibt eine Familie, kein
  Rueckfall auf drei Schreibweisen.

### progress.md:1671
- **R45 — Umkehr von Deny auf Allow (Fix-Runde 4).** Dritte Wiederholung derselben Form
  in diesem Task: erst die sieben Ausgangsmuster, dann meine instanzweise Erweiterung,
  jetzt die Datenendungsliste. **Die Form ist das Problem, nicht die Eintraege.** Also:
  `secrets.<beliebig>` blocken, **ausser** die letzte Endung ist Code oder Prosa. Damit
  sind auch Formate geblockt, die es noch nicht gibt.
- **R46 — die Ausnahme gilt nur fuer das LETZTE Segment** (zweiter Security-Befund,
  neu und berechtigt). Die Code-Ausnahme ist fuer **Dateinamen** gedacht; ein Ordner
  `secrets.ts/` ist kein Quelltext, waere unter R45 aber ausgenommen, und
  `secrets.ts/api.json` damit lesbar. Also: letztes Segment mit Ausnahme, jedes
  Zwischensegment `secrets` oder `secrets.*` **ohne**. Testfall `secrets.ts/api.json`
  ist der, der R46 von R45 unterscheidet.

### progress.md:1712
- **R47 — `sql` verlaesst die Ausnahme (Fix-Runde 5, die letzte).** Seine Concern 1:
  `secrets.sql` blieb lesbar. **Die Linie, damit es kein Instanzenjagen wird:** die
  Ausnahme gilt Endungen, deren **Zweck** von Menschen geschriebener Quelltext oder
  Prosa ist. `.sql` ist haeufig ein **generierter Dump** — Daten in Code-Kleidung.
  `html`/`css` bleiben ausgenommen (handgeschriebenes Markup, `secrets.html` ist kein
  realer Dateiname) — Verhaeltnismaessigkeit, nicht Versehen.

### progress.md:1778
- **R48 — Restpunkt GEPARKT, nicht gefixt: der Fold dient zwei entgegengesetzten
  Zwecken.** Beim **Blocken** soll er *mehr* fangen (jede Schreibweise, die dieselbe
  Datei oeffnet), beim **Ausnehmen** *weniger* (sonst wird etwas ausgenommen, das gar
  nicht gemeint war). Beide nutzen dieselbe Normalisierung, also **ueber-exemptiert** er:
  `secrets.ts.`, `secrets.ts ` und ein ZWSP-getrenntes `secrets.ts` gelten als Code,
  obwohl APFS sie als andere Dateien mit unbekannter Endung fuehrt.

### progress.md:1788
- **R49 — Fix-Runde 6, bewusst UEBER dem Cap, mit Begruendung.** `service_account.json`,
  `serviceAccountKey.json` und `client_secret*.json` sind lesbar, waehrend
  `service-account*.json` blockt — **zum vierten Mal Instanz statt Familie**, und wieder
  von mir. Fix an der **Form**: fuer die Zugangsdaten-Basisnamen Trennzeichen
  herausfalten (Bindestrich, Unterstrich, camelCase-Grenze als dasselbe), `client_secret`
  in dieselbe Familie. **Nicht** als allgemeine Regel — `.npmrc` und `id_rsa` duerfen

### progress.md:1813
  - `Task 8: parked — die Zugangsdaten-Regel greift nur bei .json (client_secret.yaml, service_account.yml nicht erfasst). Ruling: schmal. GCP-Service-Accounts SIND JSON, Googles OAuth-Datei heisst client_secret_*.json; secrets.* deckt die YAML-Seite ohnehin. Kein reales Format bleibt offen.`
  - `Task 8: parked — Praefix-Treffer blockt auch clientsecretary.json. Ruling: richtig dimensioniert. clientsecrets.json ist der echte alte Google-Bibliotheksname und MUSS blocken; der Fehlalarm ist hypothetisch.`
  - `Task 8: parked (R48) — der Fold dient Blocken und Ausnehmen zugleich, ueber-exemptiert deshalb (secrets.ts., secrets.ts mit Leerzeichen, ZWSP). Struktureigenschaft, gehoert in einen Umbau der Ausnahme-Pruefung. → Abschluss-Review.`
- **Die Linie zu halten war hier die Entscheidung.** Seine beiden letzten Bedenken waren
  ernsthaft, aber messbar kleiner als die vorherigen — das ist das Signal, dass eine
  Schleife ihren Ertrag ausgeschoepft hat. Eine Schleife, die nach jeder Antwort noch
  eine Frage findet, hoert sonst nie auf.

### progress.md:1849
- **R50 — Fix-Runde 1: Paging muss ins Ergebnis-Budget passen.** Im Code bestaetigt:
  `read-tools.ts:424` haengt den Fortsetzungs-Hinweis **ans Ende**, `tool-registry.ts:279`
  schneidet danach bei `maxResultChars` (4000). Ueberschreitet der Ausschnitt das Budget,
  liegt der Schnitt **im Rumpf** und der Hinweis ist **ganz weg** — das Modell sieht
  `… [truncated]` und hat keinen Offset zum Fortsetzen.
  **Der groessere Punkt:** das Werkzeug bewirbt Paging bis **2000 Zeilen**, liefert aber

### progress.md:1882
- **R51 — ReDoS im Glob-Compiler (bestaetigt).** `read-tools.ts:139` baut `[^/]*`- und
  `.*`-Ketten und gibt sie an `new RegExp`. **Beide** Eingabequellen sind in der
  Bedrohungslage dieses Features unvertrauenswuerdig: `args.pattern` schreibt das
  **Modell**, die `.gitignore`-Regeln gehoeren dem **gelesenen Projekt**. Ein Agent, der
  ein fremdes Repository erklaert, fuehrt dessen `.gitignore` direkt in einen
  Regex-Compiler. Electron-**Haupt**prozess: ein Haenger friert die ganze App ein.

### progress.md:1893
- **R52 — Dialog-Spoofing (bestaetigt).** Zeile 508 entfernt nur C0 und DEL; Bidi-
  Overrides (U+202A–U+202E, U+2066–U+2069) und andere Format-Zeichen ueberleben. Der
  angezeigte Pfad ist **der Text des Modells**, und der Dialog ist die Stelle, an der ein
  Mensch entscheidet.
  **Der Fix ist nicht besseres Filtern, sondern die richtige Quelle:** `realRelPosix`
  existiert bereits (Zeile 405) — der aufgeloeste, projektrelative Pfad. Der Dialog soll

### progress.md:2096
- **R55 — der Budget-Rat ist falsch, und die Reihenfolge ist der Grund.** Gemessen:
  45 000 Dateien mit **80 gewoehnlichen** Regeln treffen das Budget nach 178 ms (mit 20
  Regeln laeuft derselbe Baum in 235 ms vollstaendig durch). Der Marker ist ehrlich, aber
  sein Rat «mit `pattern` eingrenzen» **hilft nicht**, weil die Ignore-Regeln **vor** dem
  Pattern-Test laufen.
  **Falscher Rat ist eine eigene Fehlerklasse:** der Nutzer folgt ihm, nichts wird besser,

### progress.md:2134
- **R56 — vierte Wiederholung der Klasse «produziert, aber niemand traegt es».**
  (R27 originForToolCall, R30 Arbeitsbereich in den Executor, R33 Workspace in
  `ToolContext`, jetzt R56.) Hier besonders leicht zu uebersehen, weil der Fall **anders**
  liegt: `CODING_ACCEPT_EDITS` und `CODING_UNDO_RUN` laufen **nach** dem Run, vom Nutzer
  ausgeloest — die Instanz des Executors existiert dann nicht mehr.
  Entscheid: der IPC-Handler **rekonstruiert** mit `ensureProjectWorkspace`, zulaessig

### progress.md:2202
- **R57 — die Zeitschranke wird aus der Messung abgeleitet, nicht geraten.** Er hatte die
  Schranke des Hostile-Tests im selben Commit von 1500 auf 2500 ms angehoben. Sachlich
  begruendet (Budget verfuenffacht), aber **nicht aus einer Messung abgeleitet** — und
  das ist formal genau die Bewegung, die meine Regel «nie zum Gruenwerden: Timeout
  hochsetzen» verbietet. Eine geratene Schranke ueber einer verfuenffachten Grenze faengt
  die naechste Regression nicht. Jetzt gibt es auch keinen Grund mehr zu raten.

### progress.md:2211
- **R58 — der Marker raet weiter falsch, eine Ebene tiefer.** Geht das Budget fuer
  **Verzeichnis**-Ignore-Regeln drauf, hilft `pattern` nicht, der Marker empfiehlt es
  trotzdem. Dieselbe Klasse wie R55, dieselbe Messlatte: ein Rat, der nicht wirken kann,
  ist schlechter als keiner. Meldung soll davon abhaengen, **wo** das Budget hinging.
- **R59 — die zweite Haelfte des Late-Write-Tests kann nicht fallen** (Schritt 2
  ueberschreibt Schluessel `'0'` ohnehin, also entlarvt sie keine run-weite Senke).
  Klasse «gruen aus dem falschen Grund», diesmal vom Re-Review gefunden.

### Task 9 — abgeschlossen


### progress.md:2271
- **R60 — der abgenommene Diff muss das sein, was geschrieben wird. MEIN Fehler.**
  Seine Dedupe verweigert zwei Vorschlaege je Datei im **selben** Schritt, erlaubt aber
  einen im **naechsten** — dessen `oldText` wurde gegen die Datei **ohne** den offenen
  ersten geprueft. Ich hatte das an Task 11 verwiesen («beim Anwenden erneut pruefen»).
  **Zu schwach:** die Nachpruefung wuerde den zweiten Vorschlag **ablehnen** — dann hat
  der Mensch etwas abgenommen, das nie angewandt werden kann; und trifft der `oldText`

### progress.md:2285
- **R61 — Trojan Source im Diff.** Er strippt Steuerzeichen aus dem **Pfad**, nicht aus
  den **Diff-Zeilen**: ein Vorschlag kann Bidi-Overrides enthalten, sodass der abgenommene
  Code anders **liest** als er **ist** — gezielt auf das Abnahmefenster, auf dem dieses
  Design ruht. **Nicht strippen** (das aenderte still das Geschriebene), sondern
  **sichtbar escapen** (`<U+202E>`) und den Vorschlag markieren, der solche Zeichen
  einfuehrt. Gespeichert bleibt byte-exakt.
- **R62 — meine eigene Oracle-Entscheidung revidiert, zugunsten der staerkeren.**
  Ich hatte entschieden: Zahl behalten, Fehlversuche je Pfad deckeln, Audit sehen lassen
  («Kanal begrenzen statt Meldung verwischen»). Der Security-Review zeigt die bessere
  Antwort, und sie folgt aus der **Kerneigenschaft dieses Features**: *jeder Inhalt, den
  der Agent selbst einsammelt, laeuft durch denselben Klassifikator wie getippter Text.*
  `edit_file` **liest** die Datei — der Inhalt ist eingesammelt, und der Klassifikator

### progress.md:2326
- **R63 — meine Aufraeumregel war falsch, und zwar im Kriterium.** Ich hatte die
  Aufraeumung bestellt, damit ein Vorschlag aus einem **abgebrochenen** Run nicht spaeter
  angenommen wird. Formuliert habe ich sie als «Run-Ende» — und `endRun` raeumte damit
  auch nach **normalem Abschluss** auf.
  **Das ist der Normalfall dieses Features:** vorschlagen, Run endet, **dann** prueft und
  nimmt der Mensch ab. Mein eigenes R56 stellt das sogar ausdruecklich fest. Mein FIX A

### progress.md:2338
- **R64 — Task 14 muss `introducesHiddenCharacters` AUFFAELLIG zeigen** (im Plan, Commit
  `a455e0e`): ein Vorschlag kann Bidi-Overrides enthalten, sodass der abgenommene Code
  anders **liest** als er **ist**. Gespeichert bleibt byte-exakt, die Anzeige escapt
  sichtbar — aber die Oberflaeche muss auch sagen, **dass** solche Zeichen eingefuehrt
  werden. **Ein Hinweis, den man uebersehen kann, ist hier kein Hinweis.**
- `Task 10: parked — auf einer vom Detektor markierten Datei verraet ein ERFOLGREICHER Vorschlag weiterhin "genau einmal". Nicht geschlossen, weil der Detektor auch E-Mails, private IPs und /Users-Pfade markiert; alle Edits auf solchen Dateien zu verweigern wuerde die meisten realen Dateien unbearbeitbar machen — und ein Guard, der gewoehnliche Arbeit blockiert, wird abgeschaltet.`

### progress.md:2360
- **R65 — Gesamtmass deckeln, nicht die Teile. DRITTER Vorfall desselben Musters.**
  Task 8: jede Blocklisten-Regel gedeckelt, die Gesamtarbeit nicht.
  Task 9: `.gitignore` auf 200 Zeichen und 1000 Regeln gedeckelt — das **Produkt** mit der
  Eintragszahl ergab 35 s blockierten Hauptprozess.
  Task 10: 200 Vorschlaege je Run, 1 Mio. Zeichen je Text, 20 Runs — zusammen in der
  Groessenordnung **Gigabyte**, in einem In-Memory-Speicher im **Haupt**prozess, wo das

### progress.md:2398
- **R66 — GEPARKT mit Empfehlung, nicht entschieden: wen die Verdraengung treffen darf.**
  Seine Policy (ausgesprochen, nicht begraben): ein Run **in Pruefung** ist nicht
  geschuetzt, der aelteste aufbewahrte wird verdraengt; nur ein noch **laufender** Run ist
  geschuetzt, dann wird der neue Vorschlag abgelehnt.
  **Meine Gegenposition, fuer das Abschluss-Review:** die Asymmetrie spricht anders. Ein
  **abgelehnter** neuer Vorschlag ist erholbar — der Mensch raeumt auf, der Agent

### progress.md:2505
- **R67 — Task 11 MUSS `editStillMatches` rufen** (im Plan, Commit `ecb2dc6`). Ohne den
  Aufruf ist der Identitaetsbeweis gebaut und unbenutzt. Die `oldText`-Pruefung allein
  genuegt nicht: sie faengt eine Nutzeraenderung **anderswo** in der Datei nicht, und die
  Ein-Vorschlag-Regel ist **run-lokal**. Test muss eine Aenderung **ausserhalb** des
  Trefferbereichs ablehnen.
- **Der vorhergesagte Flake ist eingetreten, und die Antwort lag vorab fest.** Sein

### progress.md:2538
- **R68 — die drei uebrigen Zeitschranken folgen, und zwar mit Messung als Begruendung.**
  Er meldete sie als Nebenbemerkung («wide margin»), aber die Arithmetik sagt anderes:
  `list_files pattern` liegt bei ~118 ms gegen 500 ms = **Faktor 4,2**. Der eben
  gefallene Test lag bei 481-498 ms gegen 2000 ms = **Faktor 4** — und erreichte unter
  Last **5276 ms**. **Ein vierfacher Spielraum ist nachweislich nicht genug.** Damit ist
  seine Bemerkung ein Befund, keine Vorsicht.

### progress.md:2594
- **R70 — Befund 4 NOT ADDRESSED: ein einzelnes `indexOf` ist quadratisch.** Ich hatte
  «Zaehlen bricht beim zweiten Treffer ab, also hoechstens zwei Suchen» als Schranke
  akzeptiert. Das begrenzt die **Anzahl** der Suchen, nicht die **Kosten einer**.
  **Selbst reproduziert:** Heuhaufen 400 000 `a`, Nadel `a`x100000 + `b` + `a`x99999, ein
  Aufruf → **4743 ms**, genau die 4,7 s des Reviews. Skalierung 356 → 1271 → 4743 ms bei
  Verdopplung, also klar quadratisch; auf 2 MiB hochgerechnet ~130 s, gemessen hat das

### progress.md:2614
- **R71 — U+180F** (Mongolischer freier Variationsselektor 4) bleibt unescapt, rendert
  nichts und ist in einem JS-Identifier gueltig (`var a᠏=1` evaluiert). Alles andere
  aus Default_Ignorable, White_Space, Variation_Selector, Join_Control und Bidi_Control
  ist gedeckt — also eine einzelne Luecke, kein falscher Ansatz. Mit Kommentar, dass die
  Liste bei Unicode-Updates nachzuziehen ist.
- **R72 — die ERFOLGSmeldung verraet die Struktur um den Treffer.** `Proposed (-R/+A lines)`
  variiert mit dem Umfeld: bei alt `KEY=` und neu `KEY=\n` ergaben sich -1/+1, -0/+1 oder
  -1/+2, je nachdem ob der Treffer die Datei beendet, ein Zeilenumbruch folgt oder er eine
  Zeile beginnt. Vorbestehend, nicht aus diesem Diff — und der Fix ist eine **Loeschung**:
  Zaehler aus dem **modellsichtbaren** Text raus. Sie kosten nichts, denn das Modell hat
  alt und neu selbst geschrieben und kennt die Groesse seiner Aenderung; **das Einzige**,

### progress.md:2627
- **R73 — ein einzelnes Surrogat** wird als `<U+D800>` **angezeigt**, aber als U+FFFD
  **geschrieben**. Anzeige und Speicherform duerfen nicht divergieren, und faithful
  schreiben kann man es gar nicht → ablehnen, wie NUL und ungueltiges UTF-8.
- **Bestaetigt als richtig:** seine Unterscheidung, dass die untere Byte-Schranke **nicht**
  als Fehlversuch zaehlt (haengt nur an Pfad, beiden Texten und der Speichersumme, nie an
  der Datei) — das Review hat es nachgeprueft. Und der geaenderte Test ist korrekt

### progress.md:2634
- **R69 — wie Task 11 `editStillMatches` rufen MUSS** (im Plan, `8e889e3`): je Datei
  pruefen **und** schreiben, **sequenziell** (zwei Hardlink-Namen bestehen sonst beide die
  Vorpruefung); den Pfad **erneut** aufloesen (Symlink-Tausch zwischen Vorschlag und
  Abnahme); durch den **geoeffneten Deskriptor** schreiben (sonst ein weiteres Zeitfenster).

### Task 10 — Fix-Runde 6, und ein neuer Fehlermodus: der kaputte Zufallsgenerator

### progress.md:2699
- **R74 — GEPARKT mit Begruendung: die Linearitaets-Zusicherung ist selbstberichtet.**
  Beide Schritt-Assertions pruefen einen Zaehler, den die Implementierung selbst
  hochzaehlt. Eine **ehrlich zaehlende** quadratische Umsetzung faellt; ein
  `indexOf`-Wrapper, der `steps++` weglaesst, **besteht**, weil 0 jede Obergrenze
  erfuellt. Klasse: **Testinstrument aus dem Pruefling** (Memory-Notiz
  `testinstrument-darf-nicht-aus-dem-pruefling-stammen`).

### progress.md:2737
- **R77 — Concern 4 entschieden: Undo verlangt den Grant, NICHT den Modus. Richtig so.**
  Undo ist der Rettungsweg. Vom Coding-Modus abhaengig gemacht, wuerde Abschalten den
  Nutzer aus der Wiederherstellung **aussperren** — und zwar genau dann, wenn er es am
  ehesten braucht, denn man schaltet ab, **weil** etwas schiefging. Begruendung gehoert
  als Kommentar hin, damit es niemand spaeter «verschaerft».
- **R78 — Concern 3 bestaetigt: nichts bindet einen Run an sein Verzeichnis.**
  `agent-handlers.ts:111/129` nehmen `directoryId` **vom Renderer** und reichen ihn durch.
  Seine Abschwaechungen (Hash-Pruefung, fehlender Snapshot) sind **Nebenfolgen, kein
  Gate**. Vorgabe: Verzeichnis beim Runstart aufzeichnen, Handler nutzen **die
  Aufzeichnung**, eine Abweichung wird **abgelehnt** statt still bevorzugt — eine
  Abweichung heisst, dass Renderer und Main-Prozess uneins sind, und das gehoert sichtbar.
- **R79 — Concern 5: Undo muss sagen, was es NICHT wiederhergestellt hat.** Nur
  wiederherzustellen, wenn die Datei noch auf das hasht, was das Anwenden schrieb, ist
  genau richtig — spaetere Nutzerarbeit darf nie ueberschrieben werden. Diese Dateien aber
  **aus der Liste zu lassen**, laesst ein teilweises Rueckgaengig wie ein vollstaendiges
  aussehen. **Das ist die eine Taeuschung, die ein Rettungsweg nie erzeugen darf.**
  Zwei Gruppen: wiederhergestellt und uebersprungen **mit Grund**.
- **R80 — Security-Befund auf dem Rettungsweg, und die Reichweite selbst geprueft.**
  `apply-edits.ts:686` liest jedes Batch-Manifest aus dem Projekt und **die Platte im
  Projekt ist die einzige Quelle** — keine Autoritaet aussen. Ein Repository kann also
  einen Snapshot mitliefern; wird diese runId je rueckgaengig gemacht, schreibt Undo
  Angreiferinhalt in Nutzerdateien **und praesentiert es als Wiederherstellung**.
  **Begrenzt, und das habe ich nachgesehen:** Zeile 471 fuehrt jeden Manifest-Eintrag

### progress.md:2799
- **R81 — meine Ueberstrenge, an zwei Stellen, und beide kosten nichts zu beheben.**
  Seine Concerns 1 und 3 sind dasselbe Problem: ich habe auf fail-closed gedrueckt, und
  das Ergebnis verweigert Undo **nach einem App-Neustart** und **nach dem Verschieben des
  Projekts** — ausgerechnet zwei Momente, in denen jemand nach dem Rettungsweg greift.
  **Die Autoritaet ist davon gar nicht betroffen.** Autoritaet ist der **Manifest-Hash**
  in `userData`; Projektpfad und In-Memory-Registrierung sind nur **Schluessel** — und ein

### progress.md:2838
- **R82 — «nichts zu tun» ist keine Verweigerung** (im Plan, Commit `3e0139c`, Task 14).
  Drei Gruende, die die Oberflaeche **nicht** gleich aussehen lassen darf: «kein Snapshot
  hier» = es gibt nichts rueckgaengig zu machen (ruhig, am besten den Knopf nicht
  anbieten); «keine Aufzeichnung» = dieser Snapshot stammt **nicht von uns**, kann mit dem
  Repository mitgeliefert sein (echte Verweigerung, deutlich zeigen); «Manifest geaendert»
  = dasselbe eine Stufe schaerfer. Im Code sind die Gruende schon getrennt — die Pflicht

### progress.md:2909
- **R83 — I1, der schwerste Befund des ganzen Plans: der Save eines Nutzers kann
  ueberschrieben werden, unwiederbringlich.** Selbst verifiziert: Zeile 632 hasht den
  **Inhalt** (richtig), aber die Pruefung **unmittelbar vor dem `rename`** ist Zeile 638
  `expectIdentity: { dev, ino }` — reine **Identitaet**. Ein **In-Place-Save**, was die
  meisten Editoren tun, **behaelt den Inode**. Also: Inhalt geprueft → Nutzer speichert →
  Identitaetspruefung besteht (es ist dieselbe Datei) → `rename` landet → und der Snapshot

### progress.md:2923
- **R84 — I7: Accept bindet an einen RUN, nicht an das Paket, das der Mensch gesehen hat.**
  Reproduziert: ein waehrend des Anwendens hinzugefuegter Vorschlag wird als «accepted»
  freigegeben, **ohne geschrieben zu werden**; vor dem Klick hinzugefuegte werden
  **ungesehen angewandt**. Das bricht dieselbe Regel eine Ebene ueber der Datei: der
  Mensch nimmt ein **Set** ab, der Code nimmt einen **Run** ab. Fix: an die Identitaet des
  **gezeigten Pakets** binden (Versionszaehler oder sortierte Id-Menge) und bei Abweichung

### progress.md:2930
- **R85 — I2 verifiziert:** Grant und Modus werden **einmal** vor der Schleife gelesen
  (Zeilen 568-571). Das Review hat den Grant entzogen und den Modus auf `off` gesetzt,
  **nachdem** Datei 1 geschrieben war — Datei 2 wurde trotzdem geschrieben. Der Brief
  verlangt die Pruefung «unmittelbar vor der ersten Schreibung»; sie gehoert **vor jede**.
- **R86 — I6: fuenf «kein Temp uebrig»-Assertions koennen nicht fallen.** `leftovers()`
  filtert auf `.tmp`, die Temps heissen `.mingly-tmp-<hex>`. Entfernt man das `unlink`,
  bleiben **alle 62 Tests gruen**. Fuenf Tests, die nichts behaupten, sind schlimmer als
  keine — sie lassen die Eigenschaft gedeckt **aussehen**.
- **R87 — I4: ein verwaister Batch blockiert den ganzen Run.** Ein `batch-N` ohne Manifest
  und ohne Ledger-Zeile (was ein Absturz in Pass 1 hinterlaesst) laesst Undo **alles**
  verweigern, mit generischer Meldung; der echte Batch blieb unwiederhergestellt. Debris
  schaltet den Rettungsweg ab. Fix: verifizierbare Batches wiederherstellen, die anderen
  als **uebersprungen mit Grund** melden — genau dafuer existiert die Zweiteilung.
- **R88 — I3: die Autoritaet kann still verschwinden, und der Kommentar sagt das
  Gegenteil.** `SimpleStore.save()` **schluckt Fehler** und schreibt nicht atomar; eine
  korrupte Datei laedt als `{}` und verliert damit **jede** Ledger-Zeile. Sein Kommentar
  behauptet, ohne Ledger-Schreibung werde nichts geschrieben. Fix: Zeile atomar schreiben,
  Fehler **propagieren** — oder dieselbe temp-und-rename-Disziplin wie fuer Projektdateien,
  mit Kommentar, **warum** nicht `SimpleStore`.
- **R89 — I5: Prozessabbruch mitten im Anwenden hinterlaesst stillen Teilzustand** und ein
  liegengebliebenes `.mingly-tmp-*`, das niemand aufraeumt; Undo meldet ungeschriebene
  Dateien dann als `changed-since-apply`. Fix: Marker vor dem ersten `rename`, nach dem
  letzten geloescht, damit ein Abbruch **erkennbar** ist; Temps aufraeumen und den Zustand
  **ehrlich** benennen statt zu raten. **Ein Teilzustand, den der Nutzer nicht sehen kann,
  ist das schlimmste Ergebnis dieses Moduls** — ihn benennen zu koennen zaehlt mehr, als

### progress.md:2994
- **R90 — ohne Paket-Digest gibt es kein Accept** (im Plan, Commit `61b3f37`, Task 14):
  `acceptEditsForRun` verlangt `expectedDigest` und **lehnt ohne ihn ab**. Das ist
  Absicht, aber **nichts** liefert den Digest derzeit an den Renderer — also funktioniert
  Accept bis Task 14 **gar nicht**. Mechanik fertig, Verdrahtung nicht. Und die Ablehnung
  bei Abweichung ist eine **Aufforderung**: erneut pruefen, neue Liste zeigen.
- **Er hat zudem Inhaltshygiene mitgenommen, ungefragt:** die Accept-IPC-Antwort liefert

### progress.md:3025
- **R91 — sechs Guards lassen sich entfernen, ohne dass ein Test rot wird**, und **zwei
  davon tragen die Eigenschaft, fuer die der Digest existiert**: `oldText` und `matchIndex`
  in `editFingerprint`. Faellt einer still heraus, gilt ein Paket mit **geaendertem alten
  Text** als «dasselbe, das der Mensch gesehen hat» — der Digest waere noch da und wuerde
  nichts mehr pruefen. **Die teuerste Art toter Guard, weil er wie Schutz aussieht.**
  Dazu: Grant-Pfad-Gleichheit (`:654`, ein Sicherheitscheck) und der Dateimodus in

### progress.md:3032
- **R92 — die redundante Pruefung wird ENTSCHIEDEN, nicht reflexhaft getestet.**
  Der Pass-2-`before`-Hash (`:667`) ist laut Mutationen redundant. Entweder loeschen (mit
  Kommentar) oder mit einem Test festnageln, der ohne ihn faellt. **Eine dritte
  Moeglichkeit — stehen lassen und einen Test schreiben, der nicht fallen kann — ist
  ausgeschlossen.**
- **R93 — ein abgestandener Marker soll sich SELBST heilen, statt gute Arbeit zu opfern.**
  Laesst er sich nach einem sauberen Apply nicht loeschen (oder stirbt der Prozess kurz
  davor), meldet der Apply Erfolg, der naechste wird abgelehnt, und der einzige Ausweg ist
  **Undo einer gelungenen Anwendung**. Der Ausweg ist aber **verifizierbar**: passen
  **alle** Eintraege auf den aufgezeichneten `after`-Hash, **war** der Apply vollstaendig →
  Marker loeschen und weitermachen. Stimmt einer nicht, bleibt das heutige Verhalten —

### progress.md:3044
- **R94 — zwei Formulierungen, die zu viel versprechen:** der Hook heisst «the LAST check»,
  und das Rename-Fenster ist nur fuer **Verzeichnis**tausch dokumentiert, nicht fuer das
  **Inhalts**fenster. Dazu bekommt ein echter Batch, dessen Dateien **alle** vom Nutzer
  geaendert wurden und der neben einem Waisen steht, heute die Unverbuergt-Meldung — die
  beiden sind nicht dasselbe (passt zu R82).
- `Task 11: parked — zwei Ledger-Instanzen auf einer Datei verlieren eine Zeile; Electrons Main ist ein Prozess und die App geht ueber einen Accessor. Er hat offengelegt, dass er Einzelprozess nicht verifiziert hat.`

### progress.md:3350
  nicht in `.git/` schreiben). **Ruling: für Phase 1 durch Dokumentation abgedeckt** —
  ein Satz über symlink-Einträge im Git-Verzeichnis fehlt noch im README. Die
  lstat-alles-Variante des Scans ist nicht nötig.
- **N-2 (Important, neu):** `path.resolve(gitDir, common)` kollabiert `..` **textuell**;
  das Dateisystem tut das nicht, wenn vor dem `..` ein Symlink steht.


### progress.md:4020
**Ruling: die Anforderung fliegt aus Phase 1, der Grund bleibt im Audit.**
Begruendung: der Spec macht Phase 1 ausdruecklich zum *einzelnen* Lauf — kein
Workspace, kein Dateibaum, kein Editor. Einen Ablehnungsgrund an den Agenten zu
liefern, heisst einen **Folgelauf** starten; das ist Iteration und damit Phase 2.
Der Brief-Satz unterstellte einen Dialog mitten im Lauf, den die Architektur
nicht hat. Die Oberflaeche behauptet nichts Falsches, also entsteht keine Luecke

### progress.md:4168
### Ruling: der Branch traegt ZWEI Features, und das Review deckt nur eines

Die Commit-Historie zeigt, was die Dateiliste verraten hat: dieser Branch ist aus
`claude/mingly-transcribo-service-1d5827` gewachsen, hat die PRs #33, #36 und #37
hineingemergt, und das Coding-Feature sitzt obendrauf. Aeltester Commit:
`f6a29ff docs: Transkriptions-Dienst`. Scope-Zaehlung: 33 `fix(coding)`,

### progress.md:4177
**Ruling: das Ganz-Branch-Review deckt Phase 1 Coding, nicht den
Transkriptions-Dienst.** Begruendung: der Transkriptions-Teil hatte eigene PRs
mit eigener Pruefung; ihn jetzt als Teil eines Coding-Reviews zu beurteilen,
erzeugt ein Urteil, das niemand bestellt hat, und zieht Aufmerksamkeit von der
Sicherheitsachse ab, um die es hier geht.
**Was es kostet, wenn der Entscheid falsch ist:** zwei weitere Review-Schnitte,

### progress.md:4190
### Ruling: ein Reviewer wird durch vier ersetzt, aufgeteilt nach Vertrauensgrenze

`final-review.md` verlangt EIN Review auf dem faehigsten Modell. Bei 1.1 MB ist
das nicht durchfuehrbar: ein Agent kann die Befunde des ersten Viertels nicht
halten, waehrend er das vierte liest. Die Vorlage sagt «review it in passes
yourself» — das traegt fuer einen grossen Diff, nicht fuer einen, der den

### progress.md:4561
**Revidiertes Ruling:** die Anforderung bleibt aus Phase 1 (die Praemisse dazu —
der Lauf ist beendet, bevor der Dialog oeffnet — habe ich am Code geprueft und
sie haelt). **Aber der Grund muss dort ankommen, wo das Label ihn verspricht:**
`auditRecords` wird in den Export verdrahtet, zusammen mit den abgelehnten
Vorschlaegen. C-I3 nennt das klein und es macht zugleich die Compliance-Aussage
staerker — «ich kann belegen, was der Agent **nicht** durfte» sind genau die

### progress.md:4751
### Ruling: KEINE dritte Welle jetzt — gebuendelt mit Holgers Entscheiden

`final-review.md` kennt keine zweite Fix-Welle; Restbefunde gehen an den
Menschen. Die neue Important ist klein (ein Aufruf) und haengt an **keinem**
Entscheid, ich koennte sie also sofort beauftragen. Ich tue es nicht:
Welle 2 wartet ohnehin auf den `propose-run`-Entscheid, nichts wird in der

### progress.md:4796
**Ruling: C5 geht nicht in diese Welle, sondern an Holger**, mit allen vier
Optionen. **Lehre:** ich hatte eine Empfehlung ausgesprochen, ohne die Schwelle
nachzurechnen, an der sie wirkt. Das ist Regel E auf eine Empfehlung angewandt —
die Aufloesung ausfuehren, nicht die Absicht lesen. Eine Empfehlung, deren
Wirkungsbereich man nicht gemessen hat, ist eine Vermutung mit Vorzeichen.


### progress.md:4833
### Ruling zur Migration: zwei Dateien, unterschiedlich behandelt

**`file-access.json` wird umgeschluesselt.** Jeder Eintrag traegt seinen `path`,
die neue Id ist daraus eindeutig. Ein frueher ueberschriebener Grant steht nicht
in der Datei (die `Map` schrieb nur ihre Werte) — es gibt nichts
wiederherzustellen.
