# Safe Vibe Coding — Umsetzungsplan (Schritt 0 + Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mingly bekommt einen abgestuften Coding-Modus, in dem jeder Inhalt, den der Agent selbst einsammelt, dieselbe Schutzschicht passiert wie getippter Text — und jede Dateiänderung vom Nutzer abgenommen und rückgängig gemacht werden kann.

**Architecture:** Der Guard wandert von einem einmaligen Aufruf vor dem Agent-Loop in den Loop hinein: ein `guardInput`-Aufruf pro Tool-Ergebnis, vor der Kompaktierung, plus `postflightGuard` pro Schritt. Vier Coding-Werkzeuge werden kontextabhängig in der bestehenden `ToolRegistry` freigeschaltet; Schreibungen laufen über eine Vorschlags-/Abnahme-Schicht mit Snapshot im Projekt. Kein neuer Guard-Code — die vorhandene Zerlegung `guardInput`/`guardDispatch` wird an weiteren Stellen aufgerufen.

**Tech Stack:** Electron 44, TypeScript strict, React 18, Zustand, Vitest, `electron-store` (Grants), vorhandene Module `request-guard`, `policy-engine`, `provider-registry`, `real-path-guard`, `activity-logger`.

**Spec:** [docs/superpowers/specs/2026-11-18-safe-vibe-coding-design.md](../specs/2026-11-18-safe-vibe-coding-design.md) — freigegeben von Holger am 2026-11-18. Der Plan argumentiert aus dem Spec; wer umsetzt, liest beide.

**Umfang dieses Plans:** Schritt 0 (Task 1, eigener PR) und Phase 1 (Task 2–13, ein PR). **Phase 2** (Coding-Workspace als ViewMode) bekommt einen eigenen Plan, nachdem Phase 1 das Exit-Kriterium erfüllt hat — so verlangt es der Spec in Abschnitt 5 ("Phase 2 beginnt danach, nicht parallel"), und ein Plan für eine Oberfläche über noch nicht existierenden Werkzeugen wäre geraten, nicht geplant.

---

## Global Constraints

Gelten für **jeden** Task; die Anforderungen jedes Tasks schliessen sie stillschweigend ein.

- **Kein Push auf main.** Feature-Branch, PR. Task 1 geht als **eigener PR** voran und wird gemerged, bevor Task 2 beginnt.
- **Typecheck sind zwei Läufe:** `tsc --noEmit && tsc -p tsconfig.main.json --noEmit`. Ein grüner erster Lauf belegt für `src/main` nichts.
- **Testing-Pflicht:** kein Task gilt als fertig ohne grünen Testlauf. Jeder Test muss **vor** der Implementierung rot gelaufen sein; der rote Lauf ist Teil der Schritte.
- **Nie zum Grünwerden:** keine gelockerte Assertion, kein `.skip`, kein `--no-verify`, kein `CLAUDE_SKIP_COMMIT_GATE=1`.
- **Fail-closed bei jeder neuen Entscheidung.** Unbekannter Wert, fehlendes Feld, nicht auflösbarer Pfad → die strengere Seite. Lehre aus dem `policy-engine`-Fail-open.
- **Prozessgrenze:** der Renderer greift nicht in den Modulgraph des Main-Prozesses. Neue gemeinsame Typen gehören nach `src/shared/`; `tests/unit/renderer-process-boundary.test.ts` hält die Grenze und muss grün bleiben.
- **Feature-Gate:** der Coding-Modus erbt `requireFeature('agentic_mode')` (Pro+). Neue IPC-Kanäle, die Coding auslösen, rufen es ebenfalls.
- **Keine Shell-Interpretation** in `run_command`: kein `&&`, kein `|`, kein `;`, keine Substitution, `spawn(..., { shell: false })`.
- **Keine Binärdatei aus `process.env.PATH` zur Laufzeit.** Nur `<projekt>/node_modules/.bin` oder ein in den Einstellungen gesetzter absoluter Pfad.
- **Blockliste ist absolut** (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `credentials.json`, `secrets.yaml`, `secrets.yml`, `.npmrc`, `.netrc`, `.git/config`, `*.sqlite`, `*.db`). Kein Dialog, kein Modus hebt sie auf. **Erweitert am 2026-11-19 (R38)** um die Namen, die im Task-8-Bericht als lesbar oder nur zufaellig geblockt aufgefallen waren: `*.pfx` ist das Geschwister von `*.p12`, `id_rsa*` allein ist veraltet (ed25519 ist ssh-keygens Standard), `credentials.json` und `secrets.*` sind nach ihrem Inhalt benannt, `.npmrc`/`.netrc` tragen Tokens, `*.db` ist die andere sqlite-Endung. **Nicht** zu `id_*` verallgemeinern — das fienge `id_generator.ts`.
  **Zweite Erweiterung am 2026-11-19 (R41), und diesmal nach FAMILIEN statt Instanzen:**
  `secrets.*` (statt dreier Endungen), **das ganze `.git/`-Verzeichnis** in jeder Tiefe
  (statt nur `.git/config` — das fing weder `.git/modules/*/config` noch
  `.git/config.worktree`; ein Agent hat in git-Interna nichts zu lesen, git-Zustand
  gehoert in git-Befehle), `service-account*.json`, `.docker/config.json`, `.yarnrc.yml`.
  **Lehre:** R38 trug Instanzen nach, und das Task-8-Review fand sofort die naechsten —
  darunter zwei Inkonsistenzen in R38 selbst (`secrets.yaml` ja, `.json` nein; `.npmrc`
  ja, `.yarnrc.yml` nein). Eine Denyliste, die instanzweise waechst, laedt die naechste
  Instanz ein. Wo die Familie klar definiert ist, gehoert die Familie hinein.
  `.gitignore` und `.gitattributes` bleiben lesbar, obwohl `.git/` blockt — diese
  Unterscheidung bekommt einen eigenen Test.
  **R42:** ein projektrelativer Pfad mit **Doppelpunkt** wird abgelehnt. `a.key::$DATA`
  und `a.pem:stream` oeffnen auf NTFS den Datenstrom der geblockten Datei und bestehen
  die Namenspruefung; heute faengt sie nur zufaellig die Endungsliste — und «zufaellig
  geblockt ist nicht geblockt» war genau die Begruendung fuer R38.
  **R45/R46/R47 — die `secrets`-Regel, endgueltige Form.** Nach drei Anlaeufen
  (Glob → Datenendungs-Denyliste → Allowlist) gilt: `secrets` und `secrets.<beliebig>`
  sind geblockt, **ausser** die letzte Endung ist Code oder Prosa — eine **Allowlist**,
  damit ein Format, das es noch nicht gibt, abgelehnt wird (R45). Die Ausnahme gilt
  **nur fuer das letzte Pfadsegment**: ein Ordner `secrets.ts/` ist kein Quelltext, also
  ist `secrets.ts/api.json` geblockt (R46). Und `sql` zaehlt als **Daten**, nicht als
  Code: eine `.sql`-Datei ist oft ein generierter Dump (R47).
  **Die Linie, die alle drei traegt:** ausgenommen sind Endungen, deren **Zweck** von
  Menschen geschriebener Quelltext oder Prosa ist. **Warum die Ausnahme vertretbar
  ist:** ein hartcodiertes Geheimnis in Quelltext hat typischerweise eine Form, die der
  Inhalts-Guard kennt (`sk-ant-…`, `AKIA…`, `password =`). Bei einem SQL-Dump gilt das
  **nicht** — dort ist der wahrscheinlichste Treffer eine E-Mail, die ist
  anonymisierbar, also wuerde «anonymisiert senden» die Adressen ersetzen und die
  Passwort-Hashes mitschicken. Deshalb entscheidet dort der **Name**, nicht der Guard.
- **Kein `auto`-Modus in Phase 1.** Jede Schreibung wird abgenommen.
- **Kein Provider-Wechsel mitten im Run — in keinem Run-Typ.** Der Run endet stattdessen mit Grund. (Verschärft am 2026-11-19 gegenüber der ursprünglichen Fassung «mitten im Coding-Run»; Begründung bei Task 4.)
- **Sprache:** Code und Kommentare englisch, Dokumentation CH-Deutsch mit echten Umlauten, nie `ß`.
- **Conventional Commits.** Jeder Task endet mit einem Commit.

---

## Review Focus

Fünf Eingabeklassen, die der Spec voraussetzt, ohne sie zu benennen — am Code geprüft, nach Wahrscheinlichkeit geordnet, dass ein Nutzer darüber fällt. Für jede ist unten in dem Task, der den Code besitzt, ein Test eingetragen.

1. **Nicht-Text-Datei im Leseumfang.** `ALLOWED_READ_EXTENSIONS` enthält `.jpg`, `.png`, `.gif`, `.webp`. `read_file` würde Binärdaten als String in `messages` schieben: Tokens verbrannt, Injection-Scan auf Müll, und die Vorschau der Kompaktierung zeigt Unsinn. Erwartung: klare Ablehnung mit Begründung. → Test in Task 9.
2. **`old`-Text kommt null- oder mehrmals vor.** `edit_file(path, old, new)` ist exakte Ersetzung; der Spec sagt nicht, was bei Mehrdeutigkeit passiert. Still das erste Vorkommen zu ersetzen ist die Klasse Fehler, die man erst drei Commits später sieht. Erwartung: Ablehnung, die die Trefferzahl nennt. → Test in Task 10.
3. **Zwei `edit_file`-Aufrufe auf dieselbe Datei in einem Schritt.** `executeToolCalls` führt die Aufrufe eines Schritts mit `Promise.allSettled` parallel aus. Der zweite `old`-Text wird gegen den Zustand *vor* der ersten Änderung geprüft; beide Diffs zusammen sind nicht anwendbar. Der Spec hat parallele *Runs* ausgeschlossen, nicht parallele Aufrufe. Erwartung: erkannt und abgelehnt, nicht letzter-gewinnt. → Test in Task 10.
4. **Abbruch zwischen Abnahme und Schreibung.** Run-Timeout und `cancelRun` greifen jederzeit. Eine halb geschriebene Datei ist schlimmer als keine, weil der Snapshot dann einen Zustand sichert, den es nie gab. Erwartung: Datei ist entweder vollständig alt oder vollständig neu. → Test in Task 11.
5. **Grant entzogen oder Modus gesenkt, während der Run pausiert.** Modus und Grant werden beim Start gelesen; zwischen Zustimmungs-Dialog und Schreibung liegt beliebig viel Zeit. Erwartung: die ausstehende Schreibung landet nicht. → Test in Task 11.

---

# PR 1 — Schritt 0

Eigener PR, **vor** Phase 1. Er ändert das Verhalten bestehender Chat-Nutzer: wer über Infomaniak chattet, sieht danach Zustimmungs-Dialoge, die er nie gesehen hat. Deshalb muss er einzeln beurteilt und einzeln zurückgedreht werden können.

### Task 1: Cloud-Begriff aus der Registry-Residenz

**Files:**
- Modify: `src/shared/provider-types.ts` (neue Funktion am Ende, neben `Residency`)
- Modify: `src/main/security/request-guard-deps.ts:18` (Konstante entfällt), `:83` (`isCloudProvider`)
- Test: `tests/unit/provider-types.test.ts` (neu, falls nicht vorhanden), `tests/unit/routing-guard-wiring.test.ts` (erweitern)

**Interfaces:**
- Consumes: `Residency` aus `src/shared/provider-types.ts:210` (`'CH' | 'EU' | 'US' | 'on-device' | 'unknown'`), `getProviderRegistry().get(id)?.origin.residency`.
- Produces: `residencyIsCloud(residency: Residency | undefined): boolean` — wird von keinem späteren Task gebraucht, aber von `request-guard-deps` dauerhaft.

