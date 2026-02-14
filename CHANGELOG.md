# Changelog

All notable changes to this project will be documented in this file.

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
