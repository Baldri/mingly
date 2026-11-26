# Design: Einstellungsoberfläche für die Interpreter-Freigaben

- **Datum:** 2026-11-24
- **Status:** Entwurf, wartet auf Genehmigung durch Holger
- **Firma:** digital opua GmbH
- **Grundlage:** Session-Gespräch 2026-11-24. Variante A gewählt, Variante B ausdrücklich vertagt.
- **Revision:** nach Builder-Check korrigiert (siehe letzter Abschnitt)

## Absicht und Warum

`mingly_run_command` ist auf einer frisch installierten Mingly-Instanz funktionslos.
Programme werden nie aus dem `PATH` aufgelöst, sondern ausschliesslich aus
`<projekt>/node_modules/.bin/<name>` oder aus einem absoluten Pfad, den der Nutzer in
`coding-interpreters.json` (Schlüssel `paths`) im Benutzerdatenverzeichnis hinterlegt hat
(`src/main/coding/run-command.ts:110-128`). Diese Datei lässt sich heute nur von Hand
anlegen; `README.md:104` benennt das ausdrücklich als fehlend, inklusive des fehlenden
Vorschlags durch Mingly.

Die Folge ist nicht ein kosmetischer Mangel, sondern dass die gesamte Safe-Vibe-Coding-Arbeit
aus #39 bis #43 für jeden unerreichbar ist, der keinen Texteditor auf das
Benutzerdatenverzeichnis richtet. Der Doc-Kommentar der Lesefunktion sagt bereits
"The interpreters the user confirmed in the settings" — die Oberfläche war von Anfang an
mitgedacht und ist nie gebaut worden.

**Zielgruppe jetzt:** Holger auf seiner eigenen Maschine. Er weiss, wo seine Programme liegen.
**Zielgruppe später:** ausgelieferte Nutzer, die das nicht wissen. Das ist Variante B und
nicht Teil dieser Arbeit.

## Ziele

1. `npm`, `git` und `pytest` lassen sich in der Oberfläche hinterlegen und wieder entfernen.
2. Der Renderer nennt zu keinem Zeitpunkt einen Pfad.
3. Validierung greift beim **Schreiben** und beim **Laden**.
4. Ein Eintrag ohne Bestätigungsmerkmal wird nicht benutzt, bleibt aber in der Datei stehen
   und wird in der Oberfläche als unbestätigt angezeigt. Der Nutzer verliert seinen Pfad nicht.
5. Die Refusal-Nachricht an das Modell bleibt Zeichen für Zeichen unverändert.

## Nicht-Ziele

- Keine Erkennung und kein Vorschlag von Kandidaten (Variante B).
- Kein neues Agent-Werkzeug, das den Konfigurationszustand lesen kann.
- Keine Änderung an `command-allowlist.ts` und keine Änderung der Auflösungsregel.
- Keine Atomarisierung von `SimpleStore` (siehe Beschränkung 3).
- Keine Internationalisierung über das bestehende Mass hinaus: `FileAccessTab` ist heute
  englisch beschriftet, der neue Block bleibt es auch.

## Anti-Ziele

Jedes Einzelne macht die Arbeit zum Misserfolg, auch wenn sie technisch funktioniert:

- Der Agent kann nach dem Feature unterscheiden, **warum** ein Befehl abgelehnt wurde.
- Der Renderer kann einen Pfad in die Konfiguration bringen, den kein OS-Dialog geliefert hat.
- Ein von Hand geschriebener Eintrag wird beim Start stillschweigend vertraut.
- Eine normale Installation (nvm, Homebrew, pyenv) wird abgelehnt, weil ihr Programm ein
  Symlink ist.
- `SettingsPage.tsx` wird mit gemischten Zeilenenden zurückgelassen.

## Beschränkungen aus dem Bestand (gemessen, nicht angenommen)

1. **`childEnv` weitet den `PATH` des Kindprozesses.** `run-command.ts:247-258` legt für
   jeden konfigurierten Interpreter mit absolutem Pfad dessen `path.dirname()` in den
   `PATH` des Kindes, zusätzlich zu `/usr/bin` und `/bin`. **Ein hinterlegter Pfad gibt
   damit das ganze Verzeichnis frei.** Darum prüft die Validierung nicht nur
   "ist ausführbar", sondern dass der **Basename zum Interpreter-Namen passt**. Sonst wird
   der Picker zur Verzeichnis-Freigabe durch die Hintertür.

