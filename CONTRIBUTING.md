# Contributing to Mingly

Thank you for your interest in contributing to Mingly! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- Node.js 20+
- npm 9+
- Git
- (Optional) Docker for RAG server
- (Optional) Ollama for local LLM testing

### Getting Started

```bash
git clone https://github.com/mingly-app/mingly.git
cd mingly
npm install
npm run dev
```

This starts both the Vite dev server (renderer) and Electron (main process).

### Project Structure

```
src/
  main/          # Electron main process (Node.js)
    database/    # sql.js database layer
    llm-clients/ # Provider SDKs (Anthropic, OpenAI, Google, Ollama)
    server/      # REST + WebSocket API server
    services/    # ServiceLayer (transport-agnostic business logic)
    security/    # Input sanitization, rate limiting, RBAC
    mcp/         # Model Context Protocol integration
    rag/         # RAG (Retrieval-Augmented Generation)
  renderer/      # React frontend (browser context)
    components/  # UI components
    stores/      # Zustand state management
    utils/       # Utilities (i18n, etc.)
  server/        # Headless server entry point
  shared/        # Types, constants shared between main/renderer
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development (Vite + Electron) |
| `npm run build` | Build main + renderer |
| `npm run build:server` | Build headless server |
| `npm run start:server` | Run headless server |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage |
| `npm run typecheck` | TypeScript type checking |
| `npm run dist` | Build distributable installers |

## Coding Conventions

- **TypeScript** everywhere (strict mode)
- **React** functional components with hooks
- **Zustand** for state management
- **Tailwind CSS** for styling
- No `any` types without justification
- Prefer `const` over `let`
- Use `async/await` over raw Promises

## Testing

We use Vitest for all tests. Tests live in `tests/` (unit tests) and alongside source files for component tests.

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Test Requirements

- All PRs must pass existing tests
- New features should include tests
- Aim for meaningful coverage, not 100% line coverage

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm test`
5. Run type check: `npm run typecheck`
6. Commit with a descriptive message
7. Push and open a PR against `main`

### PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] Types check (`npm run typecheck`)
- [ ] No sensitive data (API keys, personal paths)
- [ ] Follows existing code style
- [ ] Includes tests for new functionality

## Reporting Issues

Use [GitHub Issues](https://github.com/mingly-app/mingly/issues) to report bugs or request features. Include:

- Steps to reproduce
- Expected vs actual behavior
- OS and app version
- Relevant logs (Settings > Export GDPR Data for full audit log)

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).
