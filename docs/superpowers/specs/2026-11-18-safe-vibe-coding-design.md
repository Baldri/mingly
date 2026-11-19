# Safe Vibe Coding — Design

Status: **Freigegeben** durch Holger, 2026-11-18 (Ansatz 1 dann 2; alle drei offenen Fragen entschieden)
Datum: 2026-11-18
Branch: `claude/mingly-vibe-coding-0ce1fd`
Basis-Commit: 4fb7bbc

---

## 1. Intent und Warum

Mingly bekommt einen **Coding-Modus**: der Agent darf Quelltext lesen, aendern und
begrenzt Befehle ausfuehren. Die eine Eigenschaft, die das Feature traegt: **jeder
Inhalt, den der Agent selbst einsammelt, passiert dieselbe Schutzschicht wie vom
Nutzer getippter Text.**

Die Produkt-These (Holger, 2026-11-18): Vibe-Coding-Werkzeuge gibt es reichlich, aber
sie setzen zwei Dinge voraus — dass dein Quelltext in eine US-Cloud darf, und dass du
dem Agenten die Maschine ueberlaesst. Wer das erste nicht darf oder das zweite nicht
will, hat heute kein Werkzeug. Mingly hat die Schutzschicht bereits im Haus; Coding
ist deren zweite Anwendung.

Das Verkaufsargument ist damit **nicht** "wir haben auch einen Agenten", sondern eine
pruefbare Eigenschaft, die Cursor und Copilot strukturell nicht liefern koennen, weil
sie gar keinen Filter besitzen: *Geht der Inhalt, den der Agent eingesammelt hat,
durch denselben Klassifikator, dieselbe Residency-Policy und dieselbe
PII-Erkennung wie getippter Text — ja oder nein?*

### Zielgruppen

Beide, bewusst. Sie wollen keine verschiedenen Funktionen, sie **priorisieren
dieselben verschieden**.

| | A — reguliert | B — vorsichtig |
|---|---|---|
| Wer | Entwickler in Bank, Versicherung, Spital, Verwaltung | Vibe-Coder, oft nicht Vollzeit-Entwickler |
| Darf Cursor | nein (Quelltext in US-Cloud) | ja, traut sich aber nicht |
| "safe" heisst | Quelltext verlaesst die Maschine nicht bzw. nur gefiltert; ich kann es nachweisen | reversibel und eingezaeunt; nichts passiert ohne meine Zustimmung |
| Braucht zuerst | Guard pro LLM-Call, Audit-Trail, Local-Only-Pfad | Diff-Abnahme, Snapshot-Undo, Command-Allowlist |
| Liest Diffs | ja | ungern — braucht spaeter die Oberflaeche (Phase 2) |

---

## 2. Der Befund, der das Design traegt

Gemessen am Code, nicht angenommen.

**Der Guard laeuft einmal, die Schleife laeuft n-mal.**
In `src/main/agent/agent-executor.ts` steht `preflightGuard(...)` auf **Zeile 165**.
Die ReAct-Schleife beginnt auf **Zeile 212**. Geprueft wird
`texts: [...conversationHistory.map(m => m.content), task]` — also die History und der
Auftrag. Ab **Zeile 283** werden Tool-Ergebnisse in `messages` geschoben, und jeder
weitere `clientManager.sendMessageWithTools(provider, messages, model, tools)` schickt
den gewachsenen Stapel an den Provider. Durch den Guard geht davon nichts.

Fuer Chat traegt das: was rausgeht, hat der Mensch getippt, der Eingang sieht alles.
Fuer Coding bricht die Annahme, weil dort **die Maschine liest**. `read_file('.env')`
→ Inhalt in `messages` → naechster Schritt an Anthropic. Der `DataClassifier` in
`src/main/security/data-classifier.ts` hat ein Credential-Muster
(`/\b(password|passwort|private.?key|secret.?key|api.?key|token)\s*[:=]\s*\S+/i`),
das genau das faengt — es wird auf diesem Pfad nur nicht gefragt.

**Gute Nachricht:** `src/main/security/request-guard.ts` ist bereits in `guardInput`
und `guardDispatch` zerlegt, laut eigenem Kommentar *"so the chat IPC path ... can
reuse the SAME logic at its two positions"*. Die Verlegung in die Schleife nutzt also
die Absicht der Architektur, statt gegen sie zu arbeiten. Das senkt das Risiko
erheblich — es ist Verdrahtung, kein Umbau.

**Zwei weitere Luecken, im selben Zug gemessen:**

1. `postflightGuard(output, systemPrompt, deps)` ist in `request-guard.ts:181`
   definiert und wird im **Produktionscode nirgends aufgerufen**. Fuer Coding ist das
   relevant: der Agent gibt Quelltext zurueck, und die Ausgabe-Pruefung liegt brach.
2. Die Tool-Registry registriert genau zwei Werkzeuge: `echo` und `decompose_task`.
   `read_file`, `write_file`, `execute_command` und `web_search` sind **nicht im
   Code**, obwohl das README sie als "Built-in Tools available to all agents"
   bewirbt. `agent-context-manager.ts` verweist in seinen Prompt-Texten sogar auf
   `read_file`. Das ist eine Doku-Diskrepanz, die mit diesem Feature entweder
   eingeloest oder im README korrigiert werden muss.

3. `AgentContextManager.compactToolResult` lagert grosse Tool-Ergebnisse in
   **Temp-Dateien** aus ("File-based Memory"). Bei Coding heisst das Projekt-Quelltext
   auf der Platte ausserhalb des Projekts, mit unklarer Lebensdauer.

---

## 3. Ziele, Nicht-Ziele, Anti-Ziele

### Ziele (Phase 1)

- Der Agent kann in **einem** vom Nutzer gewaehrten Projektverzeichnis Dateien lesen,
  aendern und anlegen.