2. **Der Symlink ist hier der Normalfall, nicht der Angriff.** Auf der Zielmaschine
   gemessen (2026-11-24):

   | Name | gewählter Pfad | `realpath` | Basename nach `realpath` |
   |---|---|---|---|
   | `npm` | `~/.nvm/versions/node/v24.13.1/bin/npm` | `.../lib/node_modules/npm/bin/npm-cli.js` | `npm-cli.js` |
   | `git` | `/opt/homebrew/bin/git` | `/opt/homebrew/Cellar/git/2.53.0/bin/git` | `git` |
   | `pytest` | `~/Library/Python/3.13/bin/pytest` | identisch (kein Symlink) | `pytest` |

   Daraus folgt zweierlei, und beides ist für die Korrektheit entscheidend:
   - Ein Basename-Vergleich **auf dem aufgelösten Pfad** würde `npm` auf dieser Maschine
     ablehnen. Der Vergleich läuft deshalb auf dem **gewählten** Pfad.
   - Gespeichert und an `childEnv` gegeben wird ebenfalls der **gewählte** Pfad. Würde der
     aufgelöste gespeichert, käme `.../lib/node_modules/npm/bin` in den `PATH` des Kindes —
     dort liegt kein `node`, npm wäre startunfähig.

   `realpath` behält hier also eine andere Rolle als bei File Access: nicht Abwehr eines
   Symlink-Ausbruchs, sondern nur Feststellung, **was** am Ende der Kette liegt (reguläre
   Datei, ausführbar) und Containment gegen `userData`.

3. **Das Bestätigungsmerkmal existiert schon.** `confirmedAt: number`, entschieden an einer
   einzigen Stelle und fail-closed: `hasConfirmationMarker` in
   `src/shared/file-access-types.ts:88` verlangt eine positive, endliche Zahl. Alles andere,
   `undefined` eingeschlossen, heisst "nicht bestätigt". Dieselbe Semantik wird
   wiederverwendet, keine zweite erfunden.

4. **`SimpleStore` ist ein Singleton pro Datei mit nicht-atomarem Schreiben.**
   `src/main/utils/simple-store.ts`: `create()` cacht pro Pfad, `set()` schreibt die ganze
   Datei mit `writeFileSync`, und `load()` setzt bei defektem JSON still auf `{}`. Das ist
   Vorbestand, den viele Stores teilen. Dieses Feature verschlechtert ihn nicht, und der
   Verlust ist hier wiederherstellbar (Pfad neu wählen), anders als bei Secrets. Darum als
   Nicht-Ziel geführt und **nicht** als `DEBT:` weggemarkt — ein `DEBT:` an einer
   Data-Loss-Stelle wäre nach CLAUDE.md ein Defekt, kein Debt.

5. **Zeilenenden.** `FileAccessTab.tsx` ist reines LF (268 Zeilen, 0 CRLF).
   `SettingsPage.tsx` hat 455 CRLF-Zeilen und **null** reine LF-Zeilen. Der Block gehört
   deshalb in `FileAccessTab.tsx`; `SettingsPage.tsx` wird nicht angefasst. Ein eigener Tab
   bräuchte dort drei Eingriffe (Import, `TABS`-Array, Render-Zweig) und damit das Risiko
   eines 455-Zeilen-Diffs aus drei geänderten Zeilen.

6. **Handler-Registrierung muss synchron bleiben.** U5 aus #45: ein `await import` liess vier
   `wrapHandler`-Registrierungen einen Microtask **nach** der Rückkehr des synchronen
   Aufrufers laufen. Der neue Code darf diese Form nicht wiederholen.