Begründung der Zuordnung, als Kommentar in den Code: `on-device` ist der einzige Wert, bei dem der Inhalt die Maschine nicht verlässt. `CH` ist ein gemietetes Rechenzentrum in Genf — der Inhalt geht weg, also Cloud, also Zustimmung. `undefined` (Anbieter nicht in der Registry) und `unknown` (von `registerTenant` erzwungen) sind Cloud, weil ein unbekannter Ursprung kein Freibrief ist.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/provider-types.test.ts
it('on-device is the only residency that is not cloud', () => {
  expect(residencyIsCloud('on-device')).toBe(false)
})
it('a Swiss rented datacenter counts as cloud', () => {
  expect(residencyIsCloud('CH')).toBe(true)
})
it('an unknown or absent residency counts as cloud', () => {
  expect(residencyIsCloud('unknown')).toBe(true)
  expect(residencyIsCloud(undefined)).toBe(true)
})
it('the three hardcoded providers keep their classification', () => {
  for (const r of ['US', 'EU'] as const) expect(residencyIsCloud(r)).toBe(true)
})
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/provider-types.test.ts`
Expected: FAIL — `residencyIsCloud is not a function`

- [ ] **Step 3: `residencyIsCloud(residency: Residency | undefined): boolean` in `src/shared/provider-types.ts` implementieren**

- [ ] **Step 4: Lauf, der durchläuft**

Run: `npx vitest run tests/unit/provider-types.test.ts`
Expected: PASS (4 Tests)

- [ ] **Step 5: Verdrahtungstest schreiben — der eigentliche Nachweis**

Das Exit-Kriterium von Schritt 0 verlangt, dass der **Zustimmungs-Zweig** läuft, nicht nur dass eine Funktion `true` sagt. `guardInput` überspringt bei `isCloudProvider === false` den Sensitivdaten-Scan *und* den gesamten Zustimmungs-Zweig (`request-guard.ts:61`).

```ts
// tests/unit/routing-guard-wiring.test.ts — ergänzen
it('a CH provider reaches the sensitive-data consent branch', async () => {
  // deps: isCloudProvider via residencyIsCloud('CH'), scanSensitive finds a match,
  // checkUploadPermission returns { requiresUserConsent: true }
  const out = await guardInput({ texts: ['IBAN CH93 0076 2011 6238 5295 7'], provider: 'infomaniak', model: 'm' }, deps)
  expect(out.kind).toBe('consent')
})
it('positive control: an on-device provider still skips the scan', async () => {
  const out = await guardInput({ texts: ['IBAN CH93 0076 2011 6238 5295 7'], provider: 'ollama', model: 'm' }, deps)
  expect(out.kind).toBe('ok')
  expect(deps.scanSensitive).not.toHaveBeenCalled()
})
```

Die Positivkontrolle ist nicht optional: ohne sie belegt der erste Test nur, dass jetzt *irgendetwas* als Cloud gilt — auch ein Zustand, in dem alles als Cloud gilt und der lokale Pfad kaputt ist, würde ihn grün machen.

- [ ] **Step 6: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/routing-guard-wiring.test.ts`
Expected: FAIL — `ollama` und `infomaniak` sind beide nicht im hartcodierten Set, also kommt für beide `'ok'` zurück und der erste Test scheitert.

- [ ] **Step 7: `isCloudProvider` in `request-guard-deps.ts` umstellen**

`CLOUD_PROVIDERS` (Zeile 18) entfernen. `isCloudProvider: (provider) => residencyIsCloud(getProviderRegistry().get(provider)?.origin.residency)`. `getProviderRegistry` ist in dieser Datei bereits importiert (Zeile 12).

- [ ] **Step 8: Beide Läufe grün, Typecheck einzeln**

Run: `npx vitest run tests/unit/provider-types.test.ts tests/unit/routing-guard-wiring.test.ts`
Expected: PASS
Run: `npx tsc --noEmit > /tmp/tc1.log 2>&1; echo $?` dann `npx tsc -p tsconfig.main.json --noEmit > /tmp/tc2.log 2>&1; echo $?`
Expected: beide `0`. Einzeln, weil `npm run typecheck` die beiden mit `&&` verkettet und ein Fehler im zweiten Lauf hinter dem ersten verschwindet.

- [ ] **Step 9: Volle Suite — Regressionsprüfung**

Run: `npx vitest run > /tmp/suite.log 2>&1; echo $?`
Expected: `0`. Das Log lesen, nicht die Zusammenfassung: eine Datei, die nicht importiert, erscheint als `PASS`. Erwartet wird besondere Aufmerksamkeit bei `request-guard.test.ts` und allem, was `getGuardDeps` benutzt — dort hingen Tests möglicherweise an der alten Drei-Namen-Liste.

- [ ] **Step 10: Commit**

```bash
git add src/shared/provider-types.ts src/main/security/request-guard-deps.ts tests/unit/provider-types.test.ts tests/unit/routing-guard-wiring.test.ts
git commit -m "feat(security): derive cloud classification from registry residency"
```

- [ ] **Step 11: PR öffnen und Verhaltensänderung benennen**

Die PR-Beschreibung sagt ausdrücklich: Nutzer, die über Infomaniak oder einen selbst registrierten Endpunkt chatten, bekommen ab jetzt Sensitivdaten-Dialoge. Das ist die Absicht, nicht ein Nebeneffekt.

---

# PR 2 — Phase 1

Reihenfolge ist bindend in einem Punkt: **Task 4 (Guard im Loop) ist fertig, bevor Task 10 (`edit_file`) beginnt.** Der Spec lässt die Reihenfolge sonst frei.

### Task 2: Coding-Vokabular und generisches `atLeast`

**Files:**
- Create: `src/shared/coding-types.ts`
- Create: `src/main/coding/coding-mode-store.ts`
- Modify: `src/main/policy/policy-types.ts:21` (`atLeast` generisch), `src/main/policy/policy-engine.ts:49` (Aufrufer)
- Test: `tests/unit/coding-types.test.ts`, `tests/unit/policy-types.test.ts` (Aufrufe anpassen)

**Interfaces:**
- Produces:
  ```ts
  // src/shared/coding-types.ts
  export type CodingMode = 'off' | 'read-only' | 'propose' | 'propose-run'
  export const CODING_MODE_ORDER: Record<CodingMode, number>   // off 0, read-only 1, propose 2, propose-run 3
  export function parseCodingMode(raw: unknown): CodingMode     // alles Unbekannte -> 'off'
  /** Was ein Coding-Run ueber sein Projekt weiss. Liegt in src/shared/, weil
   *  agent-executor, tool-registry UND der Renderer den Typ brauchen — in
   *  agent-executor waere er ein Zyklus, denn agent-executor importiert aus
   *  tool-registry. */
  export interface CodingRunOptions { directoryId: string; projectPath: string; mode: CodingMode }
  ```
  ```ts
  // src/main/policy/policy-types.ts — eine Funktion, zwei Skalen
  export function atLeast<T extends string>(order: Record<T, number>, level: T, threshold: T): boolean
  ```
  ```ts
  // src/main/coding/coding-mode-store.ts
  export interface CodingModeStore {
    getMode(directoryId: string): CodingMode   // 'off' bei unbekannt oder unlesbar
    setMode(directoryId: string, mode: CodingMode): void
  }
  export function getCodingModeStore(): CodingModeStore
  ```
  Ablage und Dateiformat des Stores sind dem Umsetzer überlassen (`file-access.json` ist das Vorbild). Nur das Interface ist festgelegt, weil Task 7, 9, 10, 12 und 13 darauf zugreifen.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/coding-types.test.ts
it('an unknown mode value falls to off', () => {
  for (const raw of ['auto', 'AUTO', 'Off', '', null, undefined, 3, {}, ['propose']]) {
    expect(parseCodingMode(raw)).toBe('off')
  }
})
it('the four known modes parse to themselves', () => {
  for (const m of ['off', 'read-only', 'propose', 'propose-run'] as const) {
    expect(parseCodingMode(m)).toBe(m)
  }
})
it('atLeast orders coding modes', () => {
  expect(atLeast(CODING_MODE_ORDER, 'propose', 'read-only')).toBe(true)
  expect(atLeast(CODING_MODE_ORDER, 'read-only', 'propose')).toBe(false)
})
it('atLeast still orders PII sensitivity', () => {
  expect(atLeast(SENSITIVITY_ORDER, 'critical', 'high')).toBe(true)
  expect(atLeast(SENSITIVITY_ORDER, 'medium', 'high')).toBe(false)
})
```

`'auto'` steht absichtlich in der Liste: es ist der Modus, den Phase 1 nicht hat, und ein Konfigurationswert, den jemand nach Phase 2 hinterlassen könnte.

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-types.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `src/shared/coding-types.ts` implementieren**

`parseCodingMode` prüft `typeof raw === 'string' && raw in CODING_MODE_ORDER`. Kein `as CodingMode` auf ungeprüften Eingaben — genau dieser Cast war der `policy-engine`-Fail-open.

- [ ] **Step 4: `atLeast` generisch machen und den einen Produktionsaufrufer anpassen**

Signatur: `atLeast<T extends string>(order: Record<T, number>, level: T, threshold: T)`. Produktionsaufrufer ist ausschliesslich `policy-engine.ts:49` (geprüft) — dort `atLeast(SENSITIVITY_ORDER, classification.level, candidate.minSensitivity)`. `maxSensitivity` bleibt unverändert. Die vier Aufrufe in `tests/unit/policy-types.test.ts` mitziehen.

- [ ] **Step 5: `coding-mode-store.ts` implementieren**

`getMode` leitet jeden gelesenen Wert durch `parseCodingMode`, auch den aus dem eigenen Store — ein Wert, der auf der Platte liegt, ist eine Eingabe.

- [ ] **Step 6: Läufe grün**

Run: `npx vitest run tests/unit/coding-types.test.ts tests/unit/policy-types.test.ts tests/unit/policy-engine.test.ts tests/unit/policy-invariants.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/coding-types.ts src/main/coding/coding-mode-store.ts src/main/policy/policy-types.ts src/main/policy/policy-engine.ts tests/unit/coding-types.test.ts tests/unit/policy-types.test.ts
git commit -m "feat(coding): add graded coding-mode vocabulary, generalize atLeast over an order table"
```

---

### Task 3: Berechtigung `edit` und was das Laden überlebt

Der sicherheitskritischste Task des Plans. Er läuft ohne jede Coding-Abhängigkeit und kann einzeln beurteilt werden.

**Files:**
- Modify: `src/shared/file-access-types.ts:12` (`FileAccessPermission`), `:63` (`isPersistedGrantTrusted` → `survivingPermissions`)
- Modify: `src/main/file-access/file-access-manager.ts:20` (Import), `:85-96` (`loadAllowedDirectories`)
- Test: `tests/unit/file-access-types.test.ts`, `tests/unit/file-access-manager.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FileAccessPermission = 'read' | 'create' | 'read-create' | 'edit'
  /** Welche Berechtigungen eines gespeicherten Grants nach einem Neustart
   *  vertraut werden dürfen. Ersetzt isPersistedGrantTrusted: die Frage ist
   *  nicht mehr, OB der Eintrag vertraut wird, sondern WELCHE Teile. */
  export function survivingPermissions(dir: AllowedDirectory): FileAccessPermission[]
  export function hasPermission(dir: AllowedDirectory, needed: 'read' | 'create' | 'edit'): boolean
  ```

Regeln, abschliessend:
- Netz-Grant ohne brauchbaren `confirmedAt` → `[]`. Das ist das heutige Verhalten (Eintrag wird fallen gelassen und geparkt) und darf sich nicht ändern.
- Jeder Grant ohne brauchbaren `confirmedAt` → `edit` fällt weg, `read`/`create`/`read-create` bleiben. Für lokale Grants ist das die Änderung: sie laufen heute über `if (dir.location === 'local') return true` an der Marker-Prüfung vorbei.
- Mit brauchbarem Marker → `dir.permissions` unverändert.
- `hasPermission(dir, 'read')` ist wahr bei `'read'` **oder** `'read-create'`; `'create'` analog. `'edit'` wird von nichts impliziert.

`isPersistedGrantTrusted` hat genau **einen** Produktionsaufrufer (`file-access-manager.ts:87`, mit `rtk proxy`-grep über `src/` und `tests/` geprüft). Der Spec rechnete mit mehr; der Umbau ist kleiner als dort befürchtet.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/file-access-types.test.ts
it('a local grant without the marker keeps read and create but loses edit', () => {
  const dir = { ...localDir, permissions: ['read', 'create', 'edit'], confirmedAt: undefined }
  expect(survivingPermissions(dir)).toEqual(['read', 'create'])
})
it('a local grant with the marker keeps edit', () => {
  const dir = { ...localDir, permissions: ['read', 'edit'], confirmedAt: Date.now() }
  expect(survivingPermissions(dir)).toEqual(['read', 'edit'])
})
it('a network grant without the marker survives with nothing', () => {
  expect(survivingPermissions({ ...networkDir, confirmedAt: undefined })).toEqual([])
})
it('an unusable marker is treated as absent', () => {
  for (const bad of [0, -1, NaN, Infinity, '1700000000000' as unknown as number]) {
    expect(survivingPermissions({ ...localDir, permissions: ['edit'], confirmedAt: bad })).toEqual([])
  }
})
it('read-create implies read and create but never edit', () => {
  const dir = { ...localDir, permissions: ['read-create'] }
  expect(hasPermission(dir, 'read')).toBe(true)
  expect(hasPermission(dir, 'create')).toBe(true)
  expect(hasPermission(dir, 'edit')).toBe(false)
})
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/file-access-types.test.ts`
Expected: FAIL — `survivingPermissions is not a function`