- Jeder LLM-Call im Agent-Loop passiert den Guard — nicht nur der erste.
- Jede Dateiaenderung wird dem Nutzer als Diff vorgelegt und von ihm abgenommen,
  bevor sie auf die Platte geht.
- Befehle laufen nur aus einer Allowlist und nur im Projektverzeichnis.
- Jede Aenderung erzeugt einen Audit-Eintrag (wer, was, welches Modell, welche Policy-Version).
- Der Coding-Modus ist **abgestuft**, nicht an/aus, und faellt im Zweifel zur strengeren Stufe.
- **Ein einzelner Agent-Run, den der Nutzer in der Chat-Oberflaeche starten kann.** Den
  gibt es heute nicht (siehe Entscheid 1 in Abschnitt 9); der Coding-Modus braucht ihn.
  Minimal gehalten: Modus-Umschalter und Schrittanzeige, kein Workspace — der kommt in
  Phase 2.

### Ziele (Phase 2, nach Freigabe von Phase 1)

- Ein **Coding-Workspace** als eigener ViewMode: Dateibaum, Editor, Diff-Ansicht,
  Befehls-Ausgabe. Damit muss B keine Diffs im Chat lesen.

### Nicht-Ziele

- Sandbox, Container-Isolation, Live-Preview (war Ansatz 3 — eigenes Produkt).
- Git-Integration als Feature (Snapshots loesen das Rueckgaengig-Problem ohne Git).
- Sprachserver, Autovervollstaendigung, Refactoring-Werkzeuge. Mingly wird keine IDE;
  es wird ein Agent mit einer Oberflaeche.
- Mehrere Projekte gleichzeitig.
- **Coding in Agent-Vergleich und Subagent-Modus.** Dort laufen 2-3 Executors parallel
  auf derselben Singleton-Registry; gleichzeitige Schreibvorschlaege auf dieselbe Datei
  haetten weder eine definierte Abnahme noch brauchbare Snapshots. Der Coding-Modus ist
  in diesen Ansichten gesperrt (Entscheid 1).
- Der Agent soll **nicht** autonom durchlaufen. Jede Schreibung wird abgenommen.

### Anti-Ziele — das Feature ist gescheitert, auch wenn es technisch laeuft, wenn

- **Quelltext ungefiltert in die Cloud geht.** Dann heisst das Produkt "safe" und ist
  es nicht. Das ist schlimmer als kein Feature, weil es ein Versprechen bricht, auf
  dem die Marke steht.
- **Der Modus-Schalter alles auf einmal freischaltet.** Ein binaeres "Coding erlaubt"
  ist genau die Mechanik, die wir anderen vorwerfen.
- **Die Abnahme zur Klickstrecke wird.** Wenn der Nutzer 40-mal "OK" druecken muss,
  klickt er blind, und die Abnahme ist Theater.
- **Der Guard im Fehlerfall durchlaesst.** Siehe `policy-engine`-Vorfall: ein
  unbekanntes Level gab einmal alle Provider frei. Jede neue Entscheidung hier faellt
  im Zweifel zu *strenger*.

---

## 4. Constraints

**Aus der bestehenden Architektur:**

- `file-access-types.ts` kennt `read | create | read-create`, **kein `write`**.
  Ueberschreiben ist heute nicht modellierbar. Das Berechtigungsmodell muss erweitert
  werden — und das ist der sicherheitskritischste Teil der Arbeit.
- Verzeichnis-Grants kommen aus dem OS-Picker; der Renderer darf sich keinen Pfad
  selbst gewaehren. `isPersistedGrantTrusted()` faellt bei fehlendem Bestaetigungs-
  marker **geschlossen**. Jede neue Gewaehrung folgt diesem Muster.
- `ALLOWED_READ_EXTENSIONS` / `ALLOWED_CREATE_EXTENSIONS` sind Allowlists. Ein
  Projektverzeichnis enthaelt mehr Dateitypen als diese Listen kennen.
- `preflightGuard` behandelt `requiresConsent` als **fail-closed**, weil es dort
  keinen Zustimmungs-Kanal gibt. Im Agent-Loop wuerde das bedeuten: eine Datei mit PII
  bricht den Run ab. Das braucht eine Loesung (siehe 6.2).
- Agentic Mode haengt an `requireFeature('agentic_mode')` (Pro+). Der Coding-Modus
  erbt das.
- Der Renderer darf nicht in den Modulgraph des Main-Prozesses greifen —
  `tests/unit/renderer-process-boundary.test.ts` haelt die Grenze. Neue gemeinsame
  Typen gehoeren nach `src/shared/`.

**Aus den Projektregeln:**

- Kein Push auf main; Feature-Branch, PR.
- Typecheck ist **zwei** `tsc`-Laeufe (`tsc --noEmit && tsc -p tsconfig.main.json`).
- Testing-Pflicht vor Abschluss. Kein Bugfix ohne Regressionstest, der vorher rot war.
- Serverstandort Europa; Residency-Policy ist bereits in `policy-engine.ts` kodiert.

---

## 5. Approaches — betrachtet und entschieden

| | Inhalt | Fuer A | Fuer B | Aufwand |
|---|---|---|---|---|
| **1** | Guard-Verlegung + vier Coding-Tools + Diff-Abnahme + Modi + Audit. UI: Modus-Schalter, Diff-Dialog. | voll | Grundbedarf | mittel |
| **2** | 1 plus Coding-Workspace (Dateibaum, Editor, Diff-Pane, Befehls-Ausgabe) als ViewMode | Beiwerk | voll | 1 plus ein Vielfaches an UI |
| **3** | 2 plus Sandbox und Live-Preview | irrelevant (er will sein echtes Repo) | voll | gross, neue Infrastruktur, Docker |