7. **Bestehendes IPC- und Dialog-Muster.**
   `window.electronAPI.fileAccess.requestDirectory(['read','create'])` nimmt **Rechte,
   keinen Pfad** (`src/preload/index.ts:172-184`), der Handler liegt in
   `src/main/ipc/infrastructure-handlers.ts:156`, die Kanäle in `src/shared/types.ts`.
   `FileAccessManager` ruft `dialog.showOpenDialog` **ohne Parent-Window**
   (`file-access-manager.ts:230`). Beides wird übernommen, nicht verbessert.

## Approaches

**A — Interpreter-Block im File-Access-Tab, Pfadwahl im Main-Prozess. Gewählt.**
Abschnitt in `FileAccessTab.tsx`, eine Zeile pro Name, Dateidialog über
`dialog.showOpenDialog` im Main. Validierung beim Schreiben und beim Laden,
Bestätigungsmerkmal. Keine Vorschläge.
*Trade-off:* löst Holgers Problem vollständig; für ausgelieferte Nutzer ist es der Boden,
nicht das Dach. Wer nicht weiss, wo sein `npm` liegt, kommt damit nicht weiter.
*Gewählt, weil* es genau der Teil von B ist, der bei der späteren Erweiterung **nicht** neu
geschrieben wird — Store, Validierung und Bestätigung tragen den Vorschlagsweg mit — und
weil die eine Sicherheitseigenschaft, die hier zählt, am Anfang billig und später teuer ist.

**B — A plus Erkennung und Vorschlag. Vertagt.**
Kandidaten können nur aus dem `PATH` oder bekannten Orten kommen. Die Kernregel des Modells
ist "Programme kommen nie aus dem `PATH`"; ein Vorschlag führt `PATH` als *Eingabe* wieder
ein, bestätigt durch den Nutzer, nie als Auflöser. Eigene Vertrauensentscheidung, etwa die
doppelte Arbeit, für eine Zielgruppe von einer Person überbaut.

**C — Vorlage anlegen und im Finder aufdecken. Verworfen.**
Ein Knopf schreibt eine Vorlage und zeigt sie im Finder. Stunden statt Tage, aber validiert
nichts, lässt `COMMAND_UNAVAILABLE` als einzige Rückmeldung und die ausgelieferte Fassung
würde zweimal gebaut. Es ist kein Einstellungsdialog, sondern ein Wegweiser zum Handbetrieb.

## Entwurf

### Datenmodell

`coding-interpreters.json` behält `paths` als `Record<string, string>`, damit die bestehende
Lesefunktion und von Hand geschriebene Dateien formkompatibel bleiben. Dazu **ein**
Geschwister-Schlüssel:

```json
{
  "paths":       { "npm": "/Users/x/.nvm/versions/node/v24.13.1/bin/npm" },
  "confirmedAt": { "npm": 1764000000000 }
}
```

`paths[name]` wird nur benutzt, wenn `confirmedAt[name]` das Merkmal trägt.

**Kein `unconfirmed`-Schlüssel, kein Parken.** Ein unbestätigter Eintrag bleibt einfach in
`paths` stehen und wird nicht honoriert; die Oberfläche leitet den Zustand "unbestätigt"
daraus ab (`paths[name]` vorhanden, Merkmal fehlt). Das spart einen ganzen Schreibpfad und
hält `readInterpreterPaths` frei von Nebenwirkungen — die Funktion läuft über
`defaultInterpreterPaths()` bei **jedem** Lauf, und ein Schreibzugriff in diesem Pfad wäre
sowohl teuer als auch eine Signaturänderung (`backing` hat heute nur `get`).
Das weicht bewusst von `FileAccessManager` ab, der parkt: dort muss eine Liste beim Start
mutiert werden, hier bleibt der Eintrag unberührt liegen.

### Main-Prozess: neues Modul `src/main/coding/interpreter-settings.ts`

- `listInterpreters(): InterpreterState[]` — für jeden Namen aus `INTERPRETER_NAMES`
  (`run-command.ts:87`: `['npm','git','pytest']`) ein Zustand
  `{ name, path: string | null, confirmed: boolean }`. `path` ist gesetzt, sobald ein
  Eintrag existiert; `confirmed` sagt, ob er honoriert wird.
