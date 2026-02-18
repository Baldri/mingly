# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-02-18

### Added — Context Engineering (Phase 3, Manus-inspired)
- **Task Progress Recitation** — Nach jedem Tool-Schritt wird ein kompakter Fortschritts-Summary injiziert (`[Progress: Step N/M]` mit erledigten/fehlerhaften/verbleibenden Schritten). Verhindert das "Lost-in-the-Middle"-Problem bei langen Agent-Runs.
- **Error Preservation** — Volle Fehlerinformationen (Toolname, Argumente, Fehlermeldung) bleiben im Kontext erhalten, damit das LLM aus Fehlern lernt und sie nicht wiederholt.
- **KV-Cache-optimierte Prompt-Architektur** — Deterministische alphabetische Tool-Sortierung, stabile System-Prompt-ID (`'sys-prompt'`), Anthropic `system`-Parameter-Separation fuer maximale Cache-Hits (bis 90% Kostenreduktion).
- **File-basierter Kontext** — Grosse Tool-Ergebnisse (>2000 Zeichen) werden in Temp-Dateien externalisiert, im Kontext durch kompakte Referenz + Preview ersetzt. Automatische Bereinigung nach Run-Abschluss.

### Added — Multi-Ollama Load Balancing
- **OllamaLoadBalancer** — Round-Robin + Health-basiertes Routing ueber mehrere Ollama-Instanzen im lokalen Netzwerk
- **Least-Loaded Routing** — Bevorzugt Backends mit weniger aktiven Requests und niedrigerer Latenz (Exponential Moving Average)
- **Health Checks** — Alle 30 Sekunden, automatisches Failover nach 3 aufeinanderfolgenden Fehlern
- **Transparente Integration** — OllamaClient nutzt automatisch den Balancer wenn 2+ Backends verfuegbar sind, mit Fallback auf konfigurierte URL
- **LocalAIBridge Integration** — Server werden bei Registrierung automatisch zum Balancer-Pool hinzugefuegt, inklusive Lifecycle-Management

### Security
- **URL-Injection-Schutz** — `validateBackendUrl()` validiert Protocol, Host (Regex + URL-Konstruktor) und Port-Range bevor URLs gebaut werden
- **Path-Traversal-Schutz** — AgentContextManager verwendet `string[]` statt Komma-getrennter Strings, plus `path.resolve()` Containment-Check
- **Info-Disclosure-Fix** — Stack Traces werden nur lokal geloggt, nicht an Cloud-LLMs gesendet (verhindert Dateisystem-Pfad-Leakage)
- **Timer-Leak-Fix** — `clearTimeout()` wird bei Tool-Erfolg und -Fehler aufgerufen (verhindert akkumulierende Timer in langen Agent-Runs)
- **Type Safety** — `any`-Casts in OllamaClient durch typisierte Interfaces ersetzt (`OllamaChatResponse`, `OllamaTagsResponse`)

### Technical
- Neue Dateien: 4 (agent-context-manager.ts, ollama-load-balancer.ts, 2 Test-Dateien)
- Geaenderte Dateien: 7 (agent-executor, tool-registry, subagent-orchestrator, anthropic-client, ollama-client, local-ai-bridge, types)
- 1005 Tests in 58 Files — alle bestanden
- TypeScript strict mode clean

## [0.4.0] - 2026-02-17

### Added — Agentic Mode (Phase 1)
- **ReAct Agent Loop** — Full Reason → Act → Observe cycle with automatic tool selection and multi-step chains
- **chatWithTools()** — Tool-use Conversations for Anthropic + OpenAI Providers, inklusive Message-History und System-Prompt
- **ToolRegistry** — Zentrales Tool-Management: Built-in Tools (`web_search`, `read_file`, `write_file`, `execute_command`) + MCP Tools werden automatisch registriert
- **AgentExecutor** — Konfigurierbarer Agent Runner mit `maxSteps` (5), `maxTokensPerRun` (50k), `toolTimeoutMs` (15s), `runTimeoutMs` (120s)
- **AgentStepIndicator** — Live-UI zeigt Thinking → Tool Calls → Tool Results pro Schritt mit klappbaren Details
- **Feature Gate** — `agentic_mode` auf Pro+ Tier begrenzt

### Added — Parallel Intelligence (Phase 2)