**Verworfen: 3.** Anderes Produkt mit anderer Betriebsoekonomie, tritt gegen Lovable,
Replit und v0 an — mit einer Laufzeitumgebung, die Mingly erst bauen muesste. Fuer A,
die tragende Zielgruppe, liefert es nichts.

**Entschieden (Holger, 2026-11-18): Ziel ist 2, Weg ist erst 1, dann 2.**

Begruendung: 1 ist nicht die Vorstufe von 2, sondern dessen Substanz — 2 ist
Oberflaeche auf genau denselben Tools und demselben Guard. 1 allein ist bereits ein
auslieferbares Produkt fuer A und ein benutzbares fuer B. Wird 2 zuerst gebaut,
entsteht eine Attrappe: eine IDE-Oberflaeche ueber einem Agenten, der nicht sicher
schreiben kann.

**Phase 1 ist erst abgeschlossen, wenn das Exit-Kriterium in Abschnitt 8 erfuellt
ist. Phase 2 beginnt danach, nicht parallel.**

### Schritt 0 — vor Phase 1, eigener PR

Aus Entscheid 3: `isCloudProvider` wird von der hartcodierten Drei-Namen-Liste auf die
Residenz aus der `provider-registry` umgestellt. **Das ist kein Teil des Coding-Features
und geht als eigener PR voran**, weil es das Verhalten bestehender Chat-Nutzer aendert
(wer heute ueber Infomaniak chattet, sieht danach Zustimmungs-Dialoge) und deshalb
einzeln beurteilt und einzeln zurueckgedreht werden koennen muss.

Ohne diesen Schritt traegt die Kernaussage des Coding-Features nicht: ein Run ueber
unseren eigenen Schweizer Anbieter wuerde Quelltext ohne jeden Zustimmungs-Dialog
verschicken.

---

## 6. Das entschiedene Design (Phase 1)

### 6.1 Guard-Verlegung — der Kern

`preflightGuard` bleibt wo es ist (Eingangspruefung des Auftrags). **Zusaetzlich**
laeuft vor **jedem** `sendMessageWithTools`-Aufruf in der Schleife eine Pruefung des
Inhalts, der seit dem letzten Call dazugekommen ist.

Entschieden:

- Geprueft wird **inkrementell** (nur die neuen Tool-Ergebnisse plus die
  Progress-Recitation), nicht der ganze `messages`-Stapel. Begruendung: der Stapel
  waechst quadratisch mit den Schritten, und bereits geprueften Inhalt erneut durch
  NER zu schicken kostet Zeit ohne Erkenntnisgewinn.
- **Ein Guard-Aufruf pro Tool-Ergebnis, nicht einer pro Schritt** (Praezisierung nach
  Builder-Check). `guardInput` sanitisiert nur `texts[texts.length - 1]`, scannt aber
  `texts.join()` auf Sensitivdaten. Bekaeme es die drei neuen Ergebnisse eines Schritts
  als ein Array, blieben zwei davon **ungeprueft auf Prompt-Injection** — und Injection
  in einer Datei, die der Agent selbst gelesen hat, ist die zentrale Coding-Bedrohung.
  Das ist **keine neue Guard-Logik**, sondern mehrfacher Aufruf der bestehenden; der
  Vorbehalt in diesem Abschnitt bleibt gewahrt. Nebeneffekt: so wird auch die
  Datei-Zuordnung in 6.2 ueberhaupt erst moeglich.
- **Der Guard laeuft VOR `compactToolResult`** (Praezisierung nach Builder-Check).
  Die Kompaktierung in `agent-executor.ts:268` ersetzt grosse Ergebnisse durch eine
  Referenz plus `result.content.substring(0, 200)` — **roh, ungefiltert**. Bei einer
  Datei mit `API_KEY=` in den ersten Zeilen steht der Schluessel genau in dieser
  Vorschau, und die Vorschau geht an den Provider. Nach der Kompaktierung zu pruefen
  hiesse, den einen Teil zu pruefen, der nicht mehr da ist, und den einen durchzulassen,
  der bleibt.
- Verwendet wird die **bestehende Zerlegung**: `guardInput` fuer Injection und
  Sensitivdaten, `guardDispatch` fuer Budget und Routing. Keine neue Guard-Logik.
- **Kein Provider-Wechsel mitten im Run** (Korrektur nach Builder-Check). `guardDispatch`
  darf auf einen anderen Provider umleiten; im Coding-Modus ist das abgeschaltet und der
  Run endet stattdessen mit Grund. Begruendung: `guardInput` entscheidet anhand des
  **Eingangs**-Providers, ob ueberhaupt sensitiv geprueft wird. Inhalt, der unter einem
  lokalen Provider in `messages` kam, wurde nie geprueft — bleibt aber im Stapel und ginge
  nach einem Wechsel an die Cloud. Die Alternative waere, bei jedem Wechsel den ganzen
  angesammelten Stapel neu zu pruefen; das widerspricht dem inkrementellen Ansatz und
  kostet genau dort am meisten, wo der Run schon lang ist. Ein beendeter Run ist der
  ehrlichere Ausgang.
- Blockiert der Guard und es gibt keinen Ausweichprovider, **endet der Run**
  (fail-closed, wie heute), mit dem Grund im `run.error`.
- `postflightGuard` wird auf die LLM-Ausgabe jedes Schritts angewandt — die Funktion
  existiert und ist ungenutzt.

### 6.2 Zustimmung im Loop

Heute ist `requiresConsent` im Agent-Pfad fail-closed, weil kein Kanal existiert. Der
Agent-Handler sendet bereits Schritt-Ereignisse an den Renderer
(`IPC_CHANNELS.AGENT_STEP`), also ist der Rueckkanal baubar.

