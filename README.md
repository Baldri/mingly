# Mingly

**Mingle with all AI minds in one place.**

[![CI](https://github.com/mingly-app/mingly/actions/workflows/ci.yml/badge.svg)](https://github.com/mingly-app/mingly/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Mingly gives you unified access to Claude, ChatGPT, Gemini, and local LLMs in a single privacy-first desktop app. Use it standalone or deploy as a server for your team.

## Highlights

- **Multi-Provider** — Claude, GPT-4, Gemini, Ollama (local) in one interface
- **Intelligent Routing** — AI-powered request classification routes to the best model
- **Knowledge Base** — Index your local documents for context-aware AI responses (RAG)
- **Server Mode** — Share AI access across your network via REST + WebSocket API
- **Enterprise Ready** — RBAC, audit logging, budget controls, GDPR compliance
- **Secure** — API keys in OS keychain, input sanitization, rate limiting, CSP headers
- **MCP Integration** — Extend functionality with Model Context Protocol tools
- **Slash Commands** — `/clear`, `/switch`, `/route`, `/export` and mode modifiers like `@code`, `@creative`

## Quick Start

### Desktop App (macOS / Windows)

Download the latest installer from [GitHub Releases](https://github.com/mingly-app/mingly/releases).

### From Source

```bash
git clone https://github.com/mingly-app/mingly.git
cd mingly
npm install
npm run dev
```

### Server Mode (Docker)

```bash
git clone https://github.com/mingly-app/mingly.git
cd mingly
docker compose up -d
```

The API server starts on port 3939. See [Server Documentation](docs/en/CONFIGURATION.md) for details.

## Documentation

| Language | Installation | Configuration | Usage | FAQ |
|----------|-------------|---------------|-------|-----|
| English  | [Install](docs/en/INSTALLATION.md) | [Configure](docs/en/CONFIGURATION.md) | [Usage](docs/en/USAGE.md) | [FAQ](docs/en/FAQ.md) |
| Deutsch  | [Installation](docs/de/INSTALLATION.md) | [Konfiguration](docs/de/KONFIGURATION.md) | [Nutzung](docs/de/NUTZUNG.md) | [FAQ](docs/de/FAQ.md) |

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding conventions, and PR process.

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Mingly** is built by the open-source community. Star the repo if you find it useful!
