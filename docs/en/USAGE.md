# Usage

## Starting a Chat

1. Click **New Chat** (plus icon in the sidebar)
2. Select a provider and model (cloud providers, local models, or Gemma Auto-Routing)
3. Type your message and press **Enter**

Responses are streamed in real time.

### Local Model Discovery

When you open the New Chat dialog, Mingly automatically scans for local LLM servers:

- **Ollama** (port 11434)
- **LM Studio** (port 1234)
- **vLLM** (port 8000)
- **LocalAI** (port 8080)
- **Text Gen WebUI** (port 5000)
- **llama.cpp** (port 8081)

Discovered models appear under the **Local Models** group.

### Gemma Auto-Routing

Select **Gemma Auto-Routing** as provider to let Gemma 2B classify your request and route it to the best model automatically.

## Model Indicator

The chat header shows which model is active for the current conversation:

```
● anthropic / claude-3-5-sonnet
```

## Model Comparison

Compare how different models respond to the same prompt:

1. Click the **Columns** icon (⫼) in the chat header to enter comparison mode
2. Add 2–3 models (e.g. Claude, GPT-4, Gemini)
3. Enter a prompt and click **Compare**
4. View responses side-by-side with latency, token count, and cost
5. Click **Mark as Winner** on the best response

## Routing Mode

Toggle between manual and auto-routing in the chat header:

- **Manual** (User icon) — You choose the model for each conversation
- **Auto** (Sparkles icon) — Gemma 2B analyzes each request and picks the best model

## Switching Providers

You can switch AI providers at any time:

- **In chat**: The model indicator shows the current provider/model
- **New chat**: Choose a different provider when creating a conversation
- **Default provider**: Set in Settings under *General*

## Managing Conversations

### Sidebar

The sidebar lists all conversations chronologically:

- Click a conversation to open it
- Start a new conversation with the plus icon
- Conversations are saved automatically

### Titles

Conversations are automatically titled based on their content. You can change the title at any time.

## Service Discovery

Mingly can automatically discover RAG and MCP servers:

1. Go to **Settings > RAG** or **Settings > MCP Servers**
2. Click **Discover**
3. Mingly scans local ports, your LAN subnet, and configured cloud endpoints
4. Discovered services appear with their status (online/offline) and location (local/network/cloud)

### Custom RAG Server Name

By default, external RAG servers are labeled "RAG-Wissen". To customize:

1. Go to **Settings > RAG** and click **Configure** on the server card
2. Change the **Display Name** field to your preferred name
3. The name updates throughout the app

## Using the Knowledge Base

When the knowledge base is enabled:

1. Ask questions about your documents
2. Mingly automatically searches for relevant content
3. Responses include source citations

**Example:**
> "What does our project plan say about Q2 goals?"

Mingly finds relevant sections in your indexed documents and provides a grounded answer.

## Auto-Updates

Mingly checks for updates automatically:

- **Pro+ tier**: Updates download in the background and install when you quit/restart the app. Click "Restart & Install" in Settings for immediate update.
- **Free tier**: You'll be notified of new versions. Click "Download Manually" to get the latest release from GitHub.

Check manually: **Settings > General > Check for Updates**

## Subscription & License

Manage your subscription in **Settings > General**:

- View your current tier (Free/Pro/Team/Enterprise)
- Enter a license key to activate a paid plan
- Upgrade via the "Upgrade" button (links to mingly.ch)
- The sidebar also shows your current tier with an upgrade shortcut

## Tracking Costs

Mingly automatically tracks your API usage:

- **Analytics tab** in Settings shows costs per provider
- **Token counter** for each message
- **Budget settings** for monthly limits

### Setting a Budget

1. Open **Settings > Budget**
2. Set a monthly limit
3. Mingly warns you before the limit is reached

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Send message | `Enter` |
| New line | `Shift + Enter` |
| New chat | `Ctrl/Cmd + N` |
| Settings | `Ctrl/Cmd + ,` |

## Tips for Better Results

### Clear Instructions

The more specific your prompt, the better the response:

- **Good:** "Explain the benefits of TypeScript over JavaScript for large projects"
- **Better:** "List 5 specific benefits of TypeScript over JavaScript for a team of 10 developers"

### Use Context

Mingly remembers the conversation history. You can reference previous messages:

> "Explain the third point in more detail"

### Model Selection

- **Quick questions**: Haiku / GPT-3.5 (affordable, fast)
- **Complex tasks**: Claude Opus / GPT-4o (precise, detailed)
- **Local use**: Ollama (free, no cloud)

## Troubleshooting

### "No API key configured"

Go to *Settings > General* and add at least one API key.

### "Connection to provider failed"

- Check your internet connection
- Make sure the API key is valid
- Some providers have regional restrictions

### "Model not available"

- Check if your API plan supports the model
- Some models require separate access approval

Next: [FAQ](FAQ.md)