- `chooseInterpreter(name)` — prüft `name` gegen `INTERPRETER_NAMES` und lehnt alles andere
  ab, öffnet `dialog.showOpenDialog({ properties: ['openFile'], defaultPath, title, message })`
  ohne Parent-Window (Beschränkung 7). `defaultPath` ist das Verzeichnis eines bereits
  hinterlegten Eintrags, sonst nicht gesetzt. Validiert das Ergebnis, schreibt `paths[name]`
  und `confirmedAt[name] = Date.now()`.
- `removeInterpreter(name)` — entfernt den Namen aus beiden Schlüsseln.
- `validateChosenFile(name, chosenPath)` — die Vertrauensgrenze. Alle Prüfungen müssen halten:
  1. `path.isAbsolute(chosenPath)`
  2. **Basename-Vergleich auf `chosenPath`** — exakt `name`, auf Windows zusätzlich
     `name.cmd` und `name.exe`. Grund: Beschränkungen 1 und 2.
  3. `fs.realpathSync(chosenPath)` gelingt — das Ziel existiert und die Kette ist auflösbar
  4. das aufgelöste Ziel ist eine **reguläre Datei** (nicht Verzeichnis, Socket, FIFO)
  5. das aufgelöste Ziel ist für den aktuellen Nutzer **ausführbar**
  6. **weder `chosenPath` noch das aufgelöste Ziel** liegen unter
     `fs.realpathSync(app.getPath('userData'))`. Beide Seiten werden aufgelöst, sonst geht
     der Vergleich auf macOS daneben, wo `userData` unter einem Symlink liegen kann.
     Grund: ein Renderer mit `create`-Grant könnte dort eine Datei namens `npm` ablegen.

  **Gespeichert wird `chosenPath`**, nicht das aufgelöste Ziel (Beschränkung 2).

### Ladepfad: `readInterpreterPaths` wird verschärft

Heute prüft die Funktion (`run-command.ts:110-121`) nur Objekt, bekannten Namen und
`typeof value === 'string'`. Neu verlangt sie zusätzlich `path.isAbsolute` und das
Bestätigungsmerkmal aus `confirmedAt`. Sie bleibt eine **reine Lesefunktion** ohne
Nebenwirkung; was durchfällt, wird schlicht nicht zurückgegeben.

Die Signatur wächst um den Zugriff auf `confirmedAt` — dafür genügt das vorhandene
`backing.get`, ein zweiter `get('confirmedAt', {})`. Kein `set`.

**Bewusst nicht im Ladepfad:** Existenz- und Ausführbarkeitsprüfung. Sie laufen beim Wählen
und erneut zur Laufzeit in `binaryIsRunnable`. Ein synchroner Dateisystem-Gang in einem Pfad,
der bei jedem Lauf ausgeführt wird, wäre teuer und würde den Zustand ausserdem zu früh
festschreiben. Diese Entscheidung steht hier, damit der Builder sie nicht "nachbessert".

### IPC

- `src/shared/types.ts`: `CODING_INTERPRETERS_LIST`, `CODING_INTERPRETERS_CHOOSE`,
  `CODING_INTERPRETERS_REMOVE`. **Drei Verben, kein viertes.**
- `src/main/ipc/infrastructure-handlers.ts`: drei `wrapHandler`-Registrierungen, synchron
  registriert (Beschränkung 6).
- `src/preload/index.ts`: `codingInterpreters: { list, choose, remove }`.
- `choose` und `remove` nehmen **nur den Interpreter-Namen**, nie einen Pfad. Unbekannter
  Name wird abgelehnt.

### Renderer

Ein Abschnitt in `FileAccessTab.tsx` unterhalb der Verzeichnisliste, gleiche Bauform wie dort
(`useState`, `useEffect`, `useCallback`, Laden über die neue IPC-Fläche):

```
Interpreters
Programs are never taken from PATH. Pick the exact file for each one.

  npm      ~/.nvm/versions/node/v24.13.1/bin/npm        [Change...]  [Remove]
  git      not set                                      [Choose...]
  pytest   not confirmed: /usr/bin/pytest               [Choose...]   [Remove]
```