- [ ] **Step 3: `survivingPermissions` und `hasPermission` implementieren, `isPersistedGrantTrusted` entfernen**

Die Marker-Prüfung (`typeof === 'number' && Number.isFinite && > 0`) bleibt wörtlich, sie ist bewährt. Der erklärende Kommentar von `isPersistedGrantTrusted` zieht mit um und bekommt einen Satz dazu, warum `edit` den Marker auch lokal braucht.

- [ ] **Step 4: Lauf grün, dann `loadAllowedDirectories` umstellen**

Run: `npx vitest run tests/unit/file-access-types.test.ts` → PASS

Danach in `file-access-manager.ts`: pro Eintrag `survivingPermissions(dir)` bilden. Leer → parken wie heute. Kürzer als `dir.permissions` → mit gekürzter Liste in `allowedDirs`, eine Warnung mit Pfad und entfallener Berechtigung, und `saveAllowedDirectories()`, damit die Kürzung einmal passiert und nicht bei jedem Start neu. Unverändert → wie heute.

- [ ] **Step 5: Manager-Test schreiben, der vorher rot ist**

```ts
// tests/unit/file-access-manager.test.ts
it('keeps a marker-less local grant on the allowlist without edit', () => { /* store vorbelegen, Manager bauen, getAllowedDirectories prüfen */ })
it('still parks a marker-less network grant entirely', () => { /* Regression auf PR #37 */ })
it('persists the reduced permission list so the drop happens once', () => { /* zweites Laden: keine weitere Warnung, store schon gekürzt */ })
```

- [ ] **Step 6: Lauf fehlschlagen, implementieren, grün**

Run: `npx vitest run tests/unit/file-access-manager.test.ts`
Expected: zuerst FAIL beim ersten und dritten Test, dann PASS (alle)

- [ ] **Step 7: Commit**

```bash
git add src/shared/file-access-types.ts src/main/file-access/file-access-manager.ts tests/unit/file-access-types.test.ts tests/unit/file-access-manager.test.ts
git commit -m "feat(file-access): add edit permission, require the confirmation marker for it"
```

---

### Task 4: Der Guard im Loop

Der Kern des Features. Nach diesem Task ist der Nachweis erbracht, **bevor** es ein schreibendes Werkzeug gibt.

**Files:**
- Create: `src/main/agent/loop-guard.ts`
- Modify: `src/main/agent/agent-executor.ts` — Signatur `execute` (Zeile 127), Guard-Aufruf nach Zeile 264 und **vor** 268, `postflightGuard` nach Zeile 235
- Test: `tests/unit/loop-guard.test.ts` (neu), `tests/unit/agent-loop-guard.test.ts` (neu)

**Interfaces:**
- Consumes: `guardInput`, `guardDispatch`, `postflightGuard`, `GuardDeps`, `SensitiveScan` aus `src/main/security/request-guard.ts`; `AgentToolResult` aus `src/shared/types.ts`; `CodingRunOptions` aus `src/shared/coding-types.ts` (Task 2).
- Produces:
  ```ts
  // src/main/agent/loop-guard.ts
  export interface ToolResultOrigin { toolName: string; filePath?: string }
  export type LoopGuardOutcome =
    | { kind: 'ok' }
    | { kind: 'blocked'; reason: string }
    | { kind: 'consent'; index: number; origin: ToolResultOrigin; scanResult: SensitiveScan; request: unknown }
  export async function guardToolResults(
    results: readonly AgentToolResult[],
    origins: readonly ToolResultOrigin[],
    ctx: { provider: string; model: string; conversationId?: string },
    deps: GuardDeps
  ): Promise<LoopGuardOutcome>
  ```
  ```ts
  // src/main/agent/agent-executor.ts — additive 6. Parameter.
  // CodingRunOptions kommt aus src/shared/coding-types.ts (Task 2), NICHT von hier:
  // tool-registry braucht den Typ auch, und agent-executor importiert aus
  // tool-registry — die Gegenrichtung waere ein Zyklus.
  async execute(task: string, provider: string, model: string,
                conversationHistory?: Message[], systemPrompt?: string,
                coding?: CodingRunOptions): Promise<AgentRun>
  ```
  `coding` ist optional, damit die drei heutigen Aufrufer (`agent-handlers.ts:49`, `subagent-orchestrator.ts:381`, `agent-comparison-service.ts:214`) unverändert bleiben. Dass Vergleich und Subagent-Modus damit **kein** Coding bekommen, ist die Sperre aus Entscheid 1 — sie entsteht durch Weglassen, deshalb wird sie unten mit einem Test festgenagelt.
- Produces für Task 5: die `consent`-Variante von `LoopGuardOutcome`.

Verhalten, abschliessend:
- **Ein `guardInput`-Aufruf pro Ergebnis**, mit `texts: [results[i].content]`. `guardInput` sanitisiert nur `texts[texts.length - 1]` (`request-guard.ts:53`) — ein Array aus drei Ergebnissen liesse zwei davon ungeprüft auf Injection, und Injection in einer Datei, die der Agent selbst gelesen hat, ist die zentrale Coding-Bedrohung.
- **Vor** `compactToolResult`. Die Kompaktierung ersetzt grosse Ergebnisse durch eine Referenz plus `result.content.substring(0, 200)` — roh. Danach zu prüfen heisst, den Teil zu prüfen, der nicht mehr mitgeht, und den durchzulassen, der bleibt.
- Danach **ein** `guardDispatch`-Aufruf auf dem verbundenen neuen Inhalt plus Progress-Recitation. Liefert er einen **anderen** Provider zurück → `blocked`, nicht wechseln.

  **Verschärft am 2026-11-19, nach einem Befund der automatischen Sicherheitsprüfung.** Die ursprüngliche Fassung sperrte den Wechsel nur, wenn `coding` gesetzt war. Das war falsch: `guardInput` bewertet den Sensitivdaten-Scan und die Zustimmung gegen den Provider **vor** dem Dispatch. Ein Run auf einem lokalen Anbieter überspringt den Zweig vollständig (`isCloudProvider` false), Tool-Ergebnisse sammeln sich ungeprüft an, und ein Budget-Fallback auf einen Cloud-Anbieter schickt den ganzen Stapel. Abschnitt 6.1 des Spec führt genau dieses Argument — der Satz, der es auf den Coding-Modus einschränkt, ist damit überholt. **Kosten:** ein Run, dessen Provider-Budget mitten im Lauf erschöpft ist, endet mit Grund statt auf einen Ersatzanbieter zu fallen.
- `postflightGuard(llmResponse.text, systemPrompt ?? '', deps)` nach jedem LLM-Aufruf; `ok === false` → Run endet.
- Jedes `blocked` setzt `run.status = 'failed'` und `run.error` auf den Grund, wie der heutige Preflight (Zeile 169-175).

- [ ] **Step 1: Unit-Tests für `guardToolResults` schreiben**

```ts
// tests/unit/loop-guard.test.ts
it('calls guardInput once per tool result', async () => { /* 3 Ergebnisse -> sanitize 3x aufgerufen */ })
it('blocks on injection in the FIRST of several results', async () => {
  const out = await guardToolResults([injected, harmless], origins, ctx, deps)
  expect(out.kind).toBe('blocked')
})
it('reports which result carried the finding', async () => {
  const out = await guardToolResults([harmless, sensitive], [{toolName:'read_file',filePath:'a.ts'},{toolName:'read_file',filePath:'.config'}], ctx, deps)
  expect(out.kind === 'consent' && out.origin.filePath).toBe('.config')
})
it('blocks instead of switching provider when coding is active', async () => { /* checkRouting liefert suggestedProvider */ })
it('positive control: harmless results pass', async () => {
  expect((await guardToolResults([harmless, harmless], origins, ctx, deps)).kind).toBe('ok')
})
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/loop-guard.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `loop-guard.ts` implementieren**

Keine neue Guard-Logik: `guardInput` je Ergebnis, `guardDispatch` einmal. Reine Orchestrierung, Abhängigkeiten als `GuardDeps` injiziert — damit bleibt die Datei ohne Electron-Modulgraph testbar, wie `request-guard.ts`.

- [ ] **Step 4: Lauf grün**

Run: `npx vitest run tests/unit/loop-guard.test.ts`
Expected: PASS (5 Tests)

- [ ] **Step 5: Die Loop-Tests schreiben — der Nachweis des Features**

Eigene Datei, nicht `agent-executor.test.ts` erweitern: dort setzt ein `vi.mock` `isCloudProvider: () => false` und `scanSensitive` auf "nichts gefunden" (Zeile 15-25), damit die Logiktests nicht am Guard hängen. Dieser Mock ist richtig für seinen Zweck und soll bleiben.

```ts
// tests/unit/agent-loop-guard.test.ts
it('a credential in a tool result never reaches the second LLM call', async () => {
  // LLM-Antwort 1: tool_call; Tool-Ergebnis: 'API_KEY=sk-live-abc123'
  // deps: isCloudProvider true, scanSensitive findet credential, checkUploadPermission denied
  const run = await executor.execute('t', 'anthropic', 'm', [], undefined, codingOptions)
  expect(run.status).toBe('failed')
  expect(sendMessageWithTools).toHaveBeenCalledTimes(1)
})
it('positive control: a harmless tool result lets the run continue', async () => {
  const run = await executor.execute('t', 'anthropic', 'm', [], undefined, codingOptions)
  expect(run.status).toBe('completed')
  expect(sendMessageWithTools).toHaveBeenCalledTimes(2)
})
it('a result above the compaction threshold is scanned before compaction', async () => {
  // Ergebnis: 'API_KEY=sk-live-abc123' + 'x'.repeat(5000), Schwelle ist 2000
  // scanSensitive-Spy: sieht den vollen Inhalt, nicht die 200-Zeichen-Vorschau
  expect(scanSensitive).toHaveBeenCalledWith(expect.stringContaining('x'.repeat(3000)))
  expect(run.status).toBe('failed')
})
it('injection in the first of two results of one step blocks the run', async () => { /* Exit-Kriterium 8 */ })
it('a critical output violation ends the run', async () => { /* postflightGuard */ })
it('comparison and subagent runs get no coding options', async () => {
  // execute ohne 6. Parameter: getAvailableTools sieht keinen Coding-Kontext
  // -> Entscheid 1, festgenagelt statt vorausgesetzt
})
```

Die Positivkontrolle und die Vergleichs-Sperre gehören in denselben Lauf. Ein Test, der nur "blockiert" zeigt, ist auch grün, wenn alles blockiert.

- [ ] **Step 6: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/agent-loop-guard.test.ts`
Expected: FAIL — der Run läuft heute durch, `sendMessageWithTools` wird zweimal gerufen. **Das ist der rote Test aus Exit-Kriterium 3.** Die Ausgabe des roten Laufs in die PR-Beschreibung aufnehmen; sie ist der Beleg, dass der Befund echt war.