Entschieden: **Ein Zustimmungs-Dialog mitten im Run**, analog zu
`SensitiveDataConsentDialog`. Der Run pausiert, der Nutzer sieht *welche* Datei
*welche* Art von Fund enthaelt (Typ und Risikostufe, Wert redigiert), und entscheidet:
weitergeben, anonymisiert weitergeben, oder diese Datei aus dem Kontext werfen und
weiterlaufen.

Die dritte Option ist wichtig und neu: heute kann ein Run nur sterben oder alles
schicken. Fuer Coding ist "diese eine Datei nicht, der Rest schon" der haeufigste
sinnvolle Fall.

**Datei-Zuordnung:** `request-guard-deps.ts` setzt heute `filePath: '<message-content>'`
fest, weil es im Chat keine Datei gibt. Damit der Dialog sagen kann, **welche** Datei
den Fund enthaelt, muss der Coding-Pfad eine Herkunft mitgeben. Das folgt aus dem
Pro-Ergebnis-Aufruf in 6.1 und ist ohne ihn nicht machbar.

**Zeitlimit:** Der Run-Timeout laeuft waehrend der Pause weiter. Offen gelassen, ob er
angehalten werden soll — siehe Abschnitt 7.

### 6.3 Coding-Modi — abgestuft, nicht an/aus

Nach dem Muster der Privacy-Modi. Die Stufen sind geordnet; die Vergleichsfunktion
`atLeast()` aus `policy-types.ts` wird wiederverwendet statt eine zweite Ordnung
einzufuehren. Sie ist heute auf `PIISensitivity` typisiert und wird dafuer **generisch
ueber eine Ordnungstabelle** gemacht — die Funktion bleibt eine, die Skalen bleiben
getrennt.

| Stufe | Lesen | Schreiben | Befehle | Gedacht fuer |
|---|---|---|---|---|
| `off` | — | — | — | Standard. Mingly ist, was es heute ist. |
| `read-only` | ja, gefiltert | — | — | "Erklaer mir diese Codebase", ohne dass Mingly selbst schreibt |
| `propose` | ja | nur als Diff zur Abnahme | — | Der Normalfall fuer B |
| `propose-run` | ja | nur als Diff zur Abnahme | Allowlist, Ausgabe gefiltert | Tests laufen lassen, Build pruefen |

**Worueber diese Tabelle eine Aussage macht — und worueber nicht.** Die Spalten
beschreiben **Minglys eigene** Coding-Werkzeuge. Sie sind keine Aussage ueber die
MCP-Server, die der Nutzer eingerichtet hat: die bleiben in **jedem** Modus verfuegbar,
auch in `read-only`.

Das ist ein Entscheid, nicht ein Versehen (Holger, 2026-11-19): eigene MCP-Server sind
eine bewusst eingerichtete Faehigkeit, und sie im Coding-Modus abzuschalten wuerde genau
dort stoeren, wo man sie am haeufigsten braucht.

Was dadurch **nicht** faellt: jedes MCP-Werkzeug-Ergebnis laeuft durch denselben
Loop-Guard wie jedes andere selbst eingesammelte Ergebnis — Klassifikation,
Residenz-Politik, PII-Erkennung, Zustimmung. Der Inhaltsabfluss ist also geregelt.
Was **offen** bleibt, ist die **Faehigkeit**: ein MCP-Server mit Schreibzugriff kann
schreiben, auch in `read-only`, und ohne den Vorschlag-und-Abnahme-Weg. Das laesst sich
nicht sinnvoll abstufen, weil MCP-Server beliebige externe Prozesse mit opaker Semantik
sind — ein Werkzeug namens `search` kann schreiben, eine Einteilung in «lesend» und
«schreibend» haette keine belastbare Grundlage.

**Diese Grenze gehoert in das README und in die Modus-Beschriftung der Oberflaeche**, nicht
nur in dieses Dokument. Ein unausgesprochener Spalt in einem Modus, der `read-only`
heisst, ist ein falsches Versprechen. **Phase 2:** Vertrauensstufe oder Freigabe **pro
MCP-Server**, damit die Abstufung eine Grundlage bekommt.

Entschieden:

- **Kein `auto`-Modus in Phase 1.** Ein Modus, der ohne Abnahme schreibt, ist die
  Stufe, bei der ein Fehler teuer wird. Er kommt frueheste nach Phase 2 und dann mit
  Snapshot-Zwang.
- Der Modus gilt **pro Projekt-Grant**, nicht global. Ein Grant fuer ein Spielprojekt
  und einer fuer das Arbeitsrepo duerfen verschiedene Stufen haben.
- Unbekannter Wert → `off`. Fail-closed, explizit geprueft, mit Test. (Das ist die
  Lehre aus dem `policy-engine`-Fail-open.)

### 6.4 Die vier Werkzeuge

Registriert in der bestehenden `ToolRegistry`, aber **nur wenn der Coding-Modus es
hergibt** — ein Werkzeug, das die Stufe nicht erlaubt, wird gar nicht erst in
`getAvailableTools()` angeboten. Begruendung: ein Werkzeug anzubieten und dann zu
verweigern lehrt das Modell, es trotzdem zu versuchen, und fuellt den Kontext mit
Fehlern.

Aus derselben Regel folgt: ist das Gate eines Built-ins geschlossen, wird auch ein
**gleichnamiges** MCP-Werkzeug nicht angeboten. Sonst waere der Name doch im Angebot und
die Ausfuehrung muesste ihn verweigern — und ein MCP-Werkzeug koennte ein gegatetes
Built-in beschatten.

- `list_files(pattern?)` — Dateibaum des Projekts. Respektiert `.gitignore`.
- `read_file(path, offset?, limit?)` — liest **nur** innerhalb des Projekt-Grants,
  geprueft mit `isPathSafe` **nach** `realpath` (Symlink-Ausbruch, vgl. `real-path-guard.ts`).
