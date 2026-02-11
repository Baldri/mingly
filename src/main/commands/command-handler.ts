import type { LLMProvider } from '../llm-clients/client-manager'
import { getSystemPromptManager } from '../prompts/system-prompt-manager'

export interface CommandResult {
  handled: boolean
  response?: string
  action?: CommandAction
}

export interface CommandAction {
  type:
    | 'switch_provider'
    | 'clear_conversation'
    | 'show_settings'
    | 'export_conversation'
    | 'show_routing'
    | 'set_mode'
  payload?: any
}

export class CommandHandler {
  private systemPromptManager = getSystemPromptManager()

  /**
   * Check if message is a command and handle it
   */
  async handleCommand(message: string): Promise<CommandResult> {
    const trimmed = message.trim()

    // Check for slash commands
    if (trimmed.startsWith('/')) {
      return this.handleSlashCommand(trimmed)
    }

    // Check for mode modifiers (@code, @creative, etc.)
    if (trimmed.startsWith('@')) {
      return this.handleModeModifier(trimmed)
    }

    // Not a command
    return { handled: false }
  }

  /**
   * Handle slash commands (/clear, /switch, etc.)
   */
  private async handleSlashCommand(message: string): Promise<CommandResult> {
    const parts = message.slice(1).split(' ')
    const command = parts[0].toLowerCase()
    const args = parts.slice(1)

    switch (command) {
      case 'clear':
        return {
          handled: true,
          action: { type: 'clear_conversation' },
          response: 'Conversation cleared.'
        }

      case 'switch':
        return this.handleSwitchCommand(args)

      case 'route':
        return {
          handled: true,
          action: { type: 'show_routing' },
          response: 'Analyzing optimal provider for your next message...'
        }

      case 'settings':
        return {
          handled: true,
          action: { type: 'show_settings' }
        }

      case 'export':
        return {
          handled: true,
          action: { type: 'export_conversation' },
          response: 'Exporting conversation...'
        }

      case 'help':
        return {
          handled: true,
          response: this.systemPromptManager.getCommandHelp()
        }

      default:
        return {
          handled: true,
          response: `Unknown command: /${command}\n\nType \`/help\` for available commands.`
        }
    }
  }

  /**
   * Handle /switch command
   */
  private handleSwitchCommand(args: string[]): CommandResult {
    if (args.length === 0) {
      return {
        handled: true,
        response:
          'Usage: `/switch [provider]`\n\nAvailable providers: anthropic, openai, google'
      }
    }

    const provider = args[0].toLowerCase() as LLMProvider

    const validProviders: LLMProvider[] = ['anthropic', 'openai', 'google']

    if (!validProviders.includes(provider)) {
      return {
        handled: true,
        response: `Invalid provider: ${provider}\n\nAvailable providers: ${validProviders.join(', ')}`
      }
    }

    return {
      handled: true,
      action: {
        type: 'switch_provider',
        payload: { provider }
      },
      response: `Switched to ${this.getProviderName(provider)}`
    }
  }

  /**
   * Handle mode modifiers (@code, @creative, etc.)
   */
  private handleModeModifier(message: string): CommandResult {
    const match = message.match(/^@(\w+)\s+(.+)/)

    if (!match) {
      return {
        handled: true,
        response: 'Invalid mode modifier format.\n\nUsage: `@mode your message here`'
      }
    }

    const [, mode, actualMessage] = match

    const validModes = ['code', 'creative', 'analyze', 'fast', 'teach']

    if (!validModes.includes(mode)) {
      return {
        handled: true,
        response: `Unknown mode: @${mode}\n\nAvailable modes: ${validModes.map((m) => `@${m}`).join(', ')}`
      }
    }

    return {
      handled: true,
      action: {
        type: 'set_mode',
        payload: { mode, message: actualMessage }
      }
    }
  }

  /**
   * Get friendly provider name
   */
  private getProviderName(provider: LLMProvider): string {
    const names: Record<LLMProvider, string> = {
      anthropic: 'Anthropic (Claude)',
      openai: 'OpenAI (GPT-4)',
      google: 'Google (Gemini)'
    }

    return names[provider]
  }

  /**
   * Extract actual message if mode modifier was used
   */
  extractMessage(message: string, commandResult: CommandResult): string {
    if (
      commandResult.action?.type === 'set_mode' &&
      commandResult.action.payload?.message
    ) {
      return commandResult.action.payload.message
    }

    return message
  }

  /**
   * Get mode from command result
   */
  getMode(commandResult: CommandResult): string | undefined {
    if (
      commandResult.action?.type === 'set_mode' &&
      commandResult.action.payload?.mode
    ) {
      return commandResult.action.payload.mode
    }

    return undefined
  }
}

// Singleton instance
let commandHandlerInstance: CommandHandler | null = null

export function getCommandHandler(): CommandHandler {
  if (!commandHandlerInstance) {
    commandHandlerInstance = new CommandHandler()
  }
  return commandHandlerInstance
}