- [ ] **Step 7: `agent-executor.ts` verdrahten**

`CodingRunOptions` als 6. Parameter. Nach `executeToolCalls` (Zeile 264) `guardToolResults` mit den Werkzeugnamen aus `llmResponse.toolCalls` als Herkunft; erst danach `compactToolResult` (Zeile 268). `postflightGuard` nach Zeile 235. Dateipfad-Herkunft bleibt in diesem Task `undefined` für Nicht-Coding-Werkzeuge; Task 9 füllt sie.

- [ ] **Step 8: Läufe grün, Typecheck einzeln, volle Suite**

Run: `npx vitest run tests/unit/agent-loop-guard.test.ts tests/unit/agent-executor.test.ts tests/unit/subagent-orchestrator.test.ts tests/unit/agent-comparison-service.test.ts`
Expected: PASS
Run: `npx tsc --noEmit > /tmp/tc1.log 2>&1; echo $?` und `npx tsc -p tsconfig.main.json --noEmit > /tmp/tc2.log 2>&1; echo $?`
Expected: beide `0`

- [ ] **Step 9: Commit**

```bash
git add src/main/agent/loop-guard.ts src/main/agent/agent-executor.ts tests/unit/loop-guard.test.ts tests/unit/agent-loop-guard.test.ts
git commit -m "feat(agent): guard every tool result before it reaches the provider"
```

---

### Task 5: Zustimmung mitten im Run

**Files:**
- Create: `src/main/coding/consent-broker.ts`
- Modify: `src/shared/coding-types.ts` (Anfrage- und Antworttypen), `src/shared/types.ts` (`IPC_CHANNELS`), `src/main/ipc/agent-handlers.ts`, `src/main/agent/agent-executor.ts` (Pause), `src/preload/index.ts`
- Test: `tests/unit/consent-broker.test.ts`, `tests/unit/agent-loop-guard.test.ts` (erweitern)

**Interfaces:**
- Consumes: `LoopGuardOutcome` Variante `consent` aus Task 4; `PIIAnonymizer` aus `src/main/privacy/anonymizer.ts:80` (`new PIIAnonymizer(sessionId, mode).anonymize(text): Promise<AnonymizationResult>`).
- Produces:
  ```ts
  // src/shared/coding-types.ts
  export type CodingConsentChoice = 'send' | 'anonymize' | 'drop-file'
  export interface CodingConsentRequest {
    runId: string; stepNumber: number; toolName: string; filePath?: string
    /** Typ und Risikostufe, Wert NICHT enthalten. */
    matches: Array<{ type: string; riskLevel: string }>
    /** 'anonymize' nur, wenn jede Fundstelle anonymisierbar ist. */
    offers: readonly CodingConsentChoice[]
  }
  // src/main/coding/consent-broker.ts
  export interface ConsentBroker { ask(req: CodingConsentRequest): Promise<CodingConsentChoice> }
  export function getConsentBroker(): ConsentBroker
  ```
  Kanäle: `CODING_CONSENT_REQUEST: 'coding:consent-request'`, `CODING_CONSENT_RESPOND: 'coding:consent-respond'`.
- Produces für Task 14: `CodingConsentRequest` und die beiden Kanäle.

Zwei Entscheide, die der Spec offen liess und die hier fallen müssen:

**Der Run-Timeout wird während der Pause angehalten** (`clearTimeout` vor `ask`, danach mit der Restzeit neu gesetzt). Der Spec empfiehlt es; die Alternative lässt Runs an der Bedenkzeit des Nutzers sterben, und ein Dialog, der den Run tötet, erzieht zum blinden Klicken.

**`anonymize` wird nur angeboten, wenn es trägt.** Der Fund kommt vom `SensitiveDataDetector`, der auch Zugangsdaten findet; der `PIIAnonymizer` ersetzt PII. Ein `API_KEY=` würde eine Anonymisierung unverändert überleben, und der Nutzer hätte "anonymisiert senden" geklickt und den Schlüssel verschickt. Deshalb: `offers` enthält `'anonymize'` nur, wenn jede Fundstelle einer Kategorie angehört, die der Anonymizer ersetzt — und nach der Anonymisierung wird **erneut gescannt**. Findet der zweite Scan noch etwas, gilt die Wahl als `drop-file`, mit einer Notiz an den Agenten. Im Zweifel die strengere Seite.

`drop-file` ersetzt den Inhalt des betroffenen Ergebnisses durch eine kurze Notiz (`[Content withheld by user: <toolName> <filePath>]`) und der Run läuft weiter. Das ist der häufigste sinnvolle Fall beim Coding und heute unmöglich — ein Run kann nur sterben oder alles schicken.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/consent-broker.test.ts
it('offers anonymize only when every match is anonymizable', () => { /* credential -> offers ohne 'anonymize' */ })
it('falls back to drop-file when a re-scan still finds the match after anonymizing', async () => { /* strengere Seite */ })
it('never puts a match value into the request', () => {
  expect(JSON.stringify(req)).not.toContain('sk-live-abc123')
})
```
```ts
// tests/unit/agent-loop-guard.test.ts — ergänzen
it('drop-file withholds the file and continues the run', async () => {
  expect(run.status).toBe('completed')
  expect(secondCallMessages.some(m => m.content.includes('sk-live'))).toBe(false)
  expect(secondCallMessages.some(m => m.content.includes('Content withheld'))).toBe(true)
})
it('the run timeout does not elapse while a consent dialog is open', async () => { /* vi.useFakeTimers, ask haelt 10x runTimeoutMs */ })
```

Der dritte Test ist der wichtigste: eine Anfrage, die den Fundwert mitschickt, hat die Schutzschicht an der Oberfläche wieder aufgemacht.

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/consent-broker.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `consent-broker.ts` implementieren**

Ausstehende Anfragen in einer `Map<runId, (choice) => void>`. `ask` schickt über `IPC_CHANNELS.CODING_CONSENT_REQUEST` an das Fenster und gibt ein Promise zurück, das der `CODING_CONSENT_RESPOND`-Handler auflöst. Wird der Run abgebrochen, während eine Anfrage offen ist, löst sie zu `'drop-file'` auf — nicht hängen bleiben, und nicht `'send'`.

- [ ] **Step 4: Kanäle, Preload und Handler ergänzen; Executor pausieren lassen**

- [ ] **Step 5: Läufe grün**

Run: `npx vitest run tests/unit/consent-broker.test.ts tests/unit/agent-loop-guard.test.ts tests/unit/renderer-process-boundary.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/coding/consent-broker.ts src/shared/coding-types.ts src/shared/types.ts src/main/ipc/agent-handlers.ts src/main/agent/agent-executor.ts src/preload/index.ts tests/unit/consent-broker.test.ts tests/unit/agent-loop-guard.test.ts
git commit -m "feat(coding): ask for consent mid-run, with withholding a single file as a third option"
```

---

### Task 6: `.mingly/` — der Arbeitsbereich im Projekt

**Files:**
- Create: `src/main/coding/project-workspace.ts`
- Modify: `src/main/agent/agent-context-manager.ts:35` (`tempDir` konfigurierbar pro Run), `:51` (`compactToolResult`)
- Test: `tests/unit/project-workspace.test.ts`, `tests/unit/context-engineering.test.ts` (erweitern)

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectWorkspace {
    root: string          // <projekt>/.mingly
    snapshotDir: string   // <projekt>/.mingly/snapshots/<runId>
    contextDir: string    // <projekt>/.mingly/context/<runId>
  }
  export class ProjectWorkspaceError extends Error {}
  export async function ensureProjectWorkspace(projectPath: string, runId: string): Promise<ProjectWorkspace>
  ```
- Produces für Task 9: `.mingly/` ist für `list_files` ausgeblendet, für `read_file` erreichbar.
- Produces für Task 11: `snapshotDir`.

Warum im Projekt und nicht in `/tmp`: für die regulierte Zielgruppe darf Projekt-Quelltext die Projektgrenze nicht verlassen, und das gilt für Sicherungskopien wie für ausgelagerte Tool-Ergebnisse. Der Nebeneffekt löst einen Widerspruch: die Kompaktierung weist das Modell an, die ausgelagerte Datei mit `read_file` zu lesen, während `read_file` auf den Grant beschränkt ist. In `.mingly/context/` liegt sie innerhalb des Grants.

`ensureProjectWorkspace` wirft `ProjectWorkspaceError`, wenn `.mingly` als Nicht-Verzeichnis existiert oder nicht beschreibbar ist — **bevor** irgendetwas geschrieben wird. Ein `.gitignore`-Eintrag wird ergänzt, wenn eine `.gitignore` existiert und der Eintrag fehlt; eine `.gitignore` wird **nicht** angelegt, weil das Verzeichnis auch ohne Repo funktionieren muss.

Hinweis an den Umsetzer: `fs.mkdir(dir, { recursive: true, mode })` setzt den Modus auf einem **bestehenden** Verzeichnis nicht — ein Test mit frischem `tmpdir` prüft immer den anderen Zweig. Wenn Rechte zugesichert werden, dann mit explizitem `chmod` und einem Test gegen ein vorhandenes Verzeichnis.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/project-workspace.test.ts
it('creates snapshot and context directories under the project', async () => { /* beide Pfade beginnen mit projectPath */ })
it('throws before writing when .mingly exists as a file', async () => {
  await expect(ensureProjectWorkspace(p, 'r1')).rejects.toThrow(ProjectWorkspaceError)
})
it('throws when the project directory is not writable', async () => { /* chmod 0o500 */ })
it('adds .mingly/ to an existing .gitignore exactly once', async () => { /* zweimal aufrufen, einmal im File */ })
it('never creates a .gitignore', async () => { /* kein Repo -> keine .gitignore */ })
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/project-workspace.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `project-workspace.ts` implementieren**

- [ ] **Step 4: Kompaktierung umlenken**

`compactToolResult(runId, result)` bekommt ein optionales Ziel: `compactToolResult(runId: string, result: AgentToolResult, targetDir?: string)`. Ohne `targetDir` bleibt alles wie heute (`os.tmpdir()/mingly-agent`), damit Vergleich und Subagenten unverändert laufen. Der Coding-Pfad übergibt `workspace.contextDir`.

- [ ] **Step 5: Test für die Umlenkung**

```ts
// tests/unit/context-engineering.test.ts — ergänzen
it('writes externalized results into the project when a target dir is given', () => { /* Pfad liegt unter projectPath */ })
it('still uses the temp dir when no target is given', () => { /* Regression */ })
```

- [ ] **Step 6: Läufe grün**

Run: `npx vitest run tests/unit/project-workspace.test.ts tests/unit/context-engineering.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/coding/project-workspace.ts src/main/agent/agent-context-manager.ts tests/unit/project-workspace.test.ts tests/unit/context-engineering.test.ts
git commit -m "feat(coding): keep snapshots and externalized results inside the project"
```

---

### Task 7: Werkzeuge kontextabhängig freischalten

**Files:**
- Modify: `src/main/agent/tool-registry.ts` — `registerBuiltIn` (Zeile 70), `getAvailableTools` (105), `executeToolCalls` (185), `executeToolInner` (206)
- Modify: `src/main/agent/agent-executor.ts:195`, `:264` (Kontext durchreichen)
- Modify: `src/main/agent/agent-executor.ts` — **Pflicht, nicht optional:** ein Coding-Run
  ruft `ensureProjectWorkspace(coding.projectPath, runId)` **einmal** am Runbeginn und gibt
  `workspace.contextDir` als drittes Argument an `compactToolResult` (heute Zeile 431, ohne
  Ziel). Ohne das bleibt die Auslagerung in `os.tmpdir()`, und damit verlaesst
  Projekt-Quelltext die Projektgrenze — die Eigenschaft, fuer die Task 6 ueberhaupt
  existiert. Ausserdem weist der Kompaktierungstext das Modell an, die ausgelagerte Datei
  mit `read_file` zu lesen; das geht nur innerhalb des Grants, also nur unter `.mingly/`.
  Der Plan behauptete diese Durchreichung in Task 6 («Der Coding-Pfad uebergibt
  `workspace.contextDir`»), wies sie aber keinem Task zu. Entscheid R30.
  **Eine Instanz pro Run**, die Tasks 9 und 11 verbrauchen dieselbe — nicht jeder sein eigenes.
