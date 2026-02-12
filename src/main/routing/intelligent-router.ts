import { Ollama } from 'ollama'
import type { LLMProvider } from '../llm-clients/client-manager'

export type RequestCategory = 'code' | 'creative' | 'analysis' | 'general' | 'conversation'

export interface RoutingResult {
  category: RequestCategory
  suggestedProvider: LLMProvider
  confidence: number
  reasoning: string
}

export interface ProviderCapabilities {
  code: number // 0-1 score
  creative: number
  analysis: number
  conversation: number
}

// Provider capability matrix (based on benchmarks and real-world usage)
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  anthropic: {
    code: 0.95, // Excellent code generation
    creative: 0.85, // Good creative writing
    analysis: 0.90, // Strong analytical reasoning
    conversation: 0.95 // Best conversational quality
  },
  openai: {
    code: 0.85,
    creative: 0.95, // Best creative writing
    analysis: 0.85,
    conversation: 0.90
  },
  google: {
    code: 0.80,
    creative: 0.75,
    analysis: 0.95, // Best for long-context analysis
    conversation: 0.80
  }
}

export class IntelligentRouter {
  private ollama: Ollama
  private routingModel: string = 'gemma2:2b' // Small, fast model for routing
  private isOllamaAvailable: boolean = false

  constructor() {
    this.ollama = new Ollama({ host: 'http://localhost:11434' })
    this.checkOllamaAvailability()
  }

  /**
   * Check if Ollama is running and Gemma model is available
   */
  private async checkOllamaAvailability(): Promise<void> {
    try {
      // Check if Ollama is running
      const models = await this.ollama.list()

      // Check if gemma2:2b is available
      const hasGemma = models.models.some((m: any) => m.name.includes('gemma2:2b'))

      if (!hasGemma) {
        console.warn('Gemma 2B not found. Intelligent routing will use fallback heuristics.')
        console.log('To enable AI-powered routing, run: ollama pull gemma2:2b')
      } else {
        this.isOllamaAvailable = true
        console.log('Intelligent routing enabled with Gemma 2B')
      }
    } catch (error) {
      console.warn('Ollama not available. Intelligent routing will use fallback heuristics.')
      console.log('To enable AI-powered routing, install Ollama: https://ollama.com')
    }
  }

  /**
   * Route user request to the best provider
   */
  async route(
    userMessage: string,
    availableProviders: LLMProvider[]
  ): Promise<RoutingResult> {
    // Try AI-powered routing first
    if (this.isOllamaAvailable) {
      try {
        return await this.aiPoweredRoute(userMessage, availableProviders)
      } catch (error) {
        console.error('AI-powered routing failed, falling back to heuristics:', error)
      }
    }

    // Fallback to heuristic routing
    return this.heuristicRoute(userMessage, availableProviders)
  }

  /**
   * AI-powered routing using Gemma 2B via Ollama
   */
  private async aiPoweredRoute(
    userMessage: string,
    availableProviders: LLMProvider[]
  ): Promise<RoutingResult> {
    const prompt = `Classify this user request into ONE category: code, creative, analysis, or conversation.

User request: "${userMessage}"

Respond with ONLY the category name (code/creative/analysis/conversation) and nothing else.`

    const response = await this.ollama.generate({
      model: this.routingModel,
      prompt,
      options: {
        temperature: 0.1, // Low temperature for consistent classification
        num_predict: 10 // Only need 1 word
      }
    })

    const category = this.parseCategory(response.response.trim().toLowerCase())
    return this.selectProvider(category, availableProviders, 'AI classification')
  }

  /**
   * Fallback heuristic routing based on keywords
   */
  private heuristicRoute(
    userMessage: string,
    availableProviders: LLMProvider[]
  ): Promise<RoutingResult> {
    const message = userMessage.toLowerCase()

    // Code keywords
    const codeKeywords = [
      'code',
      'function',
      'class',
      'bug',
      'debug',
      'implement',
      'algorithm',
      'syntax',
      'error',
      'typescript',
      'javascript',
      'python',
      'react',
      'api',
      'database',
      'refactor'
    ]

    // Creative keywords
    const creativeKeywords = [
      'write',
      'story',
      'poem',
      'creative',
      'imagine',
      'brainstorm',
      'idea',
      'novel',
      'character',
      'plot',
      'narrative',
      'essay',
      'blog'
    ]

    // Analysis keywords
    const analysisKeywords = [
      'analyze',
      'compare',
      'evaluate',
      'research',
      'summarize',
      'explain',
      'breakdown',
      'examine',
      'assess',
      'review',
      'critique',
      'data',
      'study'
    ]

    const codeScore = codeKeywords.filter((kw) => message.includes(kw)).length
    const creativeScore = creativeKeywords.filter((kw) => message.includes(kw)).length
    const analysisScore = analysisKeywords.filter((kw) => message.includes(kw)).length

    let category: RequestCategory = 'conversation' // default
    if (codeScore > 0 || creativeScore > 0 || analysisScore > 0) {
      const maxScore = Math.max(codeScore, creativeScore, analysisScore)

      if (codeScore === maxScore) {
        category = 'code'
      } else if (creativeScore === maxScore) {
        category = 'creative'
      } else if (analysisScore === maxScore) {
        category = 'analysis'
      }
    }

    return Promise.resolve(
      this.selectProvider(category, availableProviders, 'keyword heuristics')
    )
  }

  /**
   * Select best provider based on category and availability
   */
  private selectProvider(
    category: RequestCategory,
    availableProviders: LLMProvider[],
    method: string
  ): RoutingResult {
    // If only one provider available, use it
    if (availableProviders.length === 1) {
      return {
        category,
        suggestedProvider: availableProviders[0],
        confidence: 0.5,
        reasoning: `Only provider available (classified as: ${category} via ${method})`
      }
    }

    // Score each available provider for this category
    const scores = availableProviders.map((provider) => ({
      provider,
      score: PROVIDER_CAPABILITIES[provider][category as keyof ProviderCapabilities] || 0.5
    }))

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score)

    const best = scores[0]

    return {
      category,
      suggestedProvider: best.provider,
      confidence: best.score,
      reasoning: `Best for ${category} tasks (classified via ${method})`
    }
  }

  /**
   * Parse category from AI response
   */
  private parseCategory(response: string): RequestCategory {
    if (response.includes('code')) return 'code'
    if (response.includes('creative')) return 'creative'
    if (response.includes('analysis')) return 'analysis'
    if (response.includes('conversation')) return 'conversation'
    return 'general'
  }

  /**
   * Get routing suggestion without actually routing
   * (for UI display)
   */
  async getSuggestion(
    userMessage: string,
    currentProvider: LLMProvider,
    availableProviders: LLMProvider[]
  ): Promise<{
    shouldSwitch: boolean
    suggestion?: RoutingResult
  }> {
    const routing = await this.route(userMessage, availableProviders)

    if (routing.suggestedProvider === currentProvider) {
      return { shouldSwitch: false }
    }

    // Only suggest switch if confidence is high enough
    if (routing.confidence < 0.7) {
      return { shouldSwitch: false }
    }

    return {
      shouldSwitch: true,
      suggestion: routing
    }
  }
}

// Singleton instance
let routerInstance: IntelligentRouter | null = null

export function getRouter(): IntelligentRouter {
  if (!routerInstance) {
    routerInstance = new IntelligentRouter()
  }
  return routerInstance
}