- `edit_file(path, old, new)` — exakte Ersetzung, erzeugt einen Diff, schreibt
  **nicht** selbst. Die Schreibung erfolgt erst nach Abnahme.
- `run_command(cmd)` — nur in `propose-run`, nur aus der Allowlist, cwd ist das
  Projekt, Ausgabe laeuft durch den Guard wie ein Tool-Ergebnis.

**Allowlist fuer Befehle:** Entschieden als **Praefix-Liste mit Argumentpruefung**,
nicht als Regex auf der ganzen Zeile. Start: `npm test`, `npm run <script aus
package.json>`, `npx tsc --noEmit`, `pytest`, `git status`, `git diff`.
Keine Shell-Interpretation — kein `&&`, kein `|`, kein `;`, keine Substitution. Wer
eine Pipeline braucht, legt ein npm-Script an.

**Woher die Binaerdatei kommt** (Entscheid nach Builder-Check): aus
`<projekt>/node_modules/.bin` und sonst nichts. **Kein** Erben von `process.env.PATH`,
**kein** Sourcen der Login-Shell. Eine gepackte Electron-App auf macOS erbt den PATH der
Login-Shell ohnehin nicht, also wuerde ein PATH-basierter Aufruf in der Entwicklung
funktionieren und im ausgelieferten Build still ins Leere laufen. Wichtiger noch: unter
dem Argumentvektor-Prinzip dieses Abschnitts ist "welche Binaerdatei laeuft" selbst eine
Sicherheitsfrage, und ein geerbter PATH beantwortet sie mit "was immer der Nutzer
installiert hat". Interpreter ausserhalb von `node_modules/.bin` (z.B. `pytest`) brauchen
einen in den Einstellungen **explizit gesetzten** Pfad; ohne ihn ist der Befehl nicht
verfuegbar statt stillschweigend ein anderer.

> Der Guard haengt hier bewusst **nicht an der Schreibweise des Befehls**, sondern am
> ausgefuehrten Argumentvektor. Ein Guard, der an einer Formulierung haengt, ist
> vertagt, nicht repariert.

### 6.5 Diff-Abnahme und Rueckgaengig

- Gesammelt wird **pro Schritt**, nicht pro Datei: der Agent aendert oft drei Dateien
  fuer eine Sache. Der Nutzer nimmt das Paket ab. (Das adressiert das Anti-Ziel
  "Klickstrecke".)
- Abgelehnte Diffs gehen als Tool-Ergebnis mit Begruendung zurueck an den Agenten —
  er soll daraus lernen, nicht blind nochmal dasselbe vorschlagen.
- **Snapshot vor der ersten Schreibung eines Runs**: die betroffenen Dateien werden
  kopiert, bevor etwas ueberschrieben wird. "Run rueckgaengig" stellt sie wieder her.
  Kein Git noetig, funktioniert auch in Verzeichnissen ohne Repo.
- Snapshots liegen **im Projekt** unter `.mingly/`, nicht in `/tmp`. Begruendung: fuer A
  darf Projekt-Quelltext die Projektgrenze nicht verlassen — das gilt auch fuer
  Sicherungskopien. **Derselbe Grund gilt fuer die Temp-Dateien von `compactToolResult`:
  deren Ziel wird fuer Coding-Runs nach `.mingly/context/` umgelenkt.**
- Das loest zugleich einen Widerspruch, den der Builder-Check gefunden hat: die
  Kompaktierung weist das Modell an, die ausgelagerte Datei mit `read_file` zu lesen,
  waehrend `read_file` auf den Projekt-Grant beschraenkt ist. Liegt die Datei **in**
  `.mingly/context/`, ist sie innerhalb des Grants und die Anweisung bleibt gueltig.
  `.mingly/` wird von `list_files` ausgeblendet, ist aber fuer `read_file` erreichbar.
- `.mingly/` wird **nicht** ueber `.gitignore` ausgeblendet — das Verzeichnis soll auch
  dort funktionieren, wo kein Repo liegt. Mingly traegt den Eintrag ein, wenn eine
  `.gitignore` existiert, und verlaesst sich nicht darauf.

### 6.6 Audit

Pro abgenommener Aenderung ein Eintrag ueber den bestehenden `activity-logger`:
Zeitpunkt, Projekt, Datei, Anzahl geaenderter Zeilen, Provider und Modell, die
Policy-Version aus `PolicyDecision.policyVersion`, und ob der Guard unterwegs
umgeleitet oder blockiert hat.

Das ist der Teil, den A seinem Compliance-Verantwortlichen zeigt. Er wird deshalb
**exportierbar** gebaut, nicht nur anzeigbar.

### 6.7 Projekt-Grant

Wiederverwendung von `FileAccessManager.requestDirectoryAccess` (OS-Picker, setzt
`confirmedAt`). Neu ist die Berechtigung `edit`, die zu `read | create` dazukommt.

**Entschieden (Entscheid 2):** `isPersistedGrantTrusted` wird von einer Ja/Nein-Antwort
auf **"welche Berechtigungen ueberleben das Laden"** umgestellt. `read` und `create`
verhalten sich unveraendert — auch fuer lokale Grants, die heute ueber
`if (dir.location === 'local') return true` an der `confirmedAt`-Pruefung vorbeilaufen.
**`edit` verlangt den Marker, ausnahmslos, auch lokal.**

Ein bestehender Grant ohne Marker verliert also nur `edit`, das er bisher ohnehin nicht
hatte. Kein bestehender Nutzer muss etwas neu gewaehren, bis er Coding einschaltet; dann
waehlt er das Projekt einmal im OS-Dialog, und der Marker entsteht dort, wo er entstehen
soll — an einer Handlung des Nutzers.