- Test: `tests/unit/tool-registry.test.ts`

**Interfaces:**
- Consumes: `CodingMode`, `CODING_MODE_ORDER`, `atLeast` aus Task 2.
- Produces:
  ```ts
  /** `coding` ist genau der `CodingRunOptions`-Typ aus Task 4 — nicht eine zweite
   *  Struktur mit denselben Feldern, sonst driften die beiden auseinander. */
  export interface ToolContext { coding?: CodingRunOptions }
  export type ToolGate = (ctx: ToolContext | undefined) => boolean
  registerBuiltIn(definition: ToolDefinition, handler: BuiltInToolHandler, gate?: ToolGate): void
  getAvailableTools(ctx?: ToolContext): ToolDefinition[]
  executeToolCalls(toolCalls: AgentToolCall[], ctx?: ToolContext): Promise<AgentToolResult[]>
  ```
- Produces für Task 9, 10, 12: `ToolContext` wird an jeden Coding-Handler als zweites Argument gegeben: `BuiltInToolHandler = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>`.

Ein Test muss belegen, dass die ausgelagerte Datei eines Coding-Runs **unter dem
Projektpfad** liegt, nicht unter `os.tmpdir()` — und dass ein Nicht-Coding-Run (Vergleich,
Subagent) unveraendert im Temp-Verzeichnis bleibt. Ein Test, der nur `ensureProjectWorkspace`
oder nur `compactToolResult` einzeln prueft, bleibt gruen, waehrend die Verdrahtung fehlt.

Ein Werkzeug, dessen Gate `false` sagt, wird **gar nicht angeboten** — nicht angeboten und dann verweigert. Ein angebotenes und verweigertes Werkzeug lehrt das Modell, es trotzdem zu versuchen, und füllt den Kontext mit Fehlern.

Zusätzlich prüft `executeToolInner` das Gate **erneut**, bevor es den Handler ruft, und gibt bei `false` ein Fehlerergebnis zurück. Doppelt, weil ein Modell einen Werkzeugnamen auch nennen kann, den es nie gesehen hat, und weil `getAvailableTools` und `executeToolCalls` verschiedene Aufrufer haben.

Ohne `ctx` ist `ctx?.coding` `undefined` → jedes Coding-Gate ist `false`. Damit sind Vergleich und Subagent-Modus gesperrt, ohne dass dort etwas geändert wird (Entscheid 1). `subagent-orchestrator.ts:121` ruft `getAvailableTools()` ohne Argument und bleibt unverändert.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/tool-registry.test.ts
it('withholds a gated tool when no context is given', () => {
  registry.registerBuiltIn(def, handler, (ctx) => atLeast(CODING_MODE_ORDER, ctx?.coding?.mode ?? 'off', 'propose'))
  expect(registry.getAvailableTools().map(t => t.name)).not.toContain('edit_file')
})
it('offers a gated tool when the mode reaches its threshold', () => { /* mode 'propose' */ })
it('withholds it again one step below', () => { /* mode 'read-only' */ })
it('refuses execution of a gated tool even when it was never offered', async () => {
  const [res] = await registry.executeToolCalls([{ id:'1', name:'edit_file', arguments:{} }], undefined)
  expect(res.isError).toBe(true)
})
it('ungated tools are unaffected', () => { expect(names).toContain('echo') })
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/tool-registry.test.ts`
Expected: FAIL — `registerBuiltIn` nimmt kein drittes Argument

- [ ] **Step 3: Registry umstellen**

`BuiltInToolEntry` bekommt `gate?: ToolGate`. Fehlt das Gate, ist das Werkzeug immer verfügbar — `echo` und `decompose_task` bleiben so, wie sie sind.

- [ ] **Step 4: Kontext im Executor bilden und durchreichen**

Aus `CodingRunOptions` (Task 4) einen `ToolContext` bauen und an `getAvailableTools` (Zeile 195) und `executeToolCalls` (264) geben. Der Modus wird **einmal beim Start** aus `getCodingModeStore().getMode(directoryId)` gelesen und gegen den im Aufruf übergebenen geprüft: weicht er ab, endet der Run. Der Renderer darf sich keinen Modus mitgeben, den der Store nicht hergibt.

- [ ] **Step 5: Läufe grün**

Run: `npx vitest run tests/unit/tool-registry.test.ts tests/unit/agent-executor.test.ts tests/unit/subagent-orchestrator.test.ts tests/unit/agent-loop-guard.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/tool-registry.ts src/main/agent/agent-executor.ts tests/unit/tool-registry.test.ts
git commit -m "feat(agent): gate built-in tools on the run context instead of refusing them later"
```

---

### Task 8: Pfad-Politik — Erweiterungsliste und Blockliste

**Files:**
- Create: `src/main/coding/path-policy.ts`
- Test: `tests/unit/coding-path-policy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CODING_BLOCKED_PATTERNS: readonly string[]      // .env*, *.pem, *.key, *.p12, id_rsa*, .git/config, *.sqlite
  export const CODING_READ_EXTENSIONS: readonly string[]       // eigene, groessere Leseliste fuer Coding-Grants
  /** Absolut. Kein Modus, kein Dialog hebt das auf. */
  export function isBlockedPath(relativePath: string): boolean
  export function isReadableExtension(relativePath: string): boolean
  export function isProbablyBinary(head: Buffer): boolean
  ```
- Produces für Task 9, 10, 12.

Die Blockliste gewinnt immer und wird **zuerst** gefragt. Sie ersetzt den Guard nicht — sie ist eine zweite, billige Schicht davor. Wer dem Agenten den Inhalt einer `.env` geben will, kopiert ihn selbst in den Chat; dort greift der normale Chat-Guard samt Zustimmung, und die Entscheidung ist eine Handlung des Nutzers statt ein Klick in einem Dialog, den der Agent ausgelöst hat.

`isProbablyBinary`: ein Nullbyte in den ersten 8000 Bytes. Grob, billig, und für den Fall gedacht, dass eine Endung lügt.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/coding-path-policy.test.ts
it('blocks secrets regardless of depth or mode', () => {
  for (const p of ['.env', '.env.local', 'deep/nested/.env.production', 'certs/server.pem',
                   'a.key', 'x.p12', '.ssh/id_rsa', '.git/config', 'data/app.sqlite']) {
    expect(isBlockedPath(p)).toBe(true)
  }
})
it('does not block ordinary source files', () => {
  for (const p of ['src/index.ts', 'README.md', 'env.example.md', 'keyboard.ts']) {
    expect(isBlockedPath(p)).toBe(false)
  }
})
it('detects a null byte in the head as binary', () => {
  expect(isProbablyBinary(Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBe(true)
  expect(isProbablyBinary(Buffer.from('export const a = 1', 'utf8'))).toBe(false)
})
```

`'keyboard.ts'` steht absichtlich da: eine Substring-Suche nach `*.key` fängt «keyboard» — und ein Guard, der falschen Alarm schlägt, wird abgeschaltet. Die Verhaltensmatrix prüft beide Richtungen: greift er, wo er soll, **und** schweigt er, wo er soll.

**Korrektur am 2026-11-19 (Entscheid R37):** hier stand zuvor `'.env.example.md'` in derselben Liste. Das war ein Fehler in diesem Plan, kein Fehlalarm: `.env.example.md` ist wirklich ein Name aus der `.env`-Familie, und `.env*` steht auf der **absoluten** Blockliste. Der Widerspruch wird fail-closed aufgeloest — `.env*` blockt alles, auch `.env.example.md`. Eine Dokumentationsdatei kann man umbenennen (`env.example.md`, ohne Punkt); ein gelesenes Geheimnis nicht zurueckholen. Der strukturelle Punkt, auf den die Zeile hinauswollte, haengt an `keyboard.ts` und bleibt damit erhalten.

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-path-policy.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `path-policy.ts` implementieren**

Muster gegen die **Pfadsegmente** prüfen, nicht gegen den ganzen String als Teilzeichenfolge.

- [ ] **Step 4: Lauf grün und Commit**

Run: `npx vitest run tests/unit/coding-path-policy.test.ts`
Expected: PASS

```bash
git add src/main/coding/path-policy.ts tests/unit/coding-path-policy.test.ts
git commit -m "feat(coding): add the coding read allowlist and the absolute blocklist"
```

---

### Task 9: `list_files` und `read_file`

**Files:**
- Create: `src/main/coding/read-tools.ts`
- Modify: `src/main/agent/tool-registry.ts` (Registrierung in `registerDefaultBuiltIns`)
- Modify: `src/main/agent/agent-executor.ts:336-338` — **Pflicht, nicht optional:** der
  Executor baut `origins` dort heute nur aus dem Werkzeugnamen, also bleibt
  `ToolResultOrigin.filePath` leer. `originForToolCall` unten wird damit gebaut und nie
  aufgerufen. Der Dialog aus Task 5 und die Notiz `[Content withheld …: <toolName> <filePath>]`
  nennen die Datei sonst nie — der Nutzer entscheidet dann ueber «irgendeine Datei».
  Befund des Task-5-Reviews, Entscheid R27.
