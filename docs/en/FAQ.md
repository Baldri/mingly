# Frequently Asked Questions (FAQ)

## General

### What is Mingly?

Mingly is a desktop application that lets you use multiple AI models (Claude, GPT, Gemini, Llama and more) in a single interface. You keep full control over your data and API keys.

### Is Mingly free?

Yes, Mingly itself is free and open source. However, AI providers (Anthropic, OpenAI, Google) charge fees for API usage. With Ollama, you can use local models completely free of charge.

### Which AI models are supported?

- **Anthropic**: Claude 4.5 Sonnet, Claude 4 Opus, Haiku
- **OpenAI**: GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo
- **Google**: Gemini 2.5 Pro, Gemini 2.0 Flash
- **Ollama**: Any locally available model (Llama, Mistral, Phi, etc.)

## Costs

### How much does it cost to use?

Costs depend on the AI provider and model. Approximate pricing per 1 million tokens:

| Model | Input | Output |
|-------|-------|--------|
| Claude Haiku | ~$0.25 | ~$1.25 |
| Claude Sonnet | ~$3.00 | ~$15.00 |
| GPT-4o | ~$2.50 | ~$10.00 |
| GPT-3.5 Turbo | ~$0.50 | ~$1.50 |
| Ollama (local) | Free | Free |

> **Tip:** Use the budget feature in Settings to cap your monthly spending.

### Can I limit costs?

Yes. Under *Settings > Budget*, you can set monthly limits. Mingly warns you before the limit is reached.

## Privacy

### Where is my data stored?

All conversations, settings, and the knowledge base are stored exclusively on your computer. Mingly does not send data to its own servers.

### Are my chats sent to AI providers?

Yes, your messages are sent to the respective AI provider (e.g., Anthropic, OpenAI) to generate a response. This is required for the service to work. Exception: With Ollama, everything stays local.

### Is Mingly GDPR-compliant?

Mingly includes features for GDPR compliance:

- **Data export**: Export all your data as a file
- **Data deletion**: Completely remove all your data
- **No telemetry**: No usage data is collected
- **Sensitive data detection**: Warns before accidentally sending passwords

### How secure are my API keys?

API keys are stored in the OS secure keychain:
- **macOS**: Apple Keychain
- **Windows**: Windows Credential Vault

They are never stored in plain text on disk.

## Local AI (Ollama)

### How do I use AI without the cloud?

1. Install [Ollama](https://ollama.com/)
2. Pull a model: `ollama pull llama3.2`
3. Start Ollama
4. Select "Ollama" as provider in Mingly

All processing happens locally on your computer — no data leaves your device.

### What hardware do I need for local models?

- **Minimum**: 8 GB RAM (for small models like Phi)
- **Recommended**: 16 GB RAM, Apple M1/M2/M3 or dedicated GPU
- **Large models** (70B): 32+ GB RAM

## Server Mode

### When do I need server mode?

Server mode is useful for:

- **Teams**: Multiple people share a single Mingly instance
- **Centralization**: Manage API keys in one place
- **Integration**: Connect other applications via the REST API
- **Headless**: Run on a server without a desktop UI

### How do I set up the server?

The easiest method is Docker:

```bash
docker compose up -d
```

Or manually:

```bash
npm run build:server
npm run start:server
```

The server is then available at `http://localhost:3939`.

### Can I secure the server?

Yes, with API key authentication:

1. Set `MINGLY_REQUIRE_AUTH=true`
2. Define `MINGLY_API_KEY=YourSecretKey`
3. All requests must include the header `Authorization: Bearer YourSecretKey`

## Troubleshooting

### The app won't start

1. Make sure system requirements are met
2. Try reinstalling the app
3. For source installation: `rm -rf node_modules && npm install`

### Responses are slow

- Check your internet connection
- Choose a faster model (e.g., Haiku instead of Opus)
- For Ollama: Make sure enough RAM is available

### The knowledge base finds nothing

- Check if the folder path is correct
- Make sure files are in a supported format
- Wait for indexing to complete

---

Back to: [Installation](INSTALLATION.md) | [Configuration](CONFIGURATION.md) | [Usage](USAGE.md)
