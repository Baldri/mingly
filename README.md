# Mingly

**Mingle with all AI minds in one place.**

[![CI](https://github.com/Baldri/mingly/actions/workflows/ci.yml/badge.svg)](https://github.com/Baldri/mingly/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-mingly.ch-6366f1)](https://mingly.ch)

Mingly gives you unified access to Claude, ChatGPT, Gemini, and local LLMs in a single privacy-first desktop app. Use it standalone or deploy as a server for your team.

## Highlights

### AI Agents & Tools
- **Agentic Mode** — ReAct agents with automatic tool selection and multi-step reasoning chains (Pro+)
- **Agent Comparison** — Run up to 3 ReAct agents in parallel, each with full tool access, compare reasoning + results side-by-side (Pro+)
- **Parallel Subagents** — Master LLM decomposes a task → N parallel agents execute subtasks → Master synthesizes final answer (Pro+)
- **Tool-Use for Local Models** — Ollama + LM Studio + OpenRouter get full function calling via OpenAI-compatible endpoints
- **MCP Tools** — Extend functionality with Model Context Protocol tools + auto-tool-selection
- **Built-in Tools** — `web_search`, `read_file`, `write_file`, `execute_command` available to all agents

### Multi-Provider Chat
- **Multi-Provider** — Claude, GPT-4, Gemini, Ollama (local) in one interface
- **Model Comparison** — Send the same prompt to up to 3 models in parallel, compare text outputs side-by-side
- **Intelligent Routing** — Gemma 2B auto-routes requests to the best model, or switch to manual
- **Local LLM Discovery** — Auto-detects Ollama, LM Studio, vLLM, LocalAI and more

### Infrastructure
- **Service Discovery** — Finds RAG and MCP servers on local machine, network, and cloud
- **Hybrid Orchestration** — Local LLM detects cloud needs, delegates with your approval
- **Knowledge Base** — Index your local documents for context-aware AI responses (RAG with custom server naming)
- **Auto-Updates** — Built-in updater with tier-aware download (Pro+ auto-install, Free manual)
- **Server Mode** — Share AI access across your network via REST + WebSocket API
- **DocMind Integration** — MCPO + RAG context injection for document intelligence
- **Integrations** — Slack, Notion, Obsidian + custom workflows

### Security & Enterprise
- **Enterprise Ready** — RBAC, audit logging, budget controls, GDPR/DSG compliance, license activation
- **Activity Tracking** — Token/cost analytics per provider, daily summaries, budget alerts
- **Secure** — AES-256-GCM encrypted API keys, IPC input validation, CSP, rate limiting, sensitive data detection

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