- Test: `tests/unit/coding-read-tools.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `ToolGate` (Task 7); `isBlockedPath`, `isReadableExtension`, `isProbablyBinary` (Task 8); `isRealPathWithin(requestedPath, allowedDir): Promise<boolean>` aus `src/main/file-access/real-path-guard.ts:91`; `hasPermission` (Task 3); `ProjectWorkspace` (Task 6).
- **Pflicht, nicht optional (Entscheid R39) — Blockliste ZWEIMAL.** `isBlockedPath` laeuft
  **vor** der Pfadaufloesung (eine Ablehnung verraet dann nichts ueber das Dateisystem)
  **und erneut auf dem aufgeloesten `realpath`**. Ohne den zweiten Lauf ist die Blockliste
  per Symlink zu umgehen: ein Link `src/config.ts -> ../.env` innerhalb des Grants
  besteht die Namenspruefung (er heisst `config.ts`) **und** die Containment-Pruefung
  (das Ziel liegt im Grant) — und liefert den Inhalt der `.env`. Befund 2 des
  Task-8-Berichts, dort korrekt als abgeleitet und nicht gemessen gekennzeichnet. Ein
  Test muss genau diesen Link legen und die Ablehnung belegen.
- **Pflicht, nicht optional (Entscheid R40):** `list_files` wendet `isBlockedPath` auf
  **jeden Eintrag** an. Sonst verraet die Liste selbst, welche geblockten Dateien
  existieren — die Ablehnung beim Lesen kommt dann zu spaet. Befund 4 des
  Task-8-Berichts.
- **Pflicht, nicht optional (Entscheid R33):** `ToolContext` fuehrt den
  `ProjectWorkspace` nicht — Task 7 definiert ihn als `{ coding? }`, und der Executor
  haelt die Instanz nur als lokales `contextDir` in `execute`. Dieser Task **erweitert
  `ToolContext`** um den Arbeitsbereich und laesst den Executor die **eine** Instanz
  hineingeben, die er schon erzeugt. Ein Handler darf **nicht** sein eigenes
  `ensureProjectWorkspace` rufen: zwei Instanzen pro Run heisst doppelte
  Dateisystemarbeit und ein Rennen auf denselben Verzeichnissen. Ein Test muss belegen,
  dass der Handler denselben Pfad sieht, den der Executor angelegt hat.
  **Dritter Vorfall derselben Klasse** (R27, R30, R33): ein «Produces fuer Task N»-Block
  sagt, was gebaut wird, aber nicht, wer es *traegt*. Bei kuenftigen Plaenen gehoert zu
  jedem produzierten Wert die Zeile, wer ihn durchreicht.
- Produces:
  ```ts
  export function registerReadTools(registry: ToolRegistry): void
  /** Herkunft fuer den Guard aus Task 4 — fuellt ToolResultOrigin.filePath. */
  export function originForToolCall(call: AgentToolCall): ToolResultOrigin
  ```
  Werkzeuge: `list_files(pattern?)` und `read_file(path, offset?, limit?)`, beide mit Gate `atLeast(CODING_MODE_ORDER, mode, 'read-only')`.

Jeder Pfad wird **nach** `realpath` geprüft, nicht davor — ein Symlink im Projekt, der nach draussen zeigt, ist sonst ein Ausbruch. `isRealPathWithin` löst beide Seiten auf und verträgt einen nicht existierenden Namen am Ende (`resolveRealPath` hängt die fehlenden Segmente an den tiefsten existierenden Vorfahren).

Reihenfolge der Prüfungen in `read_file`, abschliessend: Grant vorhanden und `hasPermission(dir,'read')` → `isBlockedPath` → `isRealPathWithin` → `isReadableExtension` → Kopf lesen und `isProbablyBinary` → Inhalt. Blockliste vor der Pfadauflösung, damit eine Ablehnung nichts über das Dateisystem verrät.

Ein weiterer Test muss einen **symlinkierten Projektpfad** verwenden (auf macOS ist
`/var` genau das) und belegen, dass eine Datei unter `.mingly/context/` die
Containment-Pruefung von `read_file` passiert. `ensureProjectWorkspace` gibt seine Pfade
per `path.resolve` zurueck, nicht per `realpath` — laeuft der Projektpfad ueber einen
Symlink, koennen aufgeloeste und unaufgeloeste Form auseinanderfallen, und dann weist
`read_file` die eigene Auslagerungsdatei ab, obwohl der Kompaktierungstext dem Modell
sagt, es solle sie lesen. Vom Task-6-Review als «cannot verify from diff» korrekt offen
gelassen und hierher weitergegeben; verwandt mit der Memory-Notiz
`containment-pruefung-bricht-an-der-dateisystemwurzel`.

Ein Test muss belegen, dass ein `read_file`-Ergebnis beim Guard mit **gefuelltem**
`filePath` ankommt — nicht nur, dass `originForToolCall` den Pfad zurueckgibt. Ein Test
gegen die Funktion allein wuerde gruen bleiben, waehrend der Executor sie ignoriert.

`list_files` blendet `.mingly/` aus und respektiert `.gitignore`, wenn eine existiert. Die Ausgabe wird auf eine feste Zahl Einträge begrenzt, mit einer Fusszeile, die die Kürzung **nennt** — eine stille Kürzung macht aus einer unvollständigen Liste eine falsche Aussage.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/coding-read-tools.test.ts
it('reads a file inside the grant', async () => { /* Inhalt kommt zurueck */ })
it('refuses a path outside the grant', async () => { /* ../../etc/passwd */ })
it('refuses a symlink that points outside the grant', async () => {
  // link in <projekt>/out -> /etc, dann read_file('out/passwd')
})
it('refuses a blocklisted file even in read-only mode', async () => { /* .env */ })
it('refuses a binary file whose extension is allowed', async () => {
  // Review Focus 1: ALLOWED_READ_EXTENSIONS enthaelt .png
  const out = await handler({ path: 'logo.png' }, ctx)
  expect(out).toMatch(/binary/i)
  expect(out).not.toContain('\u0000')
})
it('list_files hides .mingly and declares truncation', async () => { /* Fusszeile nennt die Kuerzung */ })
it('list_files skips gitignored paths but still lists them without a .gitignore', async () => {
  // Gegenprobe gegen Fehlalarm: ohne .gitignore darf nichts verschwinden
})
it('the tools are withheld in off mode', () => { /* ueber getAvailableTools */ })
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-read-tools.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `read-tools.ts` implementieren und registrieren**

- [ ] **Step 4: Herkunft an den Guard verdrahten**

`originForToolCall` im Executor benutzen, damit der Zustimmungs-Dialog aus Task 5 sagen kann, **welche** Datei den Fund enthält. Heute steht in `request-guard-deps.ts:30` fest `filePath: '<message-content>'`, weil es im Chat keine Datei gibt; der Coding-Pfad gibt eine echte Herkunft mit.

- [ ] **Step 5: Läufe grün**

Run: `npx vitest run tests/unit/coding-read-tools.test.ts tests/unit/agent-loop-guard.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/coding/read-tools.ts src/main/agent/tool-registry.ts src/main/agent/agent-executor.ts tests/unit/coding-read-tools.test.ts
git commit -m "feat(coding): add list_files and read_file inside the project grant"
```

---

### Task 10: `edit_file` als Vorschlag, nicht als Schreibung

**Files:**
- Create: `src/main/coding/edit-proposals.ts`
- Modify: `src/shared/coding-types.ts`, `src/main/agent/tool-registry.ts`
- Test: `tests/unit/coding-edit-proposals.test.ts`

**Interfaces:**
- Consumes: Task 7, 8, 9.
- Produces:
  ```ts
  // src/shared/coding-types.ts
  export interface ProposedEdit {
    path: string            // relativ zur Projektwurzel
    oldText: string
    newText: string
    diff: string            // unified diff zur Anzeige
    addedLines: number
    removedLines: number
  }
  // src/main/coding/edit-proposals.ts
  export type ProposeOutcome =
    | { kind: 'proposed'; editId: string }
    | { kind: 'rejected'; reason: string }
  export interface EditProposalStore {
    /** `fileContent` wird vom Handler gelesen und hereingegeben, damit der Store
     *  synchron und ohne Dateisystem testbar bleibt. */
    propose(runId: string, stepNumber: number,
            edit: Omit<ProposedEdit,'diff'|'addedLines'|'removedLines'>,
            fileContent: string): ProposeOutcome
    pending(runId: string): ProposedEdit[]
    /** Abnahme oder Ablehnung des ganzen Schritt-Pakets. */
    resolve(runId: string, accepted: boolean, reason?: string): void
  }
  export function getEditProposalStore(): EditProposalStore
  ```
- Produces für Task 11: `pending(runId)` ist die Liste, die geschrieben wird. Für Task 14: `ProposedEdit`.

Das JSON-Schema des Werkzeugs nennt die Felder `path`, `old`, `new` — kurz, weil das Modell sie schreibt. Der Handler bildet sie auf `oldText`/`newText` ab. Die zwei Namenspaare sind Absicht, keine Unachtsamkeit: die Modell-Schnittstelle und der interne Typ dürfen sich getrennt ändern.

`edit_file` schreibt **nicht**. Es legt einen Vorschlag ab und gibt dem Agenten den Diff als Tool-Ergebnis zurück. Gesammelt wird **pro Schritt**, nicht pro Datei: der Agent ändert oft drei Dateien für eine Sache, und der Nutzer nimmt das Paket ab. 40-mal "OK" ist die Klickstrecke, die unter den Anti-Zielen steht.

Ein abgelehnter Vorschlag geht als Tool-Ergebnis **mit Begründung** zurück, damit der Agent daraus lernt statt dasselbe erneut vorzuschlagen.

Prüfungen bei `propose`, abschliessend:
- `oldText` kommt in der Datei **genau einmal** vor. Null- oder mehrmals → `rejected`, und der Grund nennt die Trefferzahl (Review Focus 2).
- Ein zweiter Vorschlag für **denselben Pfad im selben Schritt** → `rejected` (Review Focus 3). `executeToolCalls` führt die Aufrufe eines Schritts parallel aus; der zweite `oldText` wird gegen den Zustand vor der ersten Änderung geprüft, und beide Diffs zusammen sind nicht anwendbar.
- `oldText === newText` → `rejected`. Eine Abnahme ohne Änderung ist ein Klick, der nichts tut.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/coding-edit-proposals.test.ts
it('proposes an edit without touching the file', async () => {
  await handler({ path:'a.ts', old:'const a = 1', new:'const a = 2' }, ctx)
  expect(await readFile(abs, 'utf8')).toContain('const a = 1')   // unveraendert
  expect(store.pending(runId)).toHaveLength(1)
})
it('rejects an old text that occurs twice and says how often', () => {
  const out = store.propose(runId, 1, { path:'a.ts', oldText:'return x', newText:'return y' },
                            'function a(){ return x }\nfunction b(){ return x }')
  expect(out).toEqual({ kind:'rejected', reason: expect.stringContaining('2') })
})
it('rejects an old text that does not occur', () => { /* reason enthaelt '0' */ })
it('rejects a second proposal for the same path in the same step', () => { /* Review Focus 3 */ })
it('rejects a no-op edit', () => { /* oldText === newText */ })
it('returns the rejection reason to the agent as a tool result', async () => {
  expect(await handler(badArgs, ctx)).toMatch(/occurs 2 times/i)
})
it('allows a second proposal for the same path in the NEXT step', () => { /* Gegenprobe gegen Fehlalarm */ })
```

Der letzte Test ist die Gegenprobe: eine Sperre, die auch den erlaubten Fall trifft, ist ein Defekt und kein Schutz.

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-edit-proposals.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `edit-proposals.ts` implementieren und `edit_file` registrieren**

Gate: `atLeast(CODING_MODE_ORDER, mode, 'propose')`. Pfadprüfungen wie in Task 9, zusätzlich `hasPermission(dir,'edit')`. Unified Diff mit dem Werkzeug, das das Projekt schon hat; gibt es keines, eine knappe eigene Darstellung — die genaue Form ist dem Umsetzer überlassen, solange erkennbar ist, welche Datei und wie viele Zeilen.

- [ ] **Step 4: Lauf grün und Commit**

Run: `npx vitest run tests/unit/coding-edit-proposals.test.ts`
Expected: PASS (7 Tests)

```bash
git add src/main/coding/edit-proposals.ts src/shared/coding-types.ts src/main/agent/tool-registry.ts tests/unit/coding-edit-proposals.test.ts
git commit -m "feat(coding): edit_file proposes a diff instead of writing"
```

---

### Task 11: Snapshot, atomare Schreibung, Rückgängig

**Files:**
- Create: `src/main/coding/apply-edits.ts`
- Modify: `src/shared/types.ts` (`IPC_CHANNELS`), `src/main/ipc/agent-handlers.ts`, `src/preload/index.ts`
- Test: `tests/unit/coding-apply-edits.test.ts`

**Interfaces:**
- Consumes: `ProjectWorkspace` (Task 6), `EditProposalStore.pending` (Task 10), `hasPermission` (Task 3), `getCodingModeStore` (Task 2).
- Produces:
  ```ts
  export type ApplyOutcome =
    | { kind: 'applied'; paths: string[] }
    | { kind: 'refused'; reason: string }
  export async function applyPendingEdits(runId: string, ws: ProjectWorkspace, dir: AllowedDirectory): Promise<ApplyOutcome>
  export async function undoRun(runId: string, ws: ProjectWorkspace): Promise<string[]>
  export async function writeFileAtomic(target: string, content: string): Promise<void>
  ```
  Kanäle: `CODING_ACCEPT_EDITS: 'coding:accept-edits'`, `CODING_REJECT_EDITS: 'coding:reject-edits'`, `CODING_UNDO_RUN: 'coding:undo-run'`.
- Produces für Task 14: die drei Kanäle.

**Eine Quelle der Wahrheit:** der `CODING_ACCEPT_EDITS`-Handler ruft `applyPendingEdits` und erst bei `applied` danach `EditProposalStore.resolve(runId, true)`. Der Store führt keine eigene Schreibung aus, und `applyPendingEdits` verwaltet keine Vorschläge. Bei `refused` bleibt der Vorschlag stehen, damit der Nutzer den Grund sieht und der Agent nichts Falsches gelernt bekommt.

