# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Email**: security@mingly.ch
2. **GitHub**: [Security Advisories](https://github.com/Baldri/mingly/security/advisories)

Do NOT open a public issue for security vulnerabilities.

We aim to acknowledge reports within 48 hours and provide a fix within 7 days for critical issues.

## Security Architecture

### API Key Storage
- API keys are encrypted at rest using **AES-256-GCM**
- Each key has its own random IV and authentication tag
- Encryption key derived via PBKDF2 from machine-bound parameters
- Keys are never logged or transmitted in plaintext

### Electron Security
- `contextIsolation: true` — renderer cannot access Node.js APIs
- `nodeIntegration: false` — no Node.js in renderer context
- `webSecurity: true` — enforces same-origin policy
- `allowRunningInsecureContent: false`
- Navigation blocked to external URLs
- `window.open` blocked for all URLs
- DevTools disabled in production builds

### Content Security Policy
- `default-src 'self'`
- `script-src 'self'` (no inline scripts)
- `connect-src` limited to known AI provider APIs and localhost
- `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`
- WebSocket connections (`ws://`) only allowed in development

### MCP Security
- Command whitelist: only `node`, `npx`, `python`, `python3`, `deno`, `bun`, `bunx`, `docker`, `podman`, `cargo`, `go`
- Absolute paths restricted to safe system directories (`/usr/bin/`, `/usr/local/bin/`, `/opt/homebrew/bin/`, etc.)
- Shell metacharacter injection blocked (`;`, `|`, `&`, `` ` ``, `$()`, etc.)
- npx/bunx package names validated against safe regex
- Argument length limited to 4096 characters
- Dangerous environment variables blocked (LD_PRELOAD, NODE_OPTIONS, JAVA_TOOL_OPTIONS, etc.)

### Data Privacy
- All data stored locally (no cloud telemetry)
- GDPR/DSG-compliant data retention with configurable limits
- Sensitive data detection before sending to cloud APIs
- Audit logging with RBAC controls
- Data export available for GDPR subject access requests

### ID Generation
- All IDs use `crypto.randomUUID()` (Node.js) or `crypto.getRandomValues()` (renderer)
- No use of `Math.random()` for security-relevant identifiers
