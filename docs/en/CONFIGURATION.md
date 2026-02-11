# Configuration

## Setting Up API Keys

Mingly supports multiple AI providers. You need at least one API key to get started.

### Supported Providers

| Provider | Models | Get API Key |
|----------|--------|-------------|
| **Anthropic** | Claude 4.5, Claude 4 Opus, Sonnet, Haiku | [console.anthropic.com](https://console.anthropic.com/) |
| **OpenAI** | GPT-4o, GPT-4, GPT-3.5 | [platform.openai.com](https://platform.openai.com/) |
| **Google** | Gemini 2.5, Gemini 2.0 | [aistudio.google.com](https://aistudio.google.com/) |
| **Ollama** (local) | Llama, Mistral, Phi and more | No key required |

### Adding API Keys

1. Open **Settings** (gear icon)
2. Go to the **General** tab
3. Enter your API key for the desired provider
4. Click **Save**

> **Security:** All API keys are stored in the operating system's secure keychain (macOS Keychain / Windows Credential Vault) — never in plain text.

### Local Models with Ollama

For fully local AI without cloud connectivity:

1. Install [Ollama](https://ollama.com/)
2. Pull a model: `ollama pull llama3.2`
3. Mingly automatically detects Ollama at `http://localhost:11434`
4. Select "Ollama" as the provider in the chat

## Deployment Modes

Mingly offers three deployment modes:

### Standalone (Default)

Everything runs locally on your machine. Ideal for individual users.

- No server needed
- All data stays on your device
- Full feature set

### Server

Mingly runs as a central server on your network. Other clients can connect.

- REST API and WebSocket interface
- Multiple concurrent users
- Centralized API key management
- API key authentication

### Client (Hybrid)

Connects to an existing Mingly server.

- Uses the server's API keys
- Local UI, centralized processing
- Ideal for teams

You can change the deployment mode anytime in **Settings** under **Network & AI Servers**.

## Knowledge Base (RAG)

The knowledge base enriches AI responses with your own documents.

### Setup

1. Open **Settings > Knowledge Base**
2. Enable the knowledge base
3. Select a folder with your documents
4. Mingly indexes the files automatically

### Supported Formats

- PDF, Markdown, plain text files
- Word documents (.docx)
- HTML pages

### Benefits

- Answers grounded in your documents
- Source citations in responses
- Ideal for domain-specific topics and internal documents

## MCP Tools (Model Context Protocol)

Mingly supports MCP servers for extended AI capabilities.

### Configuration

1. Open **Settings > Integrations**
2. Add an MCP server (name + URL)
3. Test the connection

### Capabilities

- File system access
- Database queries
- Web search
- Custom tools and workflows

## Privacy

Mingly takes privacy seriously:

- **No telemetry** — no data is sent to third parties
- **Local storage** — all conversations stay on your device
- **Sensitive data detection** — warns before accidentally sending passwords or API keys
- **GDPR-compliant** — data export and deletion available at any time

Next: [Usage](USAGE.md)