Ablauf, abschliessend:
1. **Erneute Prüfung** von Grant und Modus, unmittelbar vor der ersten Schreibung. Zwischen Abnahme und Schreibung liegt beliebig viel Zeit; wurde der Grant entzogen oder der Modus gesenkt, wird `refused` zurückgegeben und nichts geschrieben (Review Focus 5).
2. **Erneute Prüfung des `oldText`** gegen den **aktuellen** Dateiinhalt. `propose` hat gegen den Inhalt zum Vorschlagszeitpunkt geprüft; hat der Nutzer die Datei zwischenzeitlich selbst geändert, trifft die Ersetzung etwas anderes als im abgenommenen Diff. Kommt `oldText` nicht mehr genau einmal vor → `refused`, nichts geschrieben.
3. **Snapshot** aller betroffenen Dateien nach `ws.snapshotDir`, **bevor** die erste überschrieben wird. Scheitert der Snapshot, wird nichts geschrieben.
4. Je Datei `writeFileAtomic`: in eine temporäre Datei **im selben Verzeichnis** schreiben, dann `rename`. `rename` innerhalb eines Dateisystems ist atomar; ein Abbruch lässt die Datei vollständig alt oder vollständig neu (Review Focus 4). Eine temporäre Datei in `/tmp` wäre es nicht, weil `rename` über Dateisystemgrenzen kopiert.
5. `undoRun` stellt aus dem Snapshot wieder her und gibt die wiederhergestellten Pfade zurück. Kein Git nötig — funktioniert auch ohne Repo.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/coding-apply-edits.test.ts
it('snapshots before the first write', async () => { /* Snapshot-Datei enthaelt den alten Inhalt */ })
it('writes nothing when the snapshot fails', async () => { /* snapshotDir nicht beschreibbar */ })
it('refuses when the grant lost edit between acceptance and write', async () => {
  // Review Focus 5
  grantStore.setPermissions(dir.id, ['read'])
  expect((await applyPendingEdits(runId, ws, dir)).kind).toBe('refused')
  expect(await readFile(abs,'utf8')).toBe(original)
})
it('refuses when the mode dropped to off between acceptance and write', async () => { /* Review Focus 5 */ })
it('refuses when the user edited the file between proposal and acceptance', async () => {
  // oldText kommt nicht mehr genau einmal vor -> nichts schreiben
  expect(await readFile(abs,'utf8')).toBe(userEditedContent)
})
it('leaves the file fully old or fully new when the write is interrupted', async () => {
  // Review Focus 4: rename schlaegt fehl -> Original unveraendert, kein Teilinhalt
  expect(await readFile(abs,'utf8')).toBe(original)
})
it('writes the temp file in the target directory, not in /tmp', async () => { /* rename ueber FS-Grenze waere nicht atomar */ })
it('undo restores every file of the run', async () => { /* Exit-Kriterium 9 maschinell */ })
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-apply-edits.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `apply-edits.ts` implementieren**

- [ ] **Step 4: IPC-Kanäle und Preload**

Alle drei mit `requireFeature('agentic_mode')`. `CODING_ACCEPT_EDITS` nimmt die `runId`, nie einen Pfad vom Renderer — was geschrieben wird, bestimmt der Main-Prozess aus `pending(runId)`.

- [ ] **Step 5: Läufe grün**

Run: `npx vitest run tests/unit/coding-apply-edits.test.ts tests/unit/renderer-process-boundary.test.ts`
Expected: PASS (7 Tests)

- [ ] **Step 6: Commit**

```bash
git add src/main/coding/apply-edits.ts src/shared/types.ts src/main/ipc/agent-handlers.ts src/preload/index.ts tests/unit/coding-apply-edits.test.ts
git commit -m "feat(coding): snapshot, write atomically, and undo a whole run"
```

---

### Task 12: `run_command` und die Wahrheit im README

**Pflicht, nicht optional (Entscheid R36):** das README benennt ausdruecklich, dass der
Coding-Modus **Minglys eigene** Werkzeuge abstuft und **nicht** die MCP-Server des
Nutzers — die bleiben in jedem Modus verfuegbar, auch in `read-only`. Dazu beide Haelften
der Wahrheit: die **Ergebnisse** jedes MCP-Werkzeugs laufen durch denselben Guard wie
alles andere (Klassifikation, Residenz, PII, Zustimmung), die **Faehigkeit** eines
Servers mit Schreibzugriff ist davon aber nicht erfasst. Entscheid von Holger am
2026-11-19 (eigene MCP-Server sollen erreichbar bleiben); die Begruendung, warum eine
Abstufung keine belastbare Grundlage hat, steht im Design-Dokument. Ein unausgesprochener
Spalt in einem Modus, der `read-only` heisst, ist ein falsches Versprechen — deshalb
Pflicht und nicht Fussnote.

**Files:**
- Create: `src/main/coding/command-allowlist.ts`, `src/main/coding/run-command.ts`
- Modify: `src/main/agent/tool-registry.ts`, `README.md`
- Test: `tests/unit/coding-command-allowlist.test.ts`

**Interfaces:**
- Consumes: Task 7; `projectPath` aus `CodingRunOptions` (Task 2) — **nicht** `ProjectWorkspace`, das Arbeitsverzeichnis des Befehls ist die Projektwurzel, nicht `.mingly/`.
- Produces:
  ```ts
  export type CommandPlan =
    | { kind: 'run'; file: string; args: string[]; cwd: string }
    | { kind: 'refused'; reason: string }
  /** `npmScripts` kommt aus der package.json des Projekts und wird hereingegeben,
   *  damit die Funktion rein und synchron bleibt. Leer = keine Skripte erlaubt. */
  export function planCommand(
    raw: string,
    projectPath: string,
    interpreterPaths: Readonly<Record<string, string>>,
    npmScripts?: readonly string[]
  ): CommandPlan
  export function registerRunCommand(registry: ToolRegistry): void
  ```

**Ein Widerspruch im Spec, der hier aufgelöst wird.** Abschnitt 6.4 nennt als Start-Allowlist `npm test`, `npm run <script>`, `npx tsc --noEmit`, `pytest`, `git status`, `git diff` — und verlangt im selben Abschnitt, Binärdateien nur aus `<projekt>/node_modules/.bin` zu nehmen. Dort liegen aber die Projekt-Binärdateien (`vitest`, `tsc`, `eslint`), **nicht** `npm`, `npx` oder `git`: die kommen vom System. Vier der sechs Startbefehle wären damit nicht ausführbar.

Aufgelöst in Richtung der Regel, nicht der Liste: **jede** Binärdatei ist entweder in `<projekt>/node_modules/.bin` oder ein in den Einstellungen gesetzter **absoluter Pfad**. `npm`, `npx`, `git` und `pytest` sind damit konfigurierte Interpreter. Damit `propose-run` nicht unbenutzbar ausgeliefert wird, darf Mingly in den Einstellungen Kandidaten **vorschlagen** — einmalig, mit dem absoluten Pfad sichtbar, vom Nutzer bestätigt und dann gespeichert. Zur Laufzeit wird nie in `PATH` gesucht. Eine gepackte Electron-App auf macOS erbt den PATH der Login-Shell ohnehin nicht: ein PATH-basierter Aufruf würde in der Entwicklung funktionieren und im ausgelieferten Build still ins Leere laufen.

Zerlegung: an Weissraum trennen, **jedes** Token mit einem Shell-Metazeichen (`& | ; < > $ \` ( ) { } ' " \n`) führt zu `refused`. `spawn(file, args, { shell: false, cwd: projectPath })`. Der Guard hängt am ausgeführten Argumentvektor, nicht an der Schreibweise des Befehls — ein Guard, der an einer Formulierung hängt, ist vertagt, nicht repariert.

Die Ausgabe läuft durch den Guard wie ein Tool-Ergebnis; das besorgt Task 4, weil `run_command` ein gewöhnliches Werkzeug ist.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/coding-command-allowlist.test.ts
it('plans an allowlisted command with an absolute interpreter path', () => {
  expect(planCommand('npm test', p, { npm: '/usr/local/bin/npm' }))
    .toEqual({ kind:'run', file:'/usr/local/bin/npm', args:['test'], cwd:p })
})
it('resolves a project binary from node_modules/.bin', () => { /* vitest run */ })
it('refuses a command whose interpreter is not configured', () => {
  expect(planCommand('git status', p, {}).kind).toBe('refused')
})
it('never searches PATH', () => {
  // kein Aufruf, dessen file keinen Separator enthaelt
  expect(planCommand('npm test', p, { npm:'/usr/local/bin/npm' })).toMatchObject({ file: expect.stringContaining('/') })
})
it('refuses shell metacharacters in any position', () => {
  for (const c of ['npm test && rm -rf /', 'npm test | tee x', 'npm test; ls',
                   'npm test $(whoami)', 'npm run "a b"', 'npm test\nls']) {
    expect(planCommand(c, p, all).kind).toBe('refused')
  }
})
it('refuses an npm script that is not in package.json', () => { /* Argumentpruefung, nicht nur Praefix */ })
it('accepts an npm script that is in package.json', () => { /* Gegenprobe gegen Fehlalarm */ })
it('the tool is withheld below propose-run', () => { /* mode 'propose' */ })
it('command output passes the guard like any tool result', async () => {
  // run_command ist ein gewoehnliches Werkzeug, also besorgt Task 4 das —
  // nachgewiesen statt vorausgesetzt: Ausgabe mit 'API_KEY=' -> Run endet
})
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-command-allowlist.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `command-allowlist.ts` und `run-command.ts` implementieren, Werkzeug registrieren**

Gate: `atLeast(CODING_MODE_ORDER, mode, 'propose-run')`.

- [ ] **Step 4: README korrigieren — Exit-Kriterium 10**

`README.md:19` bewirbt `web_search`, `read_file`, `write_file` und `execute_command` als "Built-in Tools available to all agents". Nach diesem Task gibt es `list_files`, `read_file`, `edit_file` und `run_command` — **nur im Coding-Modus**, nicht für alle Agenten. `web_search` und `write_file` gibt es nicht. Der Abschnitt wird auf den Stand gebracht, inklusive des Satzes, dass die Coding-Werkzeuge an Modus und Projekt-Grant hängen.

- [ ] **Step 5: Lauf grün und Commit**

Run: `npx vitest run tests/unit/coding-command-allowlist.test.ts tests/unit/tool-registry.test.ts`
Expected: PASS

```bash
git add src/main/coding/command-allowlist.ts src/main/coding/run-command.ts src/main/agent/tool-registry.ts README.md tests/unit/coding-command-allowlist.test.ts
git commit -m "feat(coding): run allowlisted commands by argv, never through a shell"
```

---

### Task 13: Audit, exportierbar

**Files:**
- Create: `src/main/coding/coding-audit.ts`
- Modify: `src/main/coding/apply-edits.ts` (Eintrag je abgenommener Änderung), `src/main/audit/types.ts` (`KnownAction`), `src/shared/types.ts`, `src/main/ipc/agent-handlers.ts`
- Test: `tests/unit/coding-audit.test.ts`

**Interfaces:**
- Consumes: `getActivityLogger().log(entry)` und `query(filter)` aus `src/main/audit/activity-logger.ts`; `ActivityLogEntry` aus `src/main/audit/types.ts`.
- Produces:
  ```ts
  export interface CodingAuditDetails {
    projectPath: string; filePath: string; addedLines: number; removedLines: number
    provider: string; model: string; policyVersion: string
    guardRedirected: boolean; guardBlocked: boolean
  }
  export function logCodingChange(runId: string, details: CodingAuditDetails): void
  export function exportCodingAudit(filter: { since?: string; limit?: number }): string   // CSV
  ```
  Neue `KnownAction`: `'coding.change_applied'`, `'coding.run_undone'`, `'coding.guard_blocked'`.
  Kanal: `CODING_EXPORT_AUDIT: 'coding:export-audit'`.

Das ist der Teil, den die regulierte Zielgruppe ihrem Compliance-Verantwortlichen zeigt. Er wird deshalb **exportierbar** gebaut, nicht nur anzeigbar.

`details` enthält Pfade und Zahlen, **nie Dateiinhalt** und nie einen Fundwert. Ein Audit-Eintrag, der das Geheimnis protokolliert, vor dem er schützen soll, ist das Leck.

- [ ] **Step 1: Die failing tests schreiben**

