# Abhängigkeiten & Electron 44 — Handoff 25.10.2026

**Repo:** `~/mingly` · **`main` auf `6315686`** · **1429 Tests grün / 29 übersprungen** (98 Dateien, 2 übersprungen), `npm run typecheck` Exit 0, `npm ci` Exit 0. Kein offener PR aus dieser Arbeit.

Alle Zahlen hier sind gemessen, nicht erinnert: Nach dem letzten Merge lief in einem frischen Worktree auf `origin/main` ein eigenes `npm ci` (nicht das `node_modules` des Hauptordners, das noch Electron 27 enthält), danach `scripts/inject-secret.ts` mit Dev-Fallback, Typecheck, Tests und `npm audit`.

---

## Was heute auf `main` gelandet ist

| Commit | PR | Inhalt |
|---|---|---|
| `0f1bb27` | #30 | npm-audit: transitive Fixes, vite 5 → 6, electron-builder 24 → 26, promptfoo 0.121 → 0.125, vitest 4.1.12, `overrides.mongodb.gcp-metadata = ^9.2.2` |
| `6315686` | #31 | Electron 27.3.11 → **44.9.3**, `EncryptedStore` entscheidet das Backend erst beim ersten Zugriff |

**npm audit:** vorher 71 (5 critical, 45 high, 21 moderate) → jetzt **11 (0 critical, 7 high, 3 moderate, 1 low)**. Produktions-Baum (`--omit=dev`): **0**.

