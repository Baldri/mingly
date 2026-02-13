# Changelog

All notable changes to this project will be documented in this file.

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