Ein unbestätigter Eintrag wird mit seinem Pfad angezeigt und trägt denselben
`[Choose...]`-Knopf wie ein fehlender. Es gibt **keinen** Knopf, der einen bereits
gespeicherten Pfad ohne Dialog bestätigt: das wäre ein Pfad, den kein OS-Dialog geliefert
hat, und damit genau das benannte Anti-Ziel. Der Dialog startet in diesem Fall per
`defaultPath` im Verzeichnis des unbestätigten Eintrags, also ist es ein Klick mehr, nicht
eine Suche mehr.

### Das Modell erfährt nichts davon

Es entsteht **kein** Agent-Werkzeug für diesen Zustand. Die neue Fläche ist
renderer-seitig (`window.electronAPI`), und der Agent ruft nicht über den Renderer.
`COMMAND_UNAVAILABLE` bleibt die eine Refusal-Nachricht für alles Umgebungsabhängige.
Der Nutzer sieht den Grund, das Modell nicht — diese Asymmetrie ist der Zweck, nicht ein
Nebeneffekt.

## Bestehende Tests, die ersetzt werden

`tests/unit/coding-run-command.test.ts:1256-1271`, `describe('readInterpreterPaths')`:

- `'keeps only known names with string values'` behauptet, dass
  `{ npm: '/a/npm', pytest: '/a/pytest' }` **ohne jedes Merkmal** zurückkommt. Das
  widerspricht Ziel 3 und 4 direkt.
- `'returns nothing for a stored value that is not a map, and ignores the prototype'`
  bleibt unverändert gültig.

Begründung für die Änderung nach CLAUDE.md, Fall (a) **die Anforderung hat sich geändert:**
ein Eintrag ohne Bestätigung darf ab diesem Design nicht mehr honoriert werden, weil nur
ein Eintrag zählt, den Mingly nach einem Dialog geschrieben hat. Das Merkmal trennt
**von Hand geschrieben** von **von Mingly geschrieben**. Es ist **keine** Abwehr gegen einen
Renderer, der die Store-Datei schreiben kann: ein solcher Renderer schreibt `confirmedAt`
mit. Gemessen am 25.11.2026: `ALLOWED_CREATE_EXTENSIONS` enthält `.json`, und
`FileAccessManager.createFile` prüft Grant, `create`-Recht, Containment im Grant und Endung
— ohne Ausnahme für `app.getPath('userData')`; die Überschreibsperre greift nur bei bereits
existierender Datei. Mit einem `create`-Grant auf ein Verzeichnis oberhalb von userData und
noch fehlender Datei kann der Renderer beide Schlüssel anlegen und `validateChosenFile` ganz
umgehen. **Keine Regression:** vorher genügte derselbe Schreibvorgang mit `paths` allein,
diese Änderung verengt also. Das Abdichten von `createFile` gegen `userData` ist eine eigene
Änderung und gehört nicht in diesen Branch. Der erste Test wird umgeschrieben: gleiche
Eingabe **plus** passendes `confirmedAt` ergibt dasselbe Ergebnis; ohne `confirmedAt` ergibt
sie `{}`. Diese Begründung gehört in die PR-Beschreibung.

## Tests (TDD, jeder vorher rot, je mit Positivkontrolle)

Schreibpfad:
1. unbekannter Name wird abgelehnt
2. nicht absoluter Pfad wird abgelehnt
3. Verzeichnis wird abgelehnt
4. nicht ausführbare Datei wird abgelehnt
5. Basename passt nicht (`/usr/bin/ls` als `npm`) wird abgelehnt
6. **Symlink mit abweichendem Ziel-Basename wird akzeptiert** — ein Link `bin/npm` auf
   `lib/npm-cli.js` geht durch, und **gespeichert wird der Link**, nicht das Ziel.
   Das ist der Fall, der auf der Zielmaschine wirklich auftritt.
7. `chosenPath` unter `userData` wird abgelehnt
8. Symlink **auf** ein Ziel unter `userData` wird abgelehnt (die zweite Hälfte von Prüfung 6)
9. gültige Wahl schreibt `paths[name]` und `confirmedAt[name]`