Von 1426 Tests (#30) auf 1429. **Kein bestehender Test wurde verändert.** Neu ist `tests/unit/encrypted-store-ready.test.ts`. Er ist nachgemessen ohne den Fix 2/3 rot, mit dem Fix 3/3 grün.

**Lockfile und npm 10:** `main` brach vor #30 `npm ci` unter npm 10.9.4 ab («Missing: gcp-metadata@7.0.1», ein optionaler Peer von `mongodb` über promptfoo → natural → mongoose). npm 11 (CI, Node 24) tolerierte das. Der Override behebt es. Er muss bleiben, solange irgendwo npm 10 läuft, auch in der Cloud-Sandbox des Nightly-Audits (Node 22).

---

## Die Regression, die das Electron-Upgrade fast mitgebracht hätte

Unter Electron 44 meldet `safeStorage.isEncryptionAvailable()` auf macOS **vor** `app.ready` `false`, Electron 27 meldete `true`. `keychain-manager.ts` erzeugt seinen `EncryptedStore` beim Modulimport, also vor `ready`. `integration-manager.ts` erzeugt ihn als Klassenfeld, also sobald die Klasse instanziiert wird. Mit der alten Logik im Konstruktor wäre **jeder neu gespeicherte API-Key still mit dem Datei-Schlüssel neben den Daten** verschlüsselt worden statt im Keychain. Es wäre kein Datenverlust gewesen, aber ein Security-Downgrade ohne Fehlermeldung.

Fix: `ensureInitialized()` in allen fünf öffentlichen Methoden (`get`, `set`, `has`, `delete`, `clear`). Das Laden von der Platte liegt ebenfalls darin. Greift doch jemand vor `ready` zu, erscheint `[EncryptedStore] Accessed before app ready`. Diese Warnung ist das Signal, wenn ein neuer Codepfad den Store zu früh anfasst.

---

## Was Holger entscheiden oder tun muss

**1. Signierter und notarisierter `dist:mac` vor dem nächsten Release.**
electron-builder 26 und Electron 44 sind nur mit `electron-builder --dir` getestet, signiert mit Developer ID und ohne Notarisierung. Der volle Release-Pfad mit Notarisierung und Auto-Update über `electron-updater` 6.7.3 ist **nicht** gelaufen. Ebenso nicht: Windows- und Linux-Builds lokal (in der CI sind die Build-Jobs grün) und `npm run dev` interaktiv.

**2. Mindest-macOS steigt auf 13.**
Das kommt mit Electron 44, ebenso das Ende von Linux ia32/armv7l. Wer Mingly auf macOS 12 nutzt, bekommt kein Update mehr, das gehört in die Release Notes.

**3. Electron 45/46 ist ein eigener PR.**
Electron 45 (21.10.2026) deprecated die synchronen `safeStorage`-Methoden, 46 entfernt sie. `EncryptedStore` muss dafür auf `encryptStringAsync`/`decryptStringAsync` umgestellt werden, und die Schnittstelle `get`/`set` wird dadurch asynchron, was alle Aufrufer betrifft. Der Preload ist dafür schon sauber: Er nutzt keine der in 45 entfernten Node-Shims (`Buffer`, `events`, `url`).

---

## Was fertig aussieht, aber Grenzen hat

**Die verbleibenden 7 high betreffen alle `promptfoo`** und damit nur Dev-Tooling (Red-Team-Suite): `@azure/identity` → `@azure/msal-node`, `basic-ftp` → `get-uri` → `pac-proxy-agent` → `proxy-agent`. Erreichbar wären sie nur über promptfoos Azure-Provider oder einen `ftp://`-PAC-Proxy, und beides nutzt unsere Konfiguration nicht (`file://providers/*`). `npm audit` schlägt als Fix `promptfoo@0.28.2` vor. Das ist ein **Downgrade** um fast 100 Minor-Versionen, nicht übernehmen. Die moderaten Befunde (`tailwindcss` 3 → `postcss-selector-parser`, `postcss-nested`) lassen sich nur mit Tailwind 4 beheben. Der eine `esbuild`-low betrifft `esbuild --serve`, das wir nicht nutzen.

**Dialoge ohne `defaultPath` öffnen seit Electron 43 im Downloads-Ordner** statt im zuletzt benutzten. Betroffen sind `file-access-manager.ts` und zwei Dialoge in `content-handlers.ts`. Das ist reine UX und ungeändert.

**Unhandled Rejection «Production build requires a real license secret»** im lokalen Build ohne Secret. Sie bestand schon vorher und gehört nicht zu diesen PRs.

---

## Der Nightly-Audit (neu seit heute)

Ein Claude-Managed-Agents-Deployment prüft `main` täglich um **04:30 Europe/Zurich**: `npm ci`, `inject-secret` (Dev-Fallback), Typecheck, Tests, `npm audit`, Secrets-Grep. Es schreibt nur einen Bericht und ändert keinen Code. Org: Holger's Individual Org, Workspace Default, Budget USD 5 pro Lauf, ein Testlauf kostete USD 0.25–0.39. IDs und Konfiguration stehen in der Memory-Notiz `managed-agents-pilot-mingly-audit`.

Was man über den Bericht wissen muss:
- Die Sandbox hat **Node 22 / npm 10**, die CI **Node 24 / npm 11**. Der Agent installiert die npm-Hauptversion der CI lokal nach, die Node-Version bleibt aber 22 und steht im Bericht.
- **4 Electron-Suites sind dort NOT CHECKABLE**, weil das Electron-Binary nicht heruntergeladen werden darf. Lokal und in der CI laufen sie.
- Ein Postinstall-Skript will `api.nuget.org` erreichen. Welches Paket das ist, ist **ungeklärt**.
- Der Grader prüft die Form des Berichts, nicht die Wahrheit des Befunds. Er war einmal «satisfied» mit einem falschen install-FAIL. Einen roten Befund aus dem Bericht deshalb vor dem Handeln lokal nachmessen.

---

## Nächste Schritte, in dieser Reihenfolge

**1. Release-Pfad testen:** signierter + notarisierter `npm run dist:mac` und ein Auto-Update-Lauf. Erst danach ein Release mit Electron 44.

**2. Ersten Nightly-Bericht lesen (26.10., 04:30).** Er läuft zum ersten Mal gegen das neue `main`. Erwartet: install PASS ohne Lockfile-Fehler, npm-audit 7 high / 0 critical. Weicht er ab, zuerst die Sandbox-Werkzeugkette prüfen, dann den Code.

**3. Electron 45/46 vorbereiten:** `EncryptedStore` auf die async-`safeStorage`-API umstellen, eigener PR mit Regressionstest gegen den `ready`-Zeitpunkt wie in #31.

**4. Optional: promptfoo-Transitive** upstream beobachten. Kein Override über eine Hauptversion für ein Dev-Tool.

---

## Umgebungsfallen, die heute Umläufe gekostet haben

**Das `node_modules` im Hauptordner ist nicht der Stand von `main`.** Ein Worktree unter `~/mingly` löst Abhängigkeiten nach oben auf, aktuell zu Electron 27 und vite 5. Für eine Messung des neuen Stands im Worktree ein eigenes `npm ci` laufen lassen.

**`npx -y npm@10.9.4 …` scheitert hier still plausibel** («Unknown command: "npm@10.9.4"», Exit 1), ein Exit 1, der wie ein roter Befund aussieht. Stattdessen: `npm install --prefix /tmp/npm10 npm@10.9.4`, dann `node /tmp/npm10/node_modules/npm/bin/npm-cli.js ci --dry-run --ignore-scripts`.

**Typecheck und Tests brauchen `src/main/services/_license-secret.ts`.** Die Datei ist gitignored und wird von `npx tsx scripts/inject-secret.ts` erzeugt, ohne Secret mit Dev-Fallback, genau wie in der CI. Ein frischer Worktree ohne diesen Schritt ist rot, das ist ein Umgebungsproblem, kein Befund.

**Ein Smoke-Start des gepackten Builds trifft die echte `mingly.db`.** Am 25.10. hat ein Start ohne Isolation `~/Library/Application Support/Mingly/mingly.db` von Schema 9 auf 10 migriert (additiv, ohne Backup). Mit Electron 44 ist `--user-data-dir=<tmp>` als Isolation **belegt**: Im Smoke-Test von #31 war der SHA der echten DB vorher und nachher identisch. Trotzdem vorher sichern.

---

## Die Lehre, die über das Projekt hinausgeht

Der erste rote Befund des Tages, «`npm ci` scheitert», stimmte und war trotzdem falsch eingeordnet. Er stimmte für npm 10 und nicht für die CI. Erst ein A/B mit beiden npm-Versionen gegen dasselbe Lockfile hat ihn zugeordnet, und erst die Zuordnung hat den Fix in #30 ermöglicht, der jetzt beide Versionen auf denselben Lockfile bringt.

Der wichtigste Befund des Electron-Upgrades war **kein** Test, der rot wurde, sondern ein stiller Wechsel des Verschlüsselungs-Backends. Kein bestehender Test hätte ihn gefunden. Wer Electron weiter hebt, sollte bei jeder Hauptversion gezielt nach APIs suchen, deren Antwort vom Zeitpunkt im App-Lebenszyklus abhängt, und dafür einen Test schreiben, der vor dem Fix rot ist.