#### Ollama + Generic OpenAI Tool-Use
- **Shared `openai-tool-use-helper.ts`** — Gemeinsamer Helper für Function Calling via `/v1/chat/completions` (OpenAI-kompatibles Format)
- **Ollama Tool-Use** — Lokale Modelle mit Function-Calling-Support (llama3.1, qwen2.5, mistral) bekommen vollen Tool-Zugriff
- **Generic OpenAI Tool-Use** — LM Studio, LocalAI, OpenRouter und andere kompatible Backends werden unterstützt
- Message-Konversion, Tool-Call-Parsing und Token-Tracking analog zu OpenAI-Client

#### Agent Comparison (Paralleler Modell-Vergleich mit Tools)
- **AgentComparisonService** — N AgentExecutor-Instanzen (max 3) parallel mit `Promise.allSettled` + 100ms Stagger für same-Provider
- **Isolierte Instanzen** — Jeder Slot bekommt eigenen AgentExecutor mit eigenem ReAct-Loop und isoliertem State (kein Singleton-Sharing)
- **AgentComparisonView** — N Spalten mit Provider-farbigen Badges, Live-AgentStepIndicator, Token/Dauer-Tracking pro Slot
- **Ollama-Warnung** — UI warnt bei >1 Ollama-Slot wegen GPU-Last
- **Agent-Comparison-Store** — Zustand Store mit `perSlotSteps[]` für O(1) Event-Routing und `slotIndex`-Bounds-Check

#### Parallele Subagents (Master → N Subtasks → Synthese)
- **SubagentOrchestrator** — 3-Phasen-Lifecycle:
  1. `decompose()` — Master-LLM nutzt `decompose_task` Built-in Tool zur strukturierten Aufgabenzerlegung (1-3 Subtasks)
  2. `executeSubtasks()` — N parallele AgentExecutor-Instanzen mit vollem Tool-Zugriff (MCP + Built-ins, OHNE decompose_task)
  3. `synthesize()` — Master-LLM synthetisiert Subtask-Ergebnisse zu finaler Antwort
- **SubagentConfigDialog** — Modal für Provider/Model-Konfiguration pro Subtask, Quick-Actions "Alle lokal" / "Alle Cloud"
- **SubagentView** — 4-Phasen-UI mit PhaseIndicator-Dots: Input → Decompose → Execute (parallele Spalten) → Synthese
- **decompose_task Tool** — Built-in Tool mit JSON-Schema, erzwingt strukturierte Ausgabe statt Freitext
- **Subagent-Store** — Zustand Store mit `perTaskSteps: Record<string, AgentStep[]>` für paralleles Event-Tracking

### Added — IPC + Preload
- 6 neue IPC Channels: `AGENT_COMPARISON_START`, `AGENT_COMPARISON_CANCEL`, `AGENT_COMPARISON_STEP`, `SUBAGENT_DECOMPOSE`, `SUBAGENT_START`, `SUBAGENT_CANCEL`, `SUBAGENT_STEP`, `SUBAGENT_STATUS`
- Preload Bridge: `agentComparison` Block (start/cancel/onStep) und `subagent` Block (decompose/start/cancel/onStep/onStatus)

### Added — UI
- **ChatLayout ViewMode** — `'chat' | 'comparison' | 'agent_comparison' | 'subagent'` als union type statt einzelner Booleans, mutual exclusivity garantiert
- 3 neue Toolbar-Buttons: `Columns2` (Textvergleich), `Zap` (Agent Comparison), `GitFork` (Subagent)
- Lazy-Loading für alle neuen Views via `React.lazy()` + `Suspense`

### Security
- **IPC Input-Validierung** — Alle Subagent/Comparison-Handler validieren task, masterSlot, slots[], tasks[] vor Ausführung (Electron Security Boundary)
- **AbortControllers verbunden** — Pro Task/Slot wird ein eigener AbortController erstellt; `cancelSession()` aborted jetzt wirklich. Stagger-Delay ist ebenfalls abortable via `AbortSignal.addEventListener`
- **Synthese-Fehler nicht maskiert** — Status `'partial'` statt `'completed'` wenn Subtask-Ergebnisse vorliegen aber Synthese fehlschlägt
- **Session-Concurrency-Limit** — Max 2 gleichzeitige Sessions pro Service (SubagentOrchestrator + AgentComparisonService)
- **Prompt-Injection-Mitigation** — Subtask-Title auf 200 Zeichen, Description auf 2000 Zeichen begrenzt
- **JSON.parse Safety** — Orchestrator wrapped JSON.parse in try/catch mit hilfreicher Fehlermeldung für lokale Modelle
- **IPC Event-Listener Cleanup** — Stores speichern Unsubscribe-Funktionen und rufen sie bei HMR-Reload auf (Memory-Leak-Fix)
- **Tool-Call Argument Safety** — Tool-Calls mit unparsbaren Arguments werden übersprungen statt mit leerem Objekt ausgeführt
- **SlotIndex Bounds-Check** — Comparison-Store validiert 0 ≤ slotIndex ≤ 2