Der Signaturwechsel beruehrt alle heutigen Aufrufer. Das ist mehr Arbeit als eine
Erweiterung der bestehenden Pruefung, aber die Alternative waere, die gefaehrlichste
neue Berechtigung ausgerechnet auf dem einen Pfad auszuliefern, den das
Berechtigungsmodell nicht prueft.

### 6.8 Erweiterungs-Allowlist

Ein Projektverzeichnis enthaelt mehr als `ALLOWED_READ_EXTENSIONS` kennt. Entschieden:
fuer Coding-Grants gilt eine **eigene, groessere Leseliste** plus eine **Blockliste**
fuer Dinge, die ein Agent nie brauchen sollte (`.env*`, `*.pem`, `*.key`, `*.p12`,
`id_rsa*`, `.git/config`, `*.sqlite`). Die Blockliste gewinnt immer.

Das ersetzt den Guard **nicht** — es ist eine zweite, billige Schicht davor.

**Die Blockliste ist in Phase 1 absolut** (Aufloesung eines Widerspruchs im eigenen
Entwurf, gefunden im Builder-Check: der Satz "gewinnt immer" stand vier Zeilen ueber
einer Ausnahme, die ihn aufhob). Kein Zustimmungs-Dialog hebt sie auf, kein Modus
schaltet sie frei. Wer dem Agenten wirklich den Inhalt einer `.env` geben will, kopiert
ihn selbst in den Chat — dort greift der normale Chat-Guard samt Zustimmung, und die
Entscheidung ist eine bewusste Handlung des Nutzers statt ein Klick in einem Dialog, den
der Agent ausgeloest hat. Eine ueberschreibbare Blockliste waere ausserdem genau die
Klickstrecke, die unter Anti-Ziele steht.

**Ein Korrelationsschluessel fuer eine sicherheitsrelevante Anzeige wird LOKAL
erzeugt.** Der Zustimmungs-Dialog nennt die Datei, ueber die ein Mensch entscheidet, und
dieser Pfad muss dem Ergebnis zugeordnet werden, zu dem er gehoert. Der Schluessel dafuer
darf nicht von aussen kommen.

Diese Regel steht hier, weil derselbe Mechanismus sie dreimal gebrochen hat: zuerst war
der Schluessel die vom Modell geschriebene **Pfad-Schreibweise**, dann wurde der Eintrag
**beim ersten Nachschlagen geloescht** (womit jedes Paging seinen Pfad verlor), dann war
der Schluessel die **Aufruf-Id des Providers** — die bei Anthropic direkt aus der Antwort
stammt und bei einem OpenAI-kompatiblen oder lokalen Anbieter auch **leer** sein kann,
womit alle Aufrufe eines Schritts auf einen Schluessel kollidieren. Jedes Mal kam der
Schluessel von aussen, und jedes Mal sah der naechste Schluessel wie die Loesung aus.

Also: der Executor vergibt je Aufruf eine eigene, lokal erzeugte Kennung und verwendet
sie fuer beide Seiten der Zuordnung. Eine Provider-Id darf mitlaufen, zum Protokollieren,
aber nichts Sicherheitsrelevantes haengt an ihr. Spaete Schreibzugriffe aus einem
abgeschlossenen Schritt werden verworfen.

**Was nur vom Modelltext abhaengt, darf unterschiedlich antworten; was vom Dateisystem
abhaengt, muss identisch antworten.** Die feste Pruefreihenfolge dient dem Satz, dass
eine Ablehnung nichts ueber das Dateisystem verraet — nicht der Reihenfolge an sich. Eine
Pruefung, die allein auf der Zeichenkette des Modells arbeitet (etwa die Endung des
**angefragten** Namens), darf deshalb frueher laufen und darf eine eigene Begruendung
nennen. Alles, was einen Zustand auf der Platte beruehrt — existiert der Pfad, zeigt der
Link nach draussen, ist die Datei lesbar —, muss **dieselbe** Antwort geben, sonst wird
die Ablehnung zum Orakel. Gefunden, weil ein toter Link und ein Link auf eine existierende
Datei ausserhalb des Grants unterschiedlich antworteten: ein Bit pro Host-Pfad, erfragbar
mit gepflanzten Links.

**Welche Endungen lesbar sind — ein Entscheid, nicht ein Nebeneffekt (2026-11-19).** Die
Leseliste enthaelt auch `conf`, `cfg`, `ini` und `properties`. Solche Dateien enthalten
gelegentlich ein Passwort, und sie sind trotzdem lesbar. Der Unterschied zur `.env` ist
der **Zweck**: eine `.env` existiert, um Geheimnisse zu halten — sie wird deshalb nie
gelesen, ohne Dialog und ohne Ausnahme. Eine Konfigurationsdatei existiert, um zu
konfigurieren, und enthaelt manchmal ein Geheimnis — sie wird gelesen, und findet der
Inhalts-Guard darin eine Zugangsdaten-Fundstelle, fragt er nach Zustimmung. Die
Blockliste ist die Schicht fuer «nie», der Guard die Schicht fuer «kommt darauf an».

Dateien **ohne** Endung (`Dockerfile`, `Makefile`, `.gitignore` und aehnliche) stehen auf
einer eigenen Namensliste, weil eine reine Endungsliste sie alle ablehnen wuerde — und
das sind genau die Dateien, die jemand braucht, der eine Codebase erklaert bekommen
will.

---

## 7. Was dem Builder ueberlassen bleibt

- Dateiformat und Ablage von Snapshots und Modus-Konfiguration (es gibt bereits
  `file-access.json` als Vorbild).
- Ob die inkrementelle Guard-Pruefung ein eigenes Modul bekommt oder eine Methode am
  `AgentExecutor` wird.
- Genaue Form der Diff-Darstellung im Chat (unified vs. kompakt) — solange erkennbar
  ist, welche Datei und wie viele Zeilen.
