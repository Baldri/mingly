# Interpreter-Einstellungsoberfläche — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm`, `git` und `pytest` lassen sich in Mingly über die Einstellungen hinterlegen, sodass `mingly_run_command` nicht länger jeden Befehl mit `COMMAND_UNAVAILABLE` ablehnt.

**Architecture:** Der Renderer löst nur einen Dialog aus und nennt nie einen Pfad; der Main-Prozess führt den OS-Dateidialog, validiert das Ergebnis an einer einzigen Stelle und schreibt `paths[name]` plus `confirmedAt[name]` nach `coding-interpreters.json`. Der Ladepfad honoriert einen Eintrag nur mit Bestätigungsmerkmal. Namensvergleich und Speicherung laufen auf dem **gewählten** Pfad, `realpath` nur für Dateityp, Ausführbarkeit und Containment.

**Tech Stack:** Electron (Main/Preload/Renderer), TypeScript strict, React, Tailwind, Vitest, `SimpleStore` (JSON im userData), `electron.dialog`.

**Spec:** `docs/superpowers/specs/2026-11-24-coding-interpreters-settings-design.md`

## Global Constraints

- Keine `any`-Types (CLAUDE.md). `npm run lint` läuft mit `--max-warnings 0`, keine Toleranzliste.
- `npm run typecheck` muss **alle vier** `tsc`-Läufe grün haben, nicht zwei.
- Worktree-Vorbereitung: `npm ci` **und** `npx tsx scripts/inject-secret.ts`, sonst bricht `tsc` an der gitignorierten `_license-secret.ts` ab.
- `src/renderer/components/SettingsPage.tsx` wird **nicht** angefasst (455 CRLF-Zeilen, 0 LF). `FileAccessTab.tsx` ist reines LF und bleibt LF.
- Interpreter-Namen ausschliesslich aus `INTERPRETER_NAMES` (`src/main/coding/run-command.ts:87`): `['npm','git','pytest']`.
- `COMMAND_UNAVAILABLE` (`command-allowlist.ts:36`) bleibt Zeichen für Zeichen unverändert, und es entsteht **kein** Agent-Werkzeug für den Konfigurationszustand.
- Handler werden **synchron** registriert, kein `await import` im Registrierungspfad (U5 aus #45).
- Conventional Commits. Kein Push auf `main`, Feature-Branch.

## Review Focus

Fünf Fälle, die die Spec voraussetzt, ohne dass ein Task sie von sich aus prüft. Jeder bekommt seinen Test im Task, der den Code besitzt:

1. **Pfad mit Leerzeichen oder Nicht-ASCII** (`/Users/müller/.nvm/.../npm`). `TOKEN_CHARS` in `command-allowlist.ts:46` ist ASCII-only und ohne Leerzeichen, gilt aber nur für die Tokens, die das Modell schickt — nicht für den konfigurierten Pfad. Erwartung: die Oberfläche speichert ihn, und ein Lauf startet ihn (argv-basiert, keine Shell). → Test in Task 3 und Task 7.
2. **Der hinterlegte Pfad verschwindet später** (nvm-Version gelöscht, Homebrew-Upgrade). Erwartung: die Oberfläche sagt "not found" statt ihn als gültig zu zeigen, und der Lauf lehnt weiter mit `COMMAND_UNAVAILABLE` ab. → Test in Task 4 (`listInterpreters`, Feld `found`) und Task 7.
3. **Dialog abgebrochen.** Erwartung: kein Schreibzugriff, kein Fehler, Zustand unverändert. → Test in Task 4.
4. **`confirmedAt` in der Zukunft oder absurd gross.** Der Marker prüft nur "positive, endliche Zahl", also gilt er. Erwartung: genau das, dokumentiert statt stillschweigend. → Test in Task 1.
5. **`paths` enthält einen Namen, der nicht in `INTERPRETER_NAMES` steht** (von Hand eingetragen, etwa `node` oder `rm`). Erwartung: wird ignoriert, auch mit gültigem Marker. → Test in Task 2.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/shared/file-access-types.ts` | **modify** — `isConfirmationTimestamp()` als geteiltes Primitiv herauslösen |
| `src/shared/coding-interpreter-types.ts` | **create** — `InterpreterState`, von Main und Renderer benutzt |
| `src/main/coding/interpreter-settings.ts` | **create** — Validierung, Dialog, Lesen/Schreiben des Stores |
| `src/main/coding/run-command.ts` | **modify** Z. 110-121 — `readInterpreterPaths` verlangt Marker und Absolutheit |
| `src/shared/types.ts` | **modify** — drei IPC-Kanäle |
| `src/main/ipc/infrastructure-handlers.ts` | **modify** — drei `wrapHandler` |
| `src/preload/index.ts` | **modify** — `codingInterpreters: { list, choose, remove }` |
| `src/renderer/components/FileAccessTab.tsx` | **modify** — Abschnitt "Interpreters" |
| `README.md` Z. 104 | **modify** — die Aussage "es gibt keine Einstellungsoberfläche" wird falsch |
| `tests/unit/coding-interpreter-settings.test.ts` | **create** |
| `tests/unit/coding-interpreters-handlers.test.ts` | **create** |
| `tests/unit/coding-run-command.test.ts` Z. 1256-1271 | **modify** — ersetzter Test, Begründung in die PR |

---

### Task 1: Das Bestätigungsmerkmal als geteiltes Primitiv

**Files:**
- Modify: `src/shared/file-access-types.ts:88`
- Test: `tests/unit/file-access-types.test.ts` (existiert, gemessen)

**Interfaces:**
- Consumes: nichts
- Produces: `isConfirmationTimestamp(value: unknown): boolean` — `true` nur für `typeof value === 'number' && Number.isFinite(value) && value > 0`

- [ ] **Step 1: Write the failing tests**

```ts
describe('isConfirmationTimestamp', () => {
  it('accepts a positive finite number', () => {
    expect(isConfirmationTimestamp(1764000000000)).toBe(true)
    expect(isConfirmationTimestamp(1)).toBe(true)
  })
  it('fails closed on everything else', () => {
    for (const v of [0, -1, NaN, Infinity, -Infinity, '1764000000000', null, undefined, {}, []])
      expect(isConfirmationTimestamp(v)).toBe(false)
  })
  // Review Focus 4: ein Zeitstempel in der Zukunft gilt, und das ist Absicht.
  it('accepts a timestamp in the future, by design', () => {
    expect(isConfirmationTimestamp(Date.now() + 10 ** 12)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/file-access-types.test.ts -t isConfirmationTimestamp`
Expected: FAIL, `isConfirmationTimestamp is not a function`

- [ ] **Step 3: Implement `isConfirmationTimestamp(value: unknown): boolean` in `src/shared/file-access-types.ts` und lasse `hasConfirmationMarker(dir)` auf `isConfirmationTimestamp(dir.confirmedAt)` delegieren**

Der Kommentar "Kept as the single place this is decided" wandert auf das neue Primitiv.

- [ ] **Step 4: Run the full file-access tests to prove nothing moved**

Run: `npx vitest run tests/unit/file-access-types.test.ts tests/unit/file-access-manager.test.ts`
Expected: PASS, keine Änderung an bestehenden Erwartungen

- [ ] **Step 5: Commit**

```bash
git add src/shared/file-access-types.ts tests/unit/file-access-types.test.ts
git commit -m "refactor(shared): extract isConfirmationTimestamp as the single marker rule"
```

---

### Task 2: `readInterpreterPaths` verlangt Marker und Absolutheit

**Files:**
- Modify: `src/main/coding/run-command.ts:110-121`
- Modify: `tests/unit/coding-run-command.test.ts:1256-1271`

**Interfaces:**
- Consumes: `isConfirmationTimestamp` aus Task 1
- Produces: `readInterpreterPaths(backing: { get(key: string, d?: unknown): unknown }): Record<string, string>` — Signatur unverändert, liest jetzt zusätzlich `backing.get('confirmedAt', {})`. **Reine Lesefunktion, kein `set`.**

- [ ] **Step 1: Rewrite the superseded test and add the new ones**

Der bestehende Test `'keeps only known names with string values'` behauptet, dass Einträge ohne Marker zurückkommen. Er wird umgeschrieben, Begründung: **die Anforderung hat sich geändert** (CLAUDE.md, Fall a) — ein unbestätigter Eintrag ist von einem nicht zu unterscheiden, den ein kompromittierter Renderer geschrieben hat. Diese Begründung gehört in die PR-Beschreibung.

```ts
const backing = (paths: unknown, confirmedAt: unknown = {}) => ({
  get: (key: string) => (key === 'paths' ? paths : confirmedAt)
})
const ok = { npm: 1764000000000, git: 1764000000000, pytest: 1764000000000 }

it('keeps only known names with string values, and only when confirmed', () => {
  expect(readInterpreterPaths(backing(
    { npm: '/a/npm', git: 5, pytest: '/a/pytest', node: '/a/node', rm: '/bin/rm' }, ok
  ))).toEqual({ npm: '/a/npm', pytest: '/a/pytest' })
})

it('drops an entry without a marker', () => {
  expect(readInterpreterPaths(backing({ npm: '/a/npm' }, {}))).toEqual({})
})

it('fails closed on an unusable marker', () => {
  for (const bad of [0, 'x', NaN, null])
    expect(readInterpreterPaths(backing({ npm: '/a/npm' }, { npm: bad }))).toEqual({})
})

it('drops a relative path even when confirmed', () => {
  expect(readInterpreterPaths(backing({ npm: 'npm' }, ok))).toEqual({})
})

// Review Focus 5
it('ignores an unknown name even with a valid marker', () => {
  expect(readInterpreterPaths(backing(
    { node: '/a/node', rm: '/bin/rm' }, { node: 1764000000000, rm: 1764000000000 }
  ))).toEqual({})
})

it('writes nothing', () => {
  const set = vi.fn()
  readInterpreterPaths({ get: () => ({}), set } as never)
  expect(set).not.toHaveBeenCalled()
})
```

Der zweite bestehende Test (`'returns nothing for a stored value that is not a map, and ignores the prototype'`) bleibt unverändert und ist die Positivkontrolle dafür, dass die Verschärfung nichts Vorhandenes bricht.

- [ ] **Step 2: Run to verify the new ones fail**

Run: `npx vitest run tests/unit/coding-run-command.test.ts -t readInterpreterPaths`
Expected: FAIL — die Marker-Tests scheitern, weil heute jeder String durchkommt

- [ ] **Step 3: Implement the two extra conditions in `readInterpreterPaths`**

Pro Name zusätzlich verlangen: `path.isAbsolute(value)` und `isConfirmationTimestamp(confirmedAt[name])`. Der Doc-Kommentar der Funktion wird angepasst: er behauptet heute "the user confirmed in the settings", was erst jetzt stimmt.

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run tests/unit/coding-run-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/coding/run-command.ts tests/unit/coding-run-command.test.ts
git commit -m "fix(coding): honour an interpreter path only with a confirmation marker"
```

---

### Task 3: Validierung des gewählten Pfades

**Files:**
- Create: `src/main/coding/interpreter-settings.ts`
- Create: `tests/unit/coding-interpreter-settings.test.ts`

**Interfaces:**
- Consumes: `INTERPRETER_NAMES` (muss aus `run-command.ts:87` exportiert werden)
- Produces: `validateChosenFile(name: string, chosenPath: string): string | null` — gibt den **zu speichernden** Pfad zurück (immer `chosenPath`) oder `null`, wenn eine Prüfung fällt. Kein Grund-String: der Aufrufer braucht keinen, und die Oberfläche zeigt nur Erfolg oder Misserfolg.

- [ ] **Step 1: Write the failing tests against a real tmpdir**

Echtes Dateisystem, keine `fs`-Doubles — die Symlink-Fälle sind der Kern und ein Double würde sie vortäuschen (`zwei-gruene-pr-kombiniert-rot-durch-test-double`).

```ts
it('refuses an unknown interpreter name', ...)                      // name 'node'
it('refuses a relative path', ...)                                   // 'bin/npm'
it('refuses a directory', ...)
it('refuses a file that is not executable', ...)                     // chmod 0o644
it('refuses a basename that does not match', ...)                    // <tmp>/ls as 'npm'
it('accepts a symlink whose target has another basename, and returns the LINK', ...)
  // <tmp>/bin/npm -> <tmp>/lib/npm-cli.js  =>  returns <tmp>/bin/npm
it('refuses a chosen path inside userData', ...)
it('refuses a symlink pointing into userData', ...)
it('accepts a path containing a space and a non-ASCII character', ...)  // Review Focus 1
it('accepts npm.cmd and npm.exe on win32 only', ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/coding-interpreter-settings.test.ts`
Expected: FAIL, Modul existiert nicht

- [ ] **Step 3: Implement `validateChosenFile` in the order the spec fixes**

Reihenfolge ist bindend, weil der Namensvergleich **vor** der Auflösung laufen muss: `isAbsolute` → Basename-Vergleich auf `chosenPath` → `fs.realpathSync` → reguläre Datei → ausführbar (`fs.accessSync(target, fs.constants.X_OK)`) → Containment gegen `fs.realpathSync(app.getPath('userData'))`, geprüft für `chosenPath` **und** das aufgelöste Ziel. Erlaubte Basenames: `name`, auf `win32` zusätzlich `name.cmd` und `name.exe`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/coding-interpreter-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/coding/interpreter-settings.ts tests/unit/coding-interpreter-settings.test.ts src/main/coding/run-command.ts
git commit -m "feat(coding): validate a chosen interpreter file at the trust boundary"
```

---

### Task 4: Lesen, Schreiben, Entfernen und der Dialog

**Files:**
- Modify: `src/main/coding/interpreter-settings.ts`
- Create: `src/shared/coding-interpreter-types.ts`
- Modify: `tests/unit/coding-interpreter-settings.test.ts`

**Interfaces:**
- Consumes: `validateChosenFile` aus Task 3, `isConfirmationTimestamp` aus Task 1
- Produces:
  - `interface InterpreterState { name: string; path: string | null; confirmed: boolean; found: boolean }` in `src/shared/coding-interpreter-types.ts`
  - `listInterpreters(): InterpreterState[]`
  - `chooseInterpreter(name: string): Promise<boolean>`
  - `removeInterpreter(name: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
it('lists all three names, unset when the store is empty', ...)
it('reports an entry without a marker as confirmed:false but keeps its path', ...)
it('reports found:false when the stored path no longer exists', ...)   // Review Focus 2
it('writes paths[name] and confirmedAt[name] on a valid choice', ...)
it('writes nothing when the dialog is cancelled', ...)                 // Review Focus 3
it('writes nothing when validation refuses the dialog result', ...)
it('refuses an unknown name without opening a dialog', ...)
it('removeInterpreter clears both keys', ...)
```

`electron.dialog` wird gemockt; `app.getPath('userData')` zeigt auf einen tmpdir.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/coding-interpreter-settings.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the three functions**

`chooseInterpreter` ruft `dialog.showOpenDialog({ properties: ['openFile'], title, message, defaultPath })` **ohne Parent-Window** (so wie `file-access-manager.ts:230`); `defaultPath` ist `path.dirname()` eines bereits hinterlegten Eintrags, sonst weggelassen. Store über `SimpleStore.create('coding-interpreters.json')`. `found` in `listInterpreters` kommt aus einem `fs.existsSync` auf dem gespeicherten Pfad — hier ist der Dateisystem-Gang billig, weil die Funktion nur beim Öffnen der Einstellungen läuft, nicht bei jedem Befehl.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/coding-interpreter-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/coding/interpreter-settings.ts src/shared/coding-interpreter-types.ts tests/unit/coding-interpreter-settings.test.ts
git commit -m "feat(coding): read, write and remove interpreter settings"
```

---

### Task 5: IPC-Fläche

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc/infrastructure-handlers.ts`
- Modify: `src/preload/index.ts`
- Create: `tests/unit/coding-interpreters-handlers.test.ts` — eigene Datei pro Handler-Anliegen,
  wie `agent-execute-coding-handler.test.ts` und `business-handlers-license-registration.test.ts`

**Interfaces:**
- Consumes: `listInterpreters`, `chooseInterpreter`, `removeInterpreter` aus Task 4
- Produces: `window.electronAPI.codingInterpreters.{ list(): Promise<InterpreterState[]>, choose(name: string): Promise<boolean>, remove(name: string): Promise<boolean> }`

- [ ] **Step 1: Write the failing tests**

```ts
it('registers all three channels synchronously', ...)
  // die Registrierungsfunktion aufrufen und DANACH, ohne await, pruefen,
  // dass ipcMain.handle fuer alle drei Kanaele gerufen wurde (U5 aus #45)
it('the choose handler refuses an unknown name', ...)
it('no channel accepts a path argument', ...)
  // choose('npm', '/evil/npm') darf den zweiten Parameter nicht verwenden
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/coding-interpreters-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: Add `CODING_INTERPRETERS_LIST`, `CODING_INTERPRETERS_CHOOSE`, `CODING_INTERPRETERS_REMOVE` and wire the three handlers plus the preload block**

Drei Verben, kein viertes. Die Handler nehmen nur `name: string`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/unit/coding-interpreters-handlers.test.ts && npm run typecheck`
Expected: PASS, Typecheck exit 0 über alle vier Läufe

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/ipc/infrastructure-handlers.ts src/preload/index.ts tests/unit/coding-interpreters-handlers.test.ts
git commit -m "feat(ipc): expose interpreter settings without ever taking a path"
```

---

### Task 6: Oberfläche im File-Access-Tab

**Files:**
- Modify: `src/renderer/components/FileAccessTab.tsx` (reines LF, bleibt LF)
- Modify: `README.md:104`

**Interfaces:**
- Consumes: `window.electronAPI.codingInterpreters` aus Task 5, `InterpreterState` aus Task 4
- Produces: nichts für spätere Tasks

**Dieser Task hat keine automatisierten Tests, und das ist eine Entscheidung, kein Versäumnis.**
Gemessen am 2026-11-24: das Projekt hat **keine einzige** `.tsx`-Testdatei, `@testing-library/react`
steht in keiner der beiden Abhängigkeitslisten, und die `include`-Globs in `vitest.config.ts:11`
erfassen nur `*.test.ts` und `*.spec.ts` — eine Komponenten-Testdatei würde nicht einmal
eingesammelt. Komponenten-Tests einzuführen wäre eine eigene Projektentscheidung in derselben
Klasse wie die Linter-Einführung (#44/#49), nicht ein Nebenschritt dieses Features.

Tragbar ist das hier, weil jede Regel, die etwas entscheidet, im Main-Prozess liegt und dort
geprüft wird: `validateChosenFile` (Task 3), `listInterpreters` mit `found` (Task 4) und die
IPC-Fläche (Task 5). Vor allem gilt das für das Anti-Ziel "kein Pfad ohne OS-Dialog": es ist
**strukturell** gesichert, weil kein vierter IPC-Kanal existiert, der einen gespeicherten Pfad
ohne Dialog bestätigen könnte — Task 5 prüft genau das. Eine Komponenten-Assertion wäre die
schwächere Zusicherung. Was bleibt, sind drei Zeilen und drei Knopf-Handler, also Glue.

- [ ] **Step 1: Add the "Interpreters" section below the directory list**

Bauform wie der Rest der Datei: `useState`, `useEffect`, `useCallback`, Laden über
`window.electronAPI.codingInterpreters.list()`, Neuladen nach `choose` und nach `remove`.
Einleitungssatz: `Programs are never taken from PATH. Pick the exact file for each one.`
Englisch, wie der ganze Tab. Pro Name eine Zeile mit dem Zustand aus `InterpreterState`:
Pfad wenn gesetzt, `not set` wenn nicht, `not confirmed: <pfad>` wenn `confirmed` falsch ist,
`not found: <pfad>` wenn `found` falsch ist. Ein unbestätigter oder fehlender Eintrag bekommt
denselben `Choose...`-Knopf wie ein leerer. **Es gibt keinen Knopf, der ohne Dialog bestätigt.**

- [ ] **Step 2: Correct `README.md:104`**

Die Zeile behauptet, es gebe keine Einstellungsoberfläche. Nach diesem Task ist das falsch.
Der Hinweis, dass Mingly **keinen Pfad vorschlägt**, bleibt richtig und bleibt stehen.

- [ ] **Step 3: Verify by hand in a dev run**

Run: `npm run dev`, dann Einstellungen → File Access → Interpreters.
Expected: drei Zeilen; `Choose...` öffnet den OS-Dateidialog; nach der Wahl von `git` steht
dessen Pfad in der Zeile; `Remove` leert sie wieder.
Wird das nicht erreicht, ist der Task nicht fertig — ein unbeaufsichtigter Lauf darf diesen
Schritt nicht überspringen, sondern meldet P2 und stoppt.

- [ ] **Step 4: Run typecheck and lint, which DO cover this file**

Run: `npm run typecheck; echo "EXIT=$?"` und `npm run lint; echo "EXIT=$?"`
Expected: beide exit 0. Der Renderer-`tsc`-Lauf und die vier ESLint-Blöcke erfassen `.tsx`,
auch wenn die Testsuite es nicht tut.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/FileAccessTab.tsx README.md
git commit -m "feat(ui): add an Interpreters section to the File Access tab"
```

---

### Task 7: Die Grenzen beweisen

Dieser Task fügt keinen Produktionscode hinzu. Er beweist die drei Anti-Ziele und setzt den `DEBT:`-Marker.

**Files:**
- Modify: `tests/unit/coding-run-command.test.ts`
- Modify: `src/renderer/components/FileAccessTab.tsx` (nur der `DEBT:`-Kommentar)

**Interfaces:**
- Consumes: alles aus Task 2 bis 6
- Produces: nichts

- [ ] **Step 1: Write the boundary tests**

```ts
it('a run without any configuration still returns exactly COMMAND_UNAVAILABLE', ...)
  // Zeichenvergleich gegen die Konstante, nicht gegen einen Teilstring
it('the ToolRegistry tool list is unchanged', ...)
  // kein Werkzeug, mit dem das Modell den Konfigurationszustand lesen koennte
it('childEnv contains the directory of the CHOSEN path, not of the resolved target', ...)
  // Symlink-Fixture wie in Task 3: erwartet <tmp>/bin, nicht <tmp>/lib
it('childEnv keeps /usr/bin and /bin and adds nothing else', ...)
it('a configured path containing a space is startable', ...)   // Review Focus 1, zweite Haelfte
it('a configured path that no longer exists still refuses with COMMAND_UNAVAILABLE', ...)  // Review Focus 2
```

- [ ] **Step 2: Run to verify which ones fail**

Run: `npx vitest run tests/unit/coding-run-command.test.ts`
Expected: die `childEnv`-Tests scheitern, wenn Task 3 den falschen Pfad speichert — sie sind die Absicherung gegen genau diesen Fehler. Alle anderen sollten schon grün sein; ein grüner Test hier ist eine Positivkontrolle, kein fehlender Test.

- [ ] **Step 3: Add the DEBT marker above the Interpreters section**

```
// DEBT: Nutzer muss den Pfad selbst kennen, keine Erkennung und kein Vorschlag
//       -> erster gepackter Build, in dem nach einem abgelehnten Befehl
//          coding-interpreters.json leer bleibt
```

- [ ] **Step 4: Run the full gate**

Run: `npm test > /tmp/test.log 2>&1; echo "EXIT=$?"` dann **das Log lesen**, nicht die Zusammenfassung (RTK.md Regel 4 und Memory `rtk-vitest-zusammenfassung-verbirgt-import-fehler`).
Dann: `npm run typecheck; echo "EXIT=$?"` und `npm run lint; echo "EXIT=$?"`
Expected: alle drei exit 0

- [ ] **Step 5: Commit**

```bash
git add tests/unit/coding-run-command.test.ts src/renderer/components/FileAccessTab.tsx
git commit -m "test(coding): pin the three boundaries the interpreter UI must not move"
```

---

## Exit-Kriterium des ganzen Plans

Maschinell, in diesem Worktree (`npm ci` und `inject-secret` sind gelaufen):
- `npm test` exit 0, Log gelesen, Gesamtzahl über 2909
- `npm run typecheck` exit 0, alle vier `tsc`-Läufe
- `npm run lint` exit 0

Beobachtbar, einmal von Hand:
- `npm run dev`, Einstellungen → File Access → Interpreters, `git` hinterlegen, dann ein
  `mingly_run_command` mit `git status --short`: es kommt eine Ausgabe statt `COMMAND_UNAVAILABLE`.
- Tier steht seit dem 24.11. wieder auf `pro`, `agentic_mode` ist also offen. Ob die
  zurückgespielte Lizenz von einem Dev-Build akzeptiert wird, ist **noch nicht gemessen** —
  das entscheidet, ob dieser Teil prüfbar ist oder *nicht prüfbar*.