### Changed
- **Feature Gates** — `agent_comparison: 'pro'` und `subagent_mode: 'pro'` zu FEATURE_MIN_TIER hinzugefügt
- **ChatLayout** — `comparisonMode: boolean` ersetzt durch `viewMode: ViewMode` Union-Type

### Technical
- Neue Dateien: 11 (6 source + 3 tests + 2 stores)
- Geänderte Dateien: 8 (types, ollama-client, generic-openai-client, tool-registry, agent-handlers, feature-gate-manager, preload, ChatLayout)
- 956 Tests in 56 Files — alle bestanden
- TypeScript strict mode clean (beide Configs)
- Security Audit: 23 Findings identifiziert (7 CRITICAL, 9 HIGH, 7 MEDIUM), alle CRITICAL + HIGH gefixt

## [0.3.2] - 2026-02-14

### Fixed
- **App crash on Settings page** — `updater-store.ts` accessed `window.electronAPI.updater` without null-guard, causing `Cannot read properties of undefined (reading 'updater')` crash when the IPC bridge was not yet available

## [0.3.1] - 2026-02-14

### Fixed
- **Settings page infinite loading** — Settings page now shows with default values if backend settings load fails, preventing the permanent spinner
- **API key persistence across updates** — Corrupted encrypted entries (caused by adhoc re-signing) are now auto-cleaned, allowing clean re-entry instead of silent failures
- **CSP blocking inline styles** — Added `'unsafe-inline'` to `style-src` policy, fixing React inline styles and Radix UI positioning that were silently blocked
- **Missing default settings** — `settings-store.ts` now merges loaded settings with defaults, ensuring all UI fields have values even when the stored config is incomplete

## [0.3.0] - 2026-02-14

### Breaking Changes
- **Supabase completely removed** — No more external service dependency for license validation or downloads
- **License validation mode** changed from `'online' | 'offline'` to `'signed' | 'legacy'`

### Changed
- **License activation** now uses HMAC-SHA256 signed keys for offline validation (no server required)
- **Legacy keys** (unsigned format) accepted with 90-day grace period for migration
- **Download URLs** now use GitHub Releases exclusively (`github.com/Baldri/mingly/releases`)
- **Stripe Payment Links** remain as direct checkout URLs (no Supabase intermediary)

### Added
- `LicenseActivationService.generateKey()` static method for admin key generation
- Platform-specific build scripts: `dist:mac`, `dist:win`, `dist:linux`, `dist:publish`

### Removed
- Supabase Edge Function license validation (`validateOnline()`)
- Supabase Storage download URLs
- Machine fingerprint (`getInstanceId()`) for license binding
- Online-first validation flow (was: try online → fallback offline)

### Technical
- License key format: `MINGLY-{TIER}-{PAYLOAD}-{HMAC_8_CHARS}`
- HMAC-SHA256 signature over `MINGLY-{TIER}-{PAYLOAD}` for tamper detection
- 28 license tests (key generation, signed activation, legacy fallback, normalization)
- 880 total tests passing across 50 test files

## [0.2.1] - 2025-02-14

### Fixed
- **Black screen on dialog open** — Double `h-screen` in ChatLayout caused nested 100vh overflow; content was pushed offscreen
- **Dark mode flash on app start** — Theme class now applied synchronously in `useState` initializer instead of async `useEffect`
- **Settings page blank screen** — `SettingsPage` returned `null` while settings were loading; now shows a loading spinner
- **Silent dialog load failures** — All `Suspense fallback={null}` replaced with visible `<LoadingSpinner />` so lazy-loaded dialogs show feedback
- **"Explore Features" had no action** — Setup step 3 on the welcome screen now has an "Open Settings" button
- **Cross-platform window config** — `titleBarStyle: 'hiddenInset'` and `trafficLightPosition` now macOS-only; Windows/Linux use default title bar
- **Sidebar padding on Windows/Linux** — Conditional top padding (traffic-light offset only on macOS)
- **SimpleStore test mocks** — All test files updated to use `SimpleStore.create()` singleton factory pattern

