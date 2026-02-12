import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export interface SystemPromptConfig {
  soul: string
  skills: string
  personality: string
  customInstructions?: string
}

export class SystemPromptManager {
  private promptsDir: string
  private cachedPrompts: SystemPromptConfig | null = null

  constructor() {
    // Prompts directory in app resources
    this.promptsDir = path.join(app.getAppPath(), 'prompts')
  }

  /**
   * Load all system prompt files
   */
  async loadPrompts(): Promise<SystemPromptConfig> {
    if (this.cachedPrompts) {
      return this.cachedPrompts
    }

    try {
      const soul = await this.loadFile('soul.md')
      const skills = await this.loadFile('skills.md')
      const personality = await this.loadFile('personality.md')

      // Try to load custom instructions from user data dir
      const customInstructions = await this.loadCustomInstructions()

      this.cachedPrompts = {
        soul,
        skills,
        personality,
        customInstructions
      }

      return this.cachedPrompts
    } catch (error) {
      console.error('Failed to load system prompts:', error)
      // Return fallback minimal prompts
      return this.getFallbackPrompts()
    }
  }

  /**
   * Build complete system prompt for LLM
   */
  async buildSystemPrompt(options?: {
    includeSkills?: boolean
    includePersonality?: boolean
    customMode?: string
  }): Promise<string> {
    const prompts = await this.loadPrompts()

    const sections: string[] = []

    // Always include soul (core identity)
    sections.push('# System Instructions\n')
    sections.push(prompts.soul)

    // Include skills if requested (default: true)
    if (options?.includeSkills !== false) {
      sections.push('\n---\n')
      sections.push(prompts.skills)
    }

    // Include personality if requested (default: true)
    if (options?.includePersonality !== false) {
      sections.push('\n---\n')
      sections.push(prompts.personality)
    }

    // Add custom instructions if available
    if (prompts.customInstructions) {
      sections.push('\n---\n')
      sections.push('# Custom Instructions\n')
      sections.push(prompts.customInstructions)
    }

    // Add mode-specific instructions
    if (options?.customMode) {
      sections.push('\n---\n')
      sections.push(this.getModeInstructions(options.customMode))
    }

    return sections.join('\n')
  }

  /**
   * Get mode-specific instructions
   */
  private getModeInstructions(mode: string): string {
    const modeInstructions: Record<string, string> = {
      code: `# Code Mode Active
- Prioritize code quality and best practices
- Include comments for complex logic
- Suggest tests and error handling
- Use TypeScript when applicable`,

      creative: `# Creative Mode Active
- Embrace creativity and originality
- Use vivid language and imagery
- Explore unconventional ideas
- Focus on engagement and flow`,

      analysis: `# Analysis Mode Active
- Be thorough and systematic
- Consider multiple perspectives
- Cite evidence and reasoning
- Provide structured conclusions`,

      fast: `# Quick Mode Active
- Minimize explanation
- Direct answers only
- Assume technical knowledge
- Skip pleasantries`,

      teach: `# Teaching Mode Active
- Explain concepts step-by-step
- Use examples and analogies
- Check understanding
- Encourage questions`
    }

    return modeInstructions[mode] || ''
  }

  /**
   * Save custom instructions from user
   */
  async saveCustomInstructions(instructions: string): Promise<void> {
    const userDataDir = app.getPath('userData')
    const customPath = path.join(userDataDir, 'custom-instructions.md')

    try {
      await fs.promises.writeFile(customPath, instructions, 'utf-8')
      // Invalidate cache
      this.cachedPrompts = null
    } catch (error) {
      console.error('Failed to save custom instructions:', error)
      throw new Error('Could not save custom instructions')
    }
  }

  /**
   * Load custom instructions from user data directory
   */
  private async loadCustomInstructions(): Promise<string | undefined> {
    const userDataDir = app.getPath('userData')
    const customPath = path.join(userDataDir, 'custom-instructions.md')

    try {
      if (fs.existsSync(customPath)) {
        return await fs.promises.readFile(customPath, 'utf-8')
      }
    } catch (error) {
      console.warn('Could not load custom instructions:', error)
    }

    return undefined
  }

  /**
   * Load individual prompt file
   */
  private async loadFile(filename: string): Promise<string> {
    const filePath = path.join(this.promptsDir, filename)

    try {
      return await fs.promises.readFile(filePath, 'utf-8')
    } catch (error) {
      console.warn(`Could not load ${filename}, using fallback`)
      return this.getFallbackForFile(filename)
    }
  }

  /**
   * Get fallback content for specific file
   */
  private getFallbackForFile(filename: string): string {
    const fallbacks: Record<string, string> = {
      'soul.md': 'You are a helpful AI assistant.',
      'skills.md': 'You can help with code, writing, analysis, and conversation.',
      'personality.md': 'Be helpful, clear, and professional.'
    }

    return fallbacks[filename] || ''
  }

  /**
   * Get minimal fallback prompts if files can't be loaded
   */
  private getFallbackPrompts(): SystemPromptConfig {
    return {
      soul: 'You are a helpful AI assistant in Mingly, a multi-LLM desktop application.',
      skills:
        'You can help with code, writing, analysis, and general conversation. Use intelligent routing to select the best AI provider for each task.',
      personality:
        'Be helpful, clear, and professional. Adapt your communication style to the user.'
    }
  }

  /**
   * Reload prompts from disk (useful for development)
   */
  async reloadPrompts(): Promise<void> {
    this.cachedPrompts = null
    await this.loadPrompts()
  }

  /**
   * Get slash command help text
   */
  getCommandHelp(): string {
    return `
## Available Commands

### Basic Commands
- \`/clear\` - Clear current conversation
- \`/switch [provider]\` - Switch AI provider (anthropic/openai/google)
- \`/route\` - Show intelligent routing suggestion
- \`/settings\` - Open settings modal
- \`/export\` - Export conversation
- \`/help\` - Show this help message

### Mode Modifiers (prefix your message)
- \`@code\` - Optimize for code generation
- \`@creative\` - Optimize for creative writing
- \`@analyze\` - Optimize for analysis
- \`@fast\` - Quick mode (minimal explanation)
- \`@teach\` - Teaching mode (detailed explanations)

### Examples
- \`/switch openai\` - Switch to OpenAI (GPT-4)
- \`@code Write a TypeScript function...\` - Code-optimized response
- \`/route\` - See which provider is best for your next message
    `.trim()
  }
}

// Singleton instance
let promptManagerInstance: SystemPromptManager | null = null

export function getSystemPromptManager(): SystemPromptManager {
  if (!promptManagerInstance) {
    promptManagerInstance = new SystemPromptManager()
  }
  return promptManagerInstance
}