```ts
// tests/unit/coding-audit.test.ts
it('writes one entry per applied change with provider, model and policy version', () => { /* details pruefen */ })
it('never writes file content into the audit entry', () => {
  logCodingChange(runId, details)
  expect(JSON.stringify(logged)).not.toContain(secretBearingLine)
})
it('records a blocked guard as its own action', () => { /* coding.guard_blocked */ })
it('exports the entries as CSV with a header row', () => { /* Spalten stabil */ })
it('escapes a comma and a quote in a path', () => { /* CSV-Injection-Nachbarschaft */ })
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-audit.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: `coding-audit.ts` implementieren, in `apply-edits.ts` aufrufen, Export-Kanal ergänzen**

- [ ] **Step 4: Lauf grün und Commit**

Run: `npx vitest run tests/unit/coding-audit.test.ts tests/unit/coding-apply-edits.test.ts`
Expected: PASS

```bash
git add src/main/coding/coding-audit.ts src/main/coding/apply-edits.ts src/main/audit/types.ts src/shared/types.ts src/main/ipc/agent-handlers.ts tests/unit/coding-audit.test.ts
git commit -m "feat(coding): write an exportable audit entry per accepted change"
```

---

### Task 14: Der einzelne Coding-Run in der Oberfläche

**Pflicht, nicht optional (Entscheid R35):** `coding.projectPath` wird im **Main-Prozess**
aus dem Grant zu `coding.directoryId` abgeleitet und **niemals** aus dem Renderer
uebernommen. `CodingRunOptions.projectPath` ist heute ein blosser `string` vom Aufrufer,
und der Store prueft nur den Modus, nicht den Pfad. Ein renderer-gelieferter Pfad wuerde
den Arbeitsbereich und spaeter alle Lese- und Schreibpfade auf ein beliebiges Verzeichnis
zeigen lassen — am Grant-System vorbei. Gleiche Klasse wie die Memory-Notiz
`renderer-kann-verzeichnis-allowlist-selbst-erweitern`. Ein Test muss belegen, dass ein
Run mit einem `projectPath`, der nicht zum Grant des `directoryId` passt, **abgelehnt**
wird — nicht korrigiert, abgelehnt. Befund I-3 des Task-7-Reviews.

**Pflicht, nicht optional (Entscheid R36):** die Modus-Beschriftung in der Oberflaeche
sagt, dass die Stufe **Minglys eigene** Werkzeuge betrifft und nicht die MCP-Server des
Nutzers. `read-only` darf nicht als «ohne jedes Risiko» auftreten, solange ein
MCP-Server mit Schreibzugriff in jedem Modus erreichbar ist. Kurz, an der Stufe selbst,
nicht in einem Hilfetext, den niemand oeffnet.

Entscheid 1 zieht dieses Stück Oberfläche in Phase 1. Minimal gehalten: kein Workspace, keine Dateibaum-Ansicht, kein Editor — das ist Phase 2.

**Files:**
- Create: `src/renderer/components/CodingDiffDialog.tsx`, `src/renderer/components/CodingModePicker.tsx`, `src/renderer/stores/coding-store.ts`
- Modify: `src/renderer/components/MessageInput.tsx` (Umschalter), `src/renderer/components/ChatLayout.tsx` (Dialoge einhängen), `src/renderer/components/SensitiveDataConsentDialog.tsx` (dritte Option), `src/renderer/components/FileAccessTab.tsx:57-61` (`getPermissionLabel` kennt `edit` nicht)
- Test: `tests/unit/coding-store.test.ts`

**Interfaces:**
- Consumes: `CodingMode`, `ProposedEdit`, `CodingConsentRequest`, `CodingConsentChoice` aus `src/shared/coding-types.ts`; die Kanäle aus Task 5, 11, 13; `useAgentStore.executeAgent` aus `src/renderer/stores/agent-store.ts:102`.

Was schon da ist und nicht gebaut werden muss, am Code geprüft: der IPC-Handler `AGENT_EXECUTE` (`agent-handlers.ts:29`) mit `requireFeature('agentic_mode')` und Schritt-Weiterleitung, `agent-store.executeAgent` (vollständig implementiert, aber **ohne Aufrufer**), und die Schrittanzeige in `MessageList.tsx:43-45`. Fehlt allein der Auslöser. Entscheid 1 ist damit kleiner als der Spec befürchtete.

Zu bauen:
- **Umschalter** in `MessageInput`: schickt die Eingabe über `executeAgent` statt über den Chat-Pfad, wenn der Coding-Modus über `off` liegt. `ViewMode` in `ChatLayout.tsx:19` wird **nicht** erweitert — der Coding-Run läuft in `'chat'`. Damit bleibt er aus `'comparison'`, `'agent_comparison'` und `'subagent'` heraus, ohne dort etwas zu ändern.
- **Modus-Auswahl** pro Projekt-Grant: Verzeichnis über den OS-Picker wählen (`requestDirectoryAccess(['read','create','edit'])`, setzt `confirmedAt`), Stufe wählen, speichern. Die Oberfläche zeigt `off | read-only | propose | propose-run` — **kein** `auto`.
- **Diff-Dialog**: Paket eines Schritts, Datei und Zeilenzahlen erkennbar, Annehmen / Ablehnen-mit-Grund. Bei Ablehnung wird der Grund zum Tool-Ergebnis für den Agenten.
- **Dritte Option im Zustimmungs-Dialog**: "diese Datei aus dem Kontext werfen und weiterlaufen", und nur die Optionen anzeigen, die `CodingConsentRequest.offers` nennt — insbesondere `anonymize` nicht, wenn es nicht trägt.
- **Rückgängig** und **Audit-Export** als Schaltflächen am abgeschlossenen Run.
- **`getPermissionLabel` muss `edit` nennen** (`FileAccessTab.tsx:57-61`). Die Kaskade prüft heute nur `read`, `create` und `read-create`; ein Grant mit `['read','create','edit']` fällt auf «Read + Create» und die gefährlichste Berechtigung ist unsichtbar. Aufgefallen beim Review von Task 3, dort bewusst nicht behoben (Datei lag ausserhalb) — hier ist es Pflicht, nicht Politur: ein Produkt, dessen Argument «ich kann nachweisen, was der Agent darf» ist, darf eine erteilte Schreibberechtigung nicht verschweigen. Test: ein Grant mit `edit` erzeugt ein Label, das `edit` enthält.

- [ ] **Step 1: Store-Tests schreiben**

```ts
// tests/unit/coding-store.test.ts
it('a coding run is only startable in the chat view', () => { /* Modus > off aber view != chat -> kein Start */ })
it('shows only the consent options the request offers', () => { /* offers ohne 'anonymize' */ })
it('sends the rejection reason along with the rejection', () => { /* Grund landet im IPC-Aufruf */ })
it('the mode picker never offers auto', () => { expect(options).not.toContain('auto') })
```

- [ ] **Step 2: Lauf, der fehlschlägt**

Run: `npx vitest run tests/unit/coding-store.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: Store und Komponenten implementieren**

- [ ] **Step 4: Läufe grün, Typecheck einzeln, volle Suite**

Run: `npx vitest run tests/unit/coding-store.test.ts tests/unit/renderer-process-boundary.test.ts`
Expected: PASS
Run: `npx tsc --noEmit > /tmp/tc1.log 2>&1; echo $?` und `npx tsc -p tsconfig.main.json --noEmit > /tmp/tc2.log 2>&1; echo $?`
Expected: beide `0`
Run: `npx vitest run > /tmp/suite.log 2>&1; echo $?`
Expected: `0` — und das Log lesen, nicht die Zusammenfassung

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/CodingDiffDialog.tsx src/renderer/components/CodingModePicker.tsx src/renderer/stores/coding-store.ts src/renderer/components/MessageInput.tsx src/renderer/components/ChatLayout.tsx src/renderer/components/SensitiveDataConsentDialog.tsx tests/unit/coding-store.test.ts
git commit -m "feat(coding): start a single coding run from the chat view"
```

---

## Abnahme von Phase 1

Erst wenn **alle** Punkte gemessen vorliegen. Die Nummern folgen Abschnitt 8 des Spec.

- [ ] **A1: Typecheck, beide Läufe einzeln nachgewiesen**

```bash
npx tsc --noEmit > /tmp/tc1.log 2>&1; echo "run1: $?"; npx tsc -p tsconfig.main.json --noEmit > /tmp/tc2.log 2>&1; echo "run2: $?"
```
`npm run typecheck` verkettet mit `&&`; ein Fehler im zweiten Lauf verschwindet hinter dem ersten. Und: ein grüner Lauf kann **null Dateien** geprüft haben. Einmal mit einem absichtlichen Typfehler in `src/main/coding/path-policy.ts` provozieren und belegen, dass der zweite Lauf rot wird — dann zurücknehmen.

- [ ] **A2: Volle Suite grün, kein von diesem Plan hinzugefügter Skip**

```bash
npx vitest run > /tmp/suite.log 2>&1; echo $?
```
Exit-Code **und** Log. Nie hinter einer Pipe: `$?` gehört dem letzten Glied, und eine Zusammenfassung kann eine Datei, die nicht importiert, als `PASS` zeigen.

**Korrektur am 2026-11-19, gemessen statt angenommen:** die Suite hat **vor** diesem Plan schon 29 übersprungene Tests, alle umgebungsbedingt und keiner weggedrückt — `it.skipIf(process.platform === 'win32')` in `tests/unit/symlink-escape-real-fs.test.ts:288,307`, die 3-Layer-Phase in `tests/red-team/red-team.test.ts:487` (`run3Layer`), und `describe.skipIf(SKIP)` in `tests/integration/privacy-anonymizer-round-trip.test.ts:34` sowie `privacy-ner-integration.test.ts:135` (brauchen ein geladenes NER-Modell). Das ist **nicht prüfbar**, nicht «rot» — die ursprüngliche Formulierung «ohne ausgelassene Tests» war damit nie erfüllbar und hätte am Ende zur Lockerung des Kriteriums gedrängt, also genau zu dem, was es verhindern soll.

Gemessen wird deshalb die **Differenz**, nicht der Absolutwert:
```bash
git diff origin/main..HEAD -- tests/ | grep -nE "^\+.*(\.skip|\.todo|xit\(|xdescribe)"
```
Muss leer sein. Zusätzlich darf die Zahl der übersprungenen Tests gegenüber `origin/main` nicht steigen.

- [ ] **A3–A4: Der rote Test und seine Positivkontrolle** — `tests/unit/agent-loop-guard.test.ts`, Tests 1 und 2. Die Ausgabe des roten Laufs aus Task 4 Step 6 in die PR-Beschreibung.
- [ ] **A5: Unbekannter Modus → `off`** — `tests/unit/coding-types.test.ts`
- [ ] **A6: `edit_file` scheitert ausserhalb des Grants, auch über einen Symlink** — `tests/unit/coding-read-tools.test.ts` und `coding-edit-proposals.test.ts`
- [ ] **A7: Guard vor der Kompaktierung** — `tests/unit/agent-loop-guard.test.ts`, Test 3
- [ ] **A8: Jedes Ergebnis einzeln auf Injection** — `tests/unit/agent-loop-guard.test.ts`, Test 4
- [ ] **A10: README sagt die Wahrheit** — Task 12 Step 4
- [ ] **A11: `edit` scheitert ohne Marker, `read` und `create` nicht** — `tests/unit/file-access-types.test.ts`

- [ ] **A9: Manueller Durchlauf in der gepackten App**

```bash
npm run pack
```
Pflicht, nicht `npm run dev`: PATH und Arbeitsverzeichnis verhalten sich dort anders, und `propose-run` hängt genau daran. **Vorher `~/Library/Application Support/Mingly/mingly.db` sichern** — der gepackte Build migriert die echte Datenbank.

Ablauf: Projekt gewähren → Modus `propose` → Änderung vorschlagen lassen → ablehnen → erneut vorschlagen lassen → annehmen → rückgängig. Datei ist wieder im Ausgangszustand, geprüft mit `shasum` vorher und nachher, nicht per Augenschein — ein `diff` beantwortet die Ja/Nein-Frage auf diesem Rechner unzuverlässig. Danach Modus `propose-run`, `npm test` im Projekt laufen lassen, und prüfen, dass die Ausgabe durch den Guard ging.

- [ ] **A12: Audit-Export öffnen und lesen** — eine Zeile pro abgenommener Änderung, kein Dateiinhalt darin.