### Changed
- Preload bridge now exposes `platform` (`darwin` | `win32` | `linux`) for platform-aware UI rendering
- `SimpleStore` has `_resetForTesting()` static method for test isolation

## [0.2.0] - 2025-02-14

### Added
- **Model Comparison** — Send the same prompt to 2–3 LLMs in parallel, view responses side-by-side, mark a winner
- **Service Discovery** — Unified discovery of RAG and MCP servers across local, network, and cloud endpoints
- **Updater UI** — "Check for Updates" section in Settings with progress bar, tier-aware download/install
- **License Activation** — Subscription section in Settings (tier badge, license key entry, upgrade) + tier badge in sidebar
- **Routing Mode Toggle** — Switch between manual model selection and Gemma auto-routing from the chat header
- **Active Model Indicator** — Shows current provider/model in the chat header with status dot
- **Local LLM Discovery** — Auto-detects Ollama, LM Studio, vLLM, LocalAI, Text Gen WebUI, llama.cpp in New Conversation modal
- **Custom RAG Server Name** — Users can customize the display name of their RAG server (replaces hardcoded "RAG-Wissen")
- **Gemma Auto-Routing Option** — "Gemma Auto-Routing" as a provider in New Conversation modal

### Changed
- RAG-Wissen defaults to disabled (`ragWissenEnabled: false`) for public release
- `SimpleStore` now uses singleton factory pattern (`SimpleStore.create()`) to prevent stale-cache overwrites

### Fixed
- **Setup wizard re-appearing on restart** — Multiple `SimpleStore` instances sharing `config.json` overwrote each other's changes, losing `wizardCompleted` flag
- **API key warning on first open** — "No API key configured" showed before keys were loaded; now waits for `keysLoaded`
- **macOS traffic lights overlapping sidebar** — Added top padding to push "Conversations" header below close/minimize/maximize buttons
- **UPDATE_SETTINGS not returning merged data** — Handler now returns `{ success: true, settings: merged }` for proper UI sync

## [0.1.1] - 2025-02-13

### Security
- Replace `Math.random()` with `crypto.randomUUID()` for tracking and audit IDs
- Replace `Math.random()` fallback with `crypto.getRandomValues()` in renderer ID generator
- Harden MCP sanitizer: safe directory restrictions, npx/bunx package name validation, argument length limits
- Add blocked environment variables for Java, Perl, Ruby, Bash runtime injection
- Add URL protocol validation for environment variable URLs
- Tighten Content Security Policy: remove `ws://` in production, add `object-src`, `frame-ancestors`, `form-action`, `base-uri`
- Block external navigation and `window.open` attacks
- Remove API key metadata from log messages

### Added
- MCP auto-tool-selector with keyword scoring
- DocMind integration (MCP + REST + Context Injection)
- RAG-Wissen JSON-RPC client
- IPC handler modules (conversation, infrastructure, integration, business, content, RBAC)
- Global ErrorBoundary with recovery UI
- Loading state during initial app bootstrap
- Aria labels for icon-only buttons
- API key memory zeroization (`clearApiKey` / `clearAllApiKeys`)
- 7 new E2E tests (security validation, budget enforcement, data privacy)
- 3 new unit test suites (rag-wissen-client, mcp-tool-selector, docmind-integration)
- Expanded MCP sanitizer tests (22 tests)

### Changed
- Budget check moved BEFORE expensive RAG/MCP operations
- React performance: `memo()` for IntegrationCard, SlackIcon, NotionIcon, ObsidianIcon, NetworkAIServersTab
- React performance: `useCallback` for SetupWizard handlers
- React performance: `useMemo` for MCPServersTab toolsByServer lookup

### Fixed
- Budget manager test mock (`mockResolvedValue` -> `mockReturnValue` for synchronous `getSummary`)
- Onboarding store test mock (`settings.set` -> `settings.update`)

## [0.1.0] - 2025-01-27

### Added
- Initial release
- Multi-provider AI chat (Claude, GPT-4, Gemini, Ollama)
- Encrypted API key storage (AES-256-GCM)
- RAG Knowledge Base with Qdrant
- Server mode (REST + WebSocket)
- RBAC with organization hierarchy
- Budget management with provider fallback
- Activity tracking with cost analytics
- Slack, Notion, Obsidian integrations
- MCP tool integration
- Sensitive data detection
- Setup wizard and onboarding
- Dark/light theme
