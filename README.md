# Mingly

**Swiss AI Privacy — Use AI without giving up your data.**

[![CI](https://github.com/Baldri/mingly/actions/workflows/ci.yml/badge.svg)](https://github.com/Baldri/mingly/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-mingly.ch-6366f1)](https://mingly.ch)

Mingly is a privacy-first multi-LLM desktop app from Switzerland. Use Claude, ChatGPT, Gemini, and local LLMs in one interface — with automatic PII protection that keeps your personal data off the cloud. Use it standalone or deploy as a server for your team.

## Highlights

### AI Agents & Tools
- **Agentic Mode** — ReAct agents with automatic tool selection and multi-step reasoning chains (Pro+)
- **Agent Comparison** — Run up to 3 ReAct agents in parallel, each with full tool access, compare reasoning + results side-by-side (Pro+)
- **Parallel Subagents** — Master LLM decomposes a task → N parallel agents execute subtasks → Master synthesizes final answer (Pro+)
- **Tool-Use for Local Models** — Ollama + LM Studio + OpenRouter get full function calling via OpenAI-compatible endpoints
- **MCP Tools** — Extend functionality with Model Context Protocol tools + auto-tool-selection
- **Built-in Tools** — `echo` und `decompose_task` stehen allen Agenten zur Verfügung. Die Coding-Werkzeuge `mingly_list_files`, `mingly_read_file`, `mingly_edit_file` und `mingly_run_command` gibt es nur im Coding-Modus (siehe unten) und nur für ein Projektverzeichnis, das Sie freigegeben haben; welches Werkzeug angeboten wird, hängt vom Modus des Verzeichnisses ab. Es gibt keine Werkzeuge `web_search` und `write_file`. Der Namenszusatz `mingly_` ist Absicht: ein eingebautes Werkzeug beansprucht seinen Namen allein, und ohne den Zusatz hätte Mingly einem MCP-Server die gängigen Namen `read_file` und `edit_file` weggenommen — in jedem Lauf, auch bei Coding-Modus `off`.

### Multi-Provider Chat
- **Multi-Provider** — Claude, GPT-4, Gemini, Ollama (local) in one interface
- **Model Comparison** — Send the same prompt to up to 3 models in parallel, compare text outputs side-by-side
- **Intelligent Routing** — Gemma 2B auto-routes requests to the best model, or switch to manual
- **Local LLM Discovery** — Auto-detects Ollama, LM Studio, vLLM, LocalAI and more

### Context Engineering (v0.5.0)
- **Progress Recitation** — Agents stay on track with injected step summaries (prevents Lost-in-the-Middle)
- **Error Learning** — Full error context preserved so agents learn from and avoid repeated mistakes
- **KV-Cache Optimization** — Deterministic tool ordering + stable prompt structure for 90% cost reduction on Anthropic
- **File-based Memory** — Large results externalized to temp files, keeping the context window lean
- **Multi-Ollama Load Balancing** — Distribute workload across multiple Ollama instances on your local network

### Infrastructure
- **Service Discovery** — Finds RAG and MCP servers on local machine, network, and cloud
- **Hybrid Orchestration** — Local LLM detects cloud needs, delegates with your approval
- **Knowledge Base** — Index your local documents for context-aware AI responses (RAG with custom server naming)
- **Auto-Updates** — Built-in updater with tier-aware download (Pro+ auto-install, Free manual)
- **Server Mode** — Share AI access across your network via REST + WebSocket API
- **Multi-Backend Routing** — Load balance across multiple Ollama instances with health checks and automatic failover
- **DocMind Integration** — MCPO + RAG context injection for document intelligence
- **Integrations** — Slack, Notion, Obsidian + custom workflows

### Swiss AI Privacy
- **Automatic PII Protection** — Names, addresses, health data, financial info detected and anonymized before reaching cloud APIs
- **4 Privacy Modes** — Shield (auto-anonymize), Vault (block PII entirely), Transparent (show what's detected), Local Only (nothing leaves your device)
- **On-Device NER** — piiranha-v1 (400M ONNX model) runs locally for DE+EN entity recognition, no cloud processing
- **Swiss-Made** — Built by digital opua GmbH, Walchwil, Switzerland. nDSG-aligned, your data stays yours

### Security & Enterprise
- **Enterprise Ready** — RBAC, audit logging, budget controls, GDPR/nDSG compliance, license activation
- **Activity Tracking** — Token/cost analytics per provider, daily summaries, budget alerts
- **Secure** — AES-256-GCM encrypted API keys, IPC input validation, CSP, rate limiting, sensitive data detection

## Coding-Modus: was geschützt ist und was nicht

Der Coding-Modus (Phase 1) lässt einen Agenten in einem von Ihnen freigegebenen Projektverzeichnis arbeiten. Er ist abgestuft. Pro Verzeichnis gilt genau ein Modus:

| Modus | Angebotene Werkzeuge |
|-------|----------------------|
| `off` | keine Coding-Werkzeuge |
| `read-only` | `mingly_list_files`, `mingly_read_file` |
| `propose` | zusätzlich `mingly_edit_file`: legt einen Änderungsvorschlag an, `mingly_edit_file` selbst schreibt nichts; Sie prüfen den Diff und übernehmen oder verwerfen. Braucht die Berechtigung `edit` auf dem Verzeichnis |
| `propose-run` | zusätzlich `mingly_run_command`: führt einzelne Befehle aus einer festen Liste aus. Braucht ebenfalls die Berechtigung `edit`, weil ein Befehl Dateien ändern kann. **Ab dieser Stufe schreibt der Agent mittelbar**: der gestartete Projektcode kann schreiben, ohne dass Sie einen Diff sehen |

Ein Werkzeug, das der Modus nicht erlaubt, wird dem Modell nicht angeboten und vor der Ausführung ein zweites Mal geprüft.

### Rückgängig: nur für die laufende Sitzung

Nehmen Sie ein Paket an, sichert Mingly vorher jede betroffene Datei im Projekt unter `.mingly/snapshots` und bietet Ihnen «Rückgängig» an, das genau diese Fassungen zurückschreibt. **Das Angebot gilt für die laufende Sitzung.** Nach einem Neustart der App liegen die gesicherten Fassungen weiterhin im Projekt unter `.mingly/snapshots`, aber die Oberfläche bietet kein Rückgängig mehr an: die Liste der angewendeten Pakete wird absichtlich nur im Arbeitsspeicher gehalten, weil eine zweite Kopie von Dateiinhalt im Ruhezustand ein eigener Entscheid über den Datenstandort wäre. Wer nach einem Neustart zurückwill, holt die Dateien aus `.mingly/snapshots` von Hand zurück.

### Wichtig: die Stufen gelten nur für Minglys eigene Werkzeuge, nicht für Ihre MCP-Server

Der Modus stuft **Minglys eigene** Werkzeuge ab. Die MCP-Server, die Sie selbst eingerichtet haben, bleiben **in jedem Modus verfügbar, auch in `read-only`**. Dazu gehören auch MCP-Server mit Schreibzugriff.

Beide Hälften davon gehören zusammen:

- **Die Ergebnisse** jedes MCP-Werkzeugs laufen durch denselben Schutz wie alle anderen Werkzeugergebnisse (Klassifikation, Datenresidenz, Erkennung personenbezogener Daten, Zustimmung).
- **Die Fähigkeit** eines MCP-Servers mit Schreibzugriff wird davon **nicht** erfasst. Ein solcher Server kann auch im Modus `read-only` Dateien ändern oder Befehle auslösen. Der Modus `read-only` beschreibt Minglys eigene Werkzeuge, nicht Ihren gesamten Rechner.

Wer das nicht will, schaltet die betreffenden MCP-Server ab, bevor er einen Coding-Lauf startet. Die Entscheidung, eigene MCP-Server erreichbar zu lassen, fiel am 2026-11-19; die Begründung, warum eine Abstufung für MCP-Server keine belastbare Grundlage hat, steht im Design-Dokument.

### Was der Schutz leistet

- **Sperrliste, absolut, für die Coding-Werkzeuge.** Dateien wie `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `credentials.json`, `*.sqlite`, `*.db` und das ganze Verzeichnis `.git` sind für `mingly_list_files`, `mingly_read_file` und `mingly_edit_file` nie lesbar oder änderbar. Kein Modus und kein Dialog hebt das auf. Die Sperrliste wird zweimal geprüft: auf dem Pfad, wie ihn das Modell schreibt, und auf dem tatsächlichen Pfad nach Auflösung von Symlinks. **Sie gilt nicht für Projektcode, den `mingly_run_command` startet** (siehe unten).
- **Verzeichnisgrenze für die Coding-Werkzeuge.** Lesen und Änderungsvorschläge bleiben im freigegebenen Projektverzeichnis. Ein Befehl **startet** im Projektverzeichnis, und nur dann, wenn dieses Verzeichnis die eigene Wurzel des jeweiligen Programms ist (Marker je Programm, siehe `mingly_run_command`). Was der gestartete Projektcode danach tut, begrenzt die Verzeichnisgrenze nicht.
- **Jedes Werkzeugergebnis läuft durch den Schutz** (Prompt-Injection, sensible Inhalte, Datenresidenz, Zustimmung), bevor es an einen Anbieter geht. Das gilt auch für die Ausgabe von `mingly_run_command`.

### Was der Schutz nicht leistet

- **Derselbe Detektor, nicht dieselbe Behandlung.** Für getippten Text schickt Mingly die *bereinigte* Fassung an den Anbieter (unsichtbare Zeichen entfernt, Homoglyphen normalisiert). Ein Werkzeugergebnis geht dagegen **unverändert** hinaus, auch wenn der Detektor etwas zu bereinigen gefunden hat — `mingly_edit_file` vergleicht seinen Suchtext gegen die echte Datei, und ein Vorschlag aus normalisiertem Text würde als «nicht gefunden» abgelehnt. Geblockt wird in beiden Fällen gleich. Damit der Unterschied nicht still bleibt: die Schrittanzeige macht solche Zeichen als `<U+XXXX>` sichtbar und sagt es in einem Satz, und im Audit-Export steht eine Zeile `coding.guard_flagged` mit dem Befundtyp (nie dem Inhalt).
- **Der Inhaltsdetektor ist schmaler, als er aussieht.** Er erkennt unter anderem **keine** PEM-Kopfzeilen (`-----BEGIN ... PRIVATE KEY-----`), **keine** JWTs, **keine** Stripe-Schlüssel der Form `sk_live_`, **keine** base64-kodierten Docker-Zugangsdaten und **keine** npm-Token. Ein Geheimnis dieser Art, das in einer lesbaren Datei oder in der Ausgabe eines Befehls steht, wird nicht angehalten. Die Sperrliste nach Dateinamen ist die stärkere Barriere, aber sie kennt nur Dateinamen: ein Geheimnis in einer Datei mit harmlosem Namen ist nicht gesperrt.
- **`mingly_run_command` ist keine Sandbox.** Ein erlaubter Befehl führt Projektcode mit Ihren Benutzerrechten aus: ein Test, ein `npm`-Skript aus der `package.json`, eine `conftest.py`. Dieser Code kann alles lesen, was Sie lesen können, **auch Dateien auf der Sperrliste und ausserhalb des Projekts**, und deren Inhalt in die Ausgabe schreiben (die dann nur der schmale Inhaltsdetektor prüft). Er kann **Dateien anlegen, ändern und löschen**, auch ausserhalb des Projekts und ohne Diff und Zustimmung, und er kann das Netz erreichen. Die Befehlsliste begrenzt, **welcher Befehl** gestartet wird, nicht, **was der Projektcode dann tut**. Öffnen Sie im Modus `propose-run` nur Projekte, deren Code Sie ausführen würden.
- **Die Kette «Änderung annehmen, dann Befehl erlauben» ist mehr als ihre beiden Schritte.** Jeder Schritt für sich ist gedeckt: ein Änderungsvorschlag schreibt erst, wenn Sie den Diff angenommen haben, und ein Befehl startet nur aus der festen Liste. Zusammen heben sie sich gegenseitig auf. Haben Sie eine Änderung an einer Testdatei, an einer `vitest.config`, an einem Skript der `package.json` oder an irgendetwas angenommen, das der Testlauf importiert, dann führt der nächste erlaubte Befehl **diesen geänderten Code** aus — mit Ihren Benutzerrechten und ohne Sperrliste. Aus «ja, dieser Diff sieht gut aus» wird damit beliebige Codeausführung. Prüfen Sie im Modus `propose-run` jeden Diff auch daraufhin, was er beim nächsten Befehl tun wird. Wer das nicht will, bleibt beim Modus `propose` und startet Befehle selbst im Terminal.

### `mingly_run_command` im Detail

- **Keine Shell.** Die Befehlszeile wird an Leerzeichen in eine Argumentliste zerlegt; jedes Zeichen mit Shell-Bedeutung (`& | ; < > $` Backtick `( ) { }`, Anführungszeichen, Backslash, Steuerzeichen) führt zur Ablehnung. Gestartet wird ohne Shell.
- **Erlaubt sind nur diese Befehle:** `npm test`, `npm run <skript>` (das Skript muss in der `package.json` stehen), `vitest run [pfade]`, `tsc --noEmit` (auch als `npx tsc --noEmit`, es wird dann das `tsc` des Projekts gestartet, nie `npx`), `pytest [pfade]`, `git status [--short]`, `git diff --stat` und `git diff --name-only`. Pfadargumente müssen relative Projektpfade sein, dürfen nicht gesperrt sein und dürfen per Symlink nicht aus dem Projekt hinausführen.
- **`git diff` ohne `--stat` oder `--name-only` ist absichtlich nicht erlaubt.** Es würde Dateiinhalte ausgeben, auch von Dateien auf der Sperrliste, die Git verfolgt.
- **`git`: was auf der Befehlszeile abgeschaltet wird, und was stattdessen zur Ablehnung führt.** Abgeschaltet werden der Fsmonitor-Hook (`core.fsmonitor`), der Pager und die externen Diff- und Textconv-Treiber. **Clean- und Smudge-Filter lassen sich nicht abschalten** — es gibt kein Git-Flag dafür. Gemessen (Git 2.53.0, Negativkontrolle im selben Lauf): ein `filter.<name>.clean`-Treiber, den eine `.gitattributes` im Baum auswählt, wird von `git diff --stat`, von `git diff --name-only` **und** von `git status [--short]` ausgeführt — bei `git status` dann, wenn die Dateigrösse unverändert ist und Git die Änderung nicht aus den Metadaten entscheiden kann. Derselbe Treiber ist auch über `[include] path = …` erreichbar. Darum wird ein Repository **abgelehnt** (mit dem allgemeinen Text), wenn seine Konfiguration einen `filter`-Abschnitt, einen Schlüssel auf `…command` oder ein `include`/`includeIf` enthält; geprüft wird die `config` des aufgelösten Git-Verzeichnisses und, bei einem verknüpften Worktree, die des geprüften `commondir`. **Gefragt wird Git selbst, und zwar nach dem, was es benutzen wird** (`git config --list --name-only --show-scope --no-includes`, mit denselben `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE` wie der eigentliche Befehl und ohne System- und Benutzerkonfiguration) — nicht der Text einer Datei und auch keine Liste von Dateien. Der Grund: Git kennt für denselben Abschnitt mehrere Schreibweisen (die gepunktete Form `[filter.lfs]` definiert denselben Treiber wie `[filter "lfs"]`), **und es liest mehr Dateien, als man aufzählen würde** — bei gesetztem `extensions.worktreeConfig` auch `$GIT_DIR/config.worktree`. Erwartet werden nur die Bereiche `local` und `worktree`; meldet Git einen anderen, wird abgelehnt. Eine Konfiguration, die Git nicht einlesen kann, und jede Ausgabe, die sich nicht als `Bereich<TAB>Schlüssel` lesen lässt, führen ebenfalls zur Ablehnung. **Folge im Alltag:** ein Repository, das den LFS-Filter **selbst** einträgt (`[filter "lfs"]` in `.git/config` oder `config.worktree`), wird abgelehnt — dort sind `git status` und `git diff --stat` über `mingly_run_command` nicht verfügbar. Das ist beabsichtigt: der LFS-Filter ist ein Programm, und ihn auszuführen wäre genau das, was dieser Modus nicht tut. **Nicht erkannt wird ein global installiertes Git-LFS** (`git lfs install` ohne `--local` schreibt in die `~/.gitconfig`): so ein Repository trägt keinen eigenen Filter-Abschnitt, besteht die Prüfung, und sein Filter läuft — gemessen für `git status --short`, `git diff --stat` und `git diff --name-only`. Das ist ebenfalls beabsichtigt: die Gefahr ist ein fremdes Repository, die globale Konfiguration ist die eigene des Nutzers. **Nicht abgedeckt:** die globale `~/.gitconfig` (`HOME` wird durchgereicht) und Schlüssel, die ein Programm für Befehle benennen, die diese Liste nicht erlaubt.
- **Das Projektverzeichnis muss die eigene Wurzel des Programms sein.** Diese Programme suchen ihre Wurzel oder Konfiguration **aufwärts** vom Arbeitsverzeichnis. Ohne eigenen Marker im freigegebenen Verzeichnis würde ein Programm auf einer Wurzel **ausserhalb** der Freigabe laufen. Gemessen auf dem Entwicklungsrechner: `npm` führt Skripte der `package.json` eines übergeordneten Verzeichnisses aus, `tsc` übersetzt die `tsconfig.json` des übergeordneten Verzeichnisses, `git` meldet das übergeordnete Repository, `vitest` lädt die Konfigurationsdatei des übergeordneten Verzeichnisses. Darum startet ein Befehl nur, wenn das freigegebene Verzeichnis selbst einen Marker hat: `npm` eine gültige `package.json`, `tsc` eine `tsconfig.json`, `git` ein `.git` (siehe nächster Punkt), `vitest` eine `vitest.config.*` oder `vite.config.*`, `pytest` eine `pytest.ini`, `pyproject.toml`, `tox.ini` oder `setup.cfg`. Ein Marker, der ein Symlink aus der Freigabe hinaus ist, zählt nicht. **`pytest` ist nicht gemessen** (auf dem Entwicklungsrechner nicht installiert): der Marker ist dort eine Vorbedingung nach dem Grundsatz «im Zweifel ablehnen», kein Beleg dafür, dass er ausreicht. Fehlt der Marker, lehnt `mingly_run_command` mit dem allgemeinen Text ab; ein Projekt ohne eigene Konfiguration kann `vitest` also nicht über `mingly_run_command` starten.
- **`git`: eine `.git`-Datei ist eine Umleitung.** In einem verknüpften Worktree oder Submodul ist `.git` eine Datei mit `gitdir: <pfad>` und schickt git an einen anderen Ort. Gemessen: zeigte sie auf ein fremdes Repository ausserhalb der Freigabe, listete `git status` von dort Dateinamen aus dem fremden Index auf. Darum wird das Ziel von `gitdir:` aufgelöst (relativ zum Verzeichnis der Datei, Schritt für Schritt wie das Betriebssystem aufgelöst: ein `..` nach einem Symlink gilt für das übergeordnete Verzeichnis des Link-Ziels, nicht für den Text davor; ein absoluter Pfad ersetzt die Basis, wie ihn `git worktree add` schreibt) und muss **strikt innerhalb der Freigabe** liegen; liegt ein `commondir` im Git-Verzeichnis, gilt dasselbe für ihn. Danach wird git fest auf dieses Verzeichnis (`GIT_DIR`), auf das geprüfte `commondir` (`GIT_COMMON_DIR`, sonst würde git die ungeprüfte Datei erneut lesen) und auf die Projektwurzel als Arbeitsbaum (`GIT_WORK_TREE`, das ein `core.worktree` aus der Konfiguration übersteuert; gemessen) gesetzt. Folge: ein Worktree, dessen Haupt-Repository **ausserhalb** der Freigabe liegt (der übliche Fall bei `git worktree add` in ein Geschwisterverzeichnis), wird abgelehnt. **Nicht abgedeckt, nicht gemessen:** Objektspeicher, die das Git-Verzeichnis über `objects/info/alternates` aus der Freigabe hinaus einbindet, Konfigurationen, die per `include` von ausserhalb nachgeladen werden, und **Symlinks innerhalb des Git-Verzeichnisses** (`index`, `refs`, `objects`, `HEAD`), die auf Fremdes zeigen: bei einem Git-Verzeichnis, das ganz in der Freigabe liegt, kann ein solcher Symlink Dateinamen und Zeilenzahl-Änderungen aus einem fremden Repository sichtbar machen (von der Prüfung gemessen; Dateiinhalte wurden von keiner erlaubten Form ausgegeben). Die Coding-Werkzeuge können nicht in `.git/` schreiben; es braucht also ein feindliches Repository, das Sie selbst freigegeben haben; ebenso die globale `~/.gitconfig`, denn `HOME` wird durchgereicht. Ein Grant auf die Dateisystemwurzel besteht die Prüfung nie (Ablehnung, kein Fehler).
- **Programme kommen nie aus dem `PATH`.** Ein Programm ist entweder `<projekt>/node_modules/.bin/<name>` oder ein absoluter Pfad, den Sie für `npm`, `git` oder `pytest` hinterlegt haben. Diese Pfade stehen in der Datei `coding-interpreters.json` im Benutzerdatenverzeichnis von Mingly (Schlüssel `paths`). **Stand heute gibt es dafür noch keine Einstellungsoberfläche und keinen Vorschlag durch Mingly:** ohne hinterlegten Pfad ist `npm`, `git` und `pytest` nicht ausführbar, und `mingly_run_command` lehnt den Befehl ab.
- **`vitest` und `tsc` brauchen `node`.** Als `PATH` erhält der Befehl die Verzeichnisse der hinterlegten Programme plus `/usr/bin:/bin`. Liegt `node` in keinem davon (typisch ist das Verzeichnis von `npm`), startet ein Projektprogramm nicht.
- **Umgebung.** Der Befehl erbt die Umgebung von Mingly nicht. Er erhält `PATH`, `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0` sowie `HOME` und `TMPDIR`, falls gesetzt. API-Schlüssel aus Minglys Prozess erreichen ihn nicht.
- **Begrenzungen für den ganzen Lauf, nicht nur pro Befehl:** höchstens 20 Befehle und 120 Sekunden Gesamtzeit pro Lauf (das Budget wird vor allen Prüfungen belegt, die Ihren Rechner betreffen, und bei einer Ablehnung zurückgegeben; parallele Aufrufe teilen sich also dasselbe Budget), höchstens 60 Sekunden pro Befehl. Die 120 Sekunden sind der Lauf-Timeout des Agenten, der den Lauf als erster beendet; hier stand vorher ein Budget von 300 Sekunden, das deshalb nie erreichbar war. Das Werkzeug-Timeout des Agenten ist für diesen Befehl eigens höher gesetzt (65 Sekunden), damit die 60 Sekunden auch wirklich zur Verfügung stehen; für alle anderen Werkzeuge bleibt es bei 15 Sekunden, damit ein hängendes Werkzeug einen Lauf nicht eine Minute lang blockiert. Bei Zeitüberschreitung oder übermässiger Ausgabe wird die ganze Prozessgruppe beendet; lässt sich die Prozessgruppe nicht beenden, antwortet das Werkzeug trotzdem (mit dem bis dahin Gelesenen) und protokolliert eine Warnung. Von der Ausgabe kommen Anfang und Ende zurück, mit einem Hinweis auf das Ausgelassene.
- **Abgelehnte Befehle.** Ein Befehl, der aus sich selbst heraus unzulässig ist, wird mit Begründung abgelehnt. Alles, was von Ihrem Rechner abhängt (kein Pfad hinterlegt, Programm fehlt, Marker fehlt, Skript nicht in der `package.json`, fehlende Berechtigung `edit`, kein Projekt-Grant), erhält denselben Text, damit die Antwort nichts über Ihr Dateisystem verrät.

## Pricing

Mingly is open source and stays that way. Choose the plan that fits you.

| | Free | Pro | Team | Enterprise |
|---|:---:|:---:|:---:|:---:|
| **Price** | CHF 0 | CHF 24/mo | CHF 69/user/mo | On request |
| Local models (Ollama) | ✓ | ✓ | ✓ | ✓ |
| Cloud APIs (Claude, GPT, Gemini) | | ✓ | ✓ | ✓ |
| Unlimited conversations | | ✓ | ✓ | ✓ |
| Prompt templates | | ✓ | ✓ | ✓ |
| Agentic Mode (ReAct + tools) | | ✓ | ✓ | ✓ |
| Agent Comparison (parallel) | | ✓ | ✓ | ✓ |
| Parallel Subagents | | ✓ | ✓ | ✓ |
| Team workspaces | | | ✓ | ✓ |
| RBAC & audit logs | | | ✓ | ✓ |
| SSO (OAuth / SAML) | | | ✓ | ✓ |
| On-premise & compliance | | | | ✓ |
| Dedicated support & SLA | | | | ✓ |

Annual plans available: Pro CHF 199/year, Team CHF 599/user/year (min. 5 users).

You pay AI provider API costs directly — Mingly charges no markup. With Ollama, everything runs locally for free.

## Quick Start

### Desktop App (macOS / Windows)

Download the latest installer from [GitHub Releases](https://github.com/Baldri/mingly/releases).

### From Source

```bash
git clone https://github.com/Baldri/mingly.git
cd mingly
npm install
npm run dev
```

### Server Mode (Docker)

```bash
git clone https://github.com/Baldri/mingly.git
cd mingly
docker compose up -d
```

The API server starts on port 3939. See [Server Documentation](docs/en/CONFIGURATION.md) for details.

## Documentation

| Language | Installation | Configuration | Usage | FAQ |
|----------|-------------|---------------|-------|-----|
| English  | [Install](docs/en/INSTALLATION.md) | [Configure](docs/en/CONFIGURATION.md) | [Usage](docs/en/USAGE.md) | [FAQ](docs/en/FAQ.md) |
| Deutsch  | [Installation](docs/de/INSTALLATION.md) | [Konfiguration](docs/de/KONFIGURATION.md) | [Nutzung](docs/de/NUTZUNG.md) | [FAQ](docs/de/FAQ.md) |

Full documentation available on the [Wiki](https://github.com/Baldri/mingly/wiki).

## Security

Security is a core design principle. See [SECURITY.md](SECURITY.md) for details on:

- Encrypted API key storage (AES-256-GCM)
- IPC input validation at the Electron security boundary
- MCP command injection prevention (whitelist + sanitizer)
- Prompt injection mitigation (subtask length limits, tool-call argument validation)
- Content Security Policy (environment-aware)
- Session concurrency limits for parallel agents
- Navigation and window.open protection
- RBAC with audit logging

Report vulnerabilities to security@mingly.ch or via [GitHub Security Advisories](https://github.com/Baldri/mingly/security/advisories).

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding conventions, and PR process.

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Mingly** is built by [digital opua GmbH](https://mingly.ch), Walchwil, Switzerland. Star the repo if you find it useful!