- Benennung der IPC-Kanaele, dem Muster `coding:<verb>` folgend.
- Ob der Run-Timeout waehrend des Zustimmungs-Dialogs angehalten wird. Empfehlung:
  ja, sonst sterben Runs an der Bedenkzeit des Nutzers. Als Builder-Entscheid
  markiert, weil es eine reine Implementierungsfrage ist.
- Reihenfolge innerhalb Phase 1, solange der Guard **vor** den schreibenden
  Werkzeugen fertig ist.

---

## 8. Exit-Kriterium fuer Phase 1

Phase 1 ist fertig, wenn **alle** folgenden Punkte gemessen vorliegen:

1. `npm run typecheck` gruen — **beide** Laeufe (`tsc --noEmit` und
   `tsc -p tsconfig.main.json --noEmit`), nachgewiesen einzeln.
2. `npm test` gruen, ohne ausgelassene oder gelockerte Tests.
3. **Ein Test, der vor der Guard-Verlegung rot war**, ist gruen: ein Agent-Run, dessen
   Tool-Ergebnis ein Credential-Muster enthaelt, erreicht den Cloud-Provider nicht.
   Das ist der Regressionstest fuer den Befund aus Abschnitt 2 und der eigentliche
   Nachweis des Features.
4. **Positivkontrolle im selben Lauf**: derselbe Aufbau mit harmlosem Tool-Ergebnis
   laeuft durch. Ohne sie belegt Punkt 3 nur, dass irgendetwas blockiert.
5. Ein Test, dass ein unbekannter Modus-Wert auf `off` faellt.
6. Ein Test, dass `edit_file` ausserhalb des Grants scheitert — auch ueber einen
   Symlink, der nach draussen zeigt.
7. Ein Test, dass ein Tool-Ergebnis oberhalb der Kompaktierungsschwelle **vor** der
   Kompaktierung geprueft wird: eine grosse Datei mit `API_KEY=` in den ersten 200
   Zeichen darf ihre Vorschau nicht an den Provider geben.
8. Ein Test, dass jedes Tool-Ergebnis eines Schritts einzeln auf Injection geprueft
   wird — nicht nur das letzte. Aufbau: zwei Ergebnisse, Injection im ersten.
9. Manuell **in der gepackten App** (`npm run pack`), nicht nur in der Entwicklung:
   Projekt gewaehren, Modus `propose`, eine Aenderung vorschlagen lassen, ablehnen,
   erneut vorschlagen lassen, annehmen, rueckgaengig machen. Datei ist wieder im
   Ausgangszustand. Der gepackte Lauf ist Pflicht, weil PATH und Arbeitsverzeichnis
   sich dort anders verhalten als unter `npm run dev` — ein gruener Entwicklungslauf
   belegt fuer `propose-run` nichts.
10. Das README sagt die Wahrheit ueber die eingebauten Werkzeuge.
11. Ein Test, dass `edit` an einem Grant ohne `confirmedAt` scheitert, waehrend `read`
    und `create` am selben Grant weiter funktionieren (Entscheid 2 — die Pruefung muss
    differenzieren, nicht pauschal sperren).

**Schritt 0 hat ein eigenes Exit-Kriterium**, unabhaengig von Phase 1: ein Test, dass ein
Anbieter mit `residency: 'CH'` (Infomaniak) als Cloud gilt und den Sensitivdaten-Pfad
samt Zustimmung durchlaeuft — plus eine Positivkontrolle, dass `on-device` es weiterhin
**nicht** tut. Ohne die zweite belegt die erste nur, dass jetzt alles als Cloud gilt.

---

## 9. Entscheide zu den offenen Fragen

Aus dem Builder-Check (2026-11-18), nachgeprueft am Code, **alle drei von Holger am
2026-11-18 entschieden — jeweils der empfohlenen Variante folgend**. Die Begruendungen
bleiben stehen, damit spaeter nachvollziehbar ist, wogegen entschieden wurde.

### Entscheid 1 — Woran haengt der Coding-Modus?

**ENTSCHIEDEN:** Ein einzelner Coding-Run wird gebaut; der Coding-Modus ist in
Agent-Vergleich und Subagent-Ansicht gesperrt. Phase 1 traegt damit ein Stueck
Oberflaeche, das urspruenglich Phase 2 zugeschrieben war — minimal gehalten, und in
Phase 2 steht es dann schon.

**Befund:** `executeAgent` in `src/renderer/stores/agent-store.ts:102` hat **keinen
Aufrufer** in `src/` oder `tests/` (nachgeprueft mit Positivkontrolle im selben Lauf).
`ViewMode` kennt `chat | comparison | agent_comparison | subagent` — **einen einzelnen
Agent-Run kann ein Nutzer heute gar nicht starten**. Die zwei lebenden Pfade sind
Agent-Vergleich und Subagents, und beide starten **N Executors parallel**, die alle auf
dieselbe Singleton-`ToolRegistry` greifen.

**Warum es den Plan aendert:** Entweder baut Phase 1 zusaetzlich einen einzelnen
Coding-Run in der Chat-Oberflaeche — Oberflaechenarbeit, die dieses Dokument Phase 2
zugeschrieben hat und nicht budgetiert. Oder der Coding-Modus haengt sich an
Vergleich/Subagents, und dann schlagen zwei bis drei Executors gleichzeitig Aenderungen
an denselben Dateien vor: "Snapshot vor der ersten Schreibung eines Runs" ueberschreibt
sich gegenseitig, und "Diff-Abnahme pro Schritt" hat ueber nebenlaeufige Runs keine
definierte Bedeutung. Dazu kommt, dass 6.4 die Werkzeuge ueber den **globalen**
Registry-Zustand freischaltet, waehrend 6.3 den Modus **pro Projekt** festlegt. Beides
zugleich geht nicht.

