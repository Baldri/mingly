# Usage

## Starting a Chat

1. Click **New Chat** (plus icon in the sidebar)
2. Select a provider and model
3. Type your message and press **Enter**

Responses are streamed in real time.

## Switching Providers

You can switch AI providers at any time:

- **In chat**: Click the provider name at the top of the chat window
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

## Using the Knowledge Base

When the knowledge base is enabled:

1. Ask questions about your documents
2. Mingly automatically searches for relevant content
3. Responses include source citations

**Example:**
> "What does our project plan say about Q2 goals?"

Mingly finds relevant sections in your indexed documents and provides a grounded answer.

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