Ladepfad:
10. Eintrag ohne `confirmedAt` wird nicht zurückgegeben
11. `confirmedAt` als `0`, `"x"` und `NaN` fällt geschlossen durch (drei Fälle)
12. nicht absoluter Eintrag wird nicht zurückgegeben
13. **Positivkontrolle:** ein gültiger, bestätigter Eintrag kommt durch
14. `readInterpreterPaths` schreibt nichts (kein `set` auf dem Backing — Spy-Kontrolle)

Grenzen:
15. ohne Konfiguration liefert ein Lauf exakt `COMMAND_UNAVAILABLE`, Zeichen für Zeichen
16. die Werkzeugliste der `ToolRegistry` ist unverändert (kein neues Agent-Werkzeug)
17. `childEnv` enthält das Verzeichnis des **gewählten** Pfades bestätigter Einträge, plus
    `/usr/bin` und `/bin` — nicht das Verzeichnis des aufgelösten Ziels

## Exit-Kriterium

Maschinell:
- `npm test` exit 0, die 17 neuen Tests grün, der ersetzte Test mit neuer Erwartung grün
- `npm run typecheck` exit 0 — **alle vier** `tsc`-Läufe, nicht zwei
- `npm run lint` exit 0 (`--max-warnings 0`, keine Toleranzliste)
- jeweils in einem Worktree nach `npm ci` **und** `npx tsx scripts/inject-secret.ts`

Beobachtbar:
- in einem lokalen `npm run dev` lässt sich `git` hinterlegen, und ein
  `mingly_run_command`-Aufruf von `git status --short` liefert danach eine Ausgabe statt
  `COMMAND_UNAVAILABLE`.

**Vorbedingung, die Holger kontrolliert:** das Tier steht seit dem Aufräumen vom 23.11. auf
`free`, also ist `agentic_mode` zu. Ohne reaktivierte Lizenz ist der beobachtbare Teil
*nicht prüfbar* — nicht rot. Der maschinelle Teil ist davon unabhängig.

## Was dem Builder bleibt

- die genaue Beschriftung der Zeilen und des Abschnitts
- ob der Block eine eigene Komponente in `FileAccessTab.tsx` wird oder inline bleibt
- die Form des Dialog-Mocks in den Tests

## DEBT

Auf dem **Oberflächen**-Block, nicht auf der Validierung:

```
DEBT: Nutzer muss den Pfad selbst kennen, keine Erkennung und kein Vorschlag
      -> erster gepackter Build, in dem nach einem abgelehnten Befehl
         coding-interpreters.json leer bleibt
```

Die Validierung sitzt an einer Trust-Boundary und wird nach CLAUDE.md nie weggemarkt.

## Korrekturen nach dem Builder-Check

Ein frischer Subagent hat den Entwurf als Umsetzer gelesen. Fünf Fragen kamen zurück, zwei
davon habe ich gegen die Maschine gemessen, bevor ich sie übernommen habe:

1. **Bestätigt und gravierend:** der Basename-Vergleich auf dem aufgelösten Pfad hätte `npm`
   auf der Zielmaschine abgelehnt (`npm-cli.js`), und das Speichern des aufgelösten Pfades
   hätte npm startunfähig gemacht. Messtabelle in Beschränkung 2. Entwurf geändert:
   Vergleich und Speicherung auf dem gewählten Pfad, `realpath` nur für Dateityp,
   Ausführbarkeit und Containment. Zwei neue Tests (6 und 17).
2. **Bestätigt:** `tests/unit/coding-run-command.test.ts:1256-1271` behauptet heute das
   Gegenteil der neuen Regel. Eigener Abschnitt mit Begründung ergänzt.
3. **Durch 2 erledigt:** das Parken entfällt, damit entfällt auch die Frage nach einem
   vierten IPC-Verb und nach `set` im Ladepfad. `[Confirm again]` ist zu `[Choose...]`
   geworden, weil ein Bestätigen ohne Dialog das Anti-Ziel verletzt hätte.
4. **Selbst entschieden:** kein Parent-Window, weil der Bestand es so macht
   (`file-access-manager.ts:230`); `defaultPath` wird gesetzt.
5. **Selbst entschieden:** `userData` wird vor dem Vergleich ebenfalls mit `realpath`
   aufgelöst, und beide Seiten werden geprüft (Prüfung 6, Tests 7 und 8).