**Empfehlung:** einen einzelnen Coding-Run bauen und den Coding-Modus in
Vergleich/Subagent-Ansichten **sperren**. Mehrere Agenten, die gleichzeitig dieselbe
Datei schreiben, sind kein Feature, das wir hier wollen. Kostet Phase 1 ein Stueck
Oberflaeche, das dann in Phase 2 schon steht.

### Entscheid 2 — Darf `edit` auf dem heute offenen Grant-Loch fahren?

**ENTSCHIEDEN:** Nein. Der Marker wird fuer `edit` verlangt, auch bei lokalen Grants;
`read` und `create` bleiben unveraendert. Ausgefuehrt in 6.7.

**Befund:** `isPersistedGrantTrusted()` gibt fuer `location === 'local'` immer `true`
zurueck, bevor `confirmedAt` ueberhaupt geprueft wird, und `loadAllowedDirectories`
uebernimmt das `location`-Feld so, wie es im Speicher steht. Heute kostet das wenig:
die Berechtigung reicht fuer Lesen und nicht-ueberschreibendes Anlegen unter
Erweiterungs-Allowlists. **Mit `edit` wird daraus das Ueberschreiben beliebiger
bestehender Dateien.**

**Warum es den Plan aendert:** Entweder verlangt Phase 1 `confirmedAt` auch fuer lokale
Grants — dann muss **jeder bestehende Nutzer jedes Verzeichnis neu gewaehren**, auch
die, die mit Coding nichts zu tun haben. Oder `edit` faehrt auf dem Kurzschluss mit, und
wir liefern die gefaehrlichste neue Berechtigung auf der einzigen Stelle aus, die das
Berechtigungsmodell nicht prueft.

**Empfehlung:** `confirmedAt` verlangen, aber **nur fuer `edit`**: ein Grant ohne Marker
behaelt `read` und `create` und verliert `edit`. Bestehende Nutzer merken nichts, bis
sie Coding einschalten; dann waehlen sie das Projekt einmal im Dialog. Das verlangt,
`isPersistedGrantTrusted` von einer Ja/Nein-Antwort auf "welche Berechtigungen
ueberleben das Laden" umzustellen — mehr Arbeit als geplant, aber ohne Bruch fuer
bestehende Nutzer.

### Entscheid 3 — Welche Anbieter gelten als "Cloud"?

**ENTSCHIEDEN:** Umstellung auf Registry-Residenz, fuer alle Pfade, in einem eigenen
PR **vor** dem Coding-Feature. Als Schritt 0 in Abschnitt 5 aufgenommen.

**Befund:** `request-guard-deps.ts:18` hat
`const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'google'])`, und `guardInput`
ueberspringt bei `isCloudProvider === false` den Sensitivdaten-Scan **und den gesamten
Zustimmungs-Zweig**. Gleichzeitig fuehrt `provider-registry.ts` ein echtes
Residenz-Modell, in dem **Infomaniak mit `residency: 'CH'`** steht. Infomaniak ist
nicht im Set. Ein Coding-Run ueber Infomaniak oder einen generischen
OpenAI-kompatiblen Endpunkt schickt also Quelltext vom Rechner, ohne dass der
Zustimmungs-Dialog je auftaucht.

**Warum es den Plan aendert:** "Der Agent schickt nichts Sensitives weg, ohne zu fragen"
ist die Kernaussage des Produkts. Bleibt das Set hartcodiert, gilt sie ausgerechnet bei
unserem eigenen Schweizer Anbieter nicht. Stellen wir auf Registry-Residenz um, ist das
neue Guard-Logik und **aendert auch das Chat-Verhalten** bestehender Nutzer: wer heute
ueber Infomaniak chattet, bekommt danach Zustimmungs-Dialoge, die er vorher nie sah.

**Empfehlung:** umstellen — aber die Frage ist, ob fuer alles oder nur fuer den
Coding-Pfad. Technisch sauber ist "fuer alles": zwei Begriffe von "Cloud" im selben
Programm driften auseinander. Produktseitig ist "fuer alles" eine spuerbare
Verhaltensaenderung in einem Teil, den niemand angefasst hat. Mein Vorschlag: fuer
alles, in einem eigenen PR **vor** dem Coding-Feature, damit die Aenderung fuer sich
steht und einzeln zurueckgedreht werden kann.

---

## 10. Entscheide aus dem Builder-Check (ohne Rueckfrage getroffen)

Oben eingearbeitet, hier zum Nachlesen:

- **Guard-Aufruf pro Tool-Ergebnis** statt pro Schritt (6.1) — sonst bleiben alle ausser
  dem letzten Ergebnis ungeprueft auf Injection.
- **Guard vor der Kompaktierung** (6.1) — die 200-Zeichen-Vorschau geht roh an den
  Provider.
- **Kein Provider-Wechsel im Coding-Modus** (6.1) — sonst wandert ungeprueft
  angesammelter Inhalt nach einem Wechsel in die Cloud.
- **Blockliste ist absolut**, kein Dialog hebt sie auf (6.8) — loest einen Widerspruch
  im eigenen Entwurf.
- **Binaerdateien nur aus `node_modules/.bin`** plus explizit gesetzte Interpreter (6.4)
  — kein PATH-Erben, weil das in der gepackten App anders ausgeht als in der Entwicklung.
- **`.mingly/` im Projekt** fuer Snapshots und ausgelagerte Tool-Ergebnisse (6.5) — haelt
  Quelltext in der Projektgrenze und macht die `read_file`-Anweisung der Kompaktierung
  wieder gueltig.
- **`atLeast()` generisch** ueber eine Ordnungstabelle (6.3).
- **Exit-Kriterien 7, 8 und 9 ergaenzt** — inklusive Pflichtlauf in der gepackten App.
