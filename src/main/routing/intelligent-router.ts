import { Ollama } from 'ollama'
import type { LLMProvider } from '../llm-clients/client-manager'

export type RequestCategory = 'code' | 'creative' | 'analysis' | 'general' | 'conversation'

export interface RoutingResult {
  category: RequestCategory
  suggestedProvider: LLMProvider
  confidence: number
  reasoning: string
}

export interface ModelRoutingResult {
  category: RequestCategory
  suggestedModel: string
  provider: string
  confidence: number
  reasoning: string
}

export interface ProviderCapabilities {
  code: number // 0-1 score
  creative: number
  analysis: number
  conversation: number
}

/** Known local model capability patterns (matched by name substring) */
const MODEL_CAPABILITY_PATTERNS: Array<{
  pattern: RegExp
  capabilities: ProviderCapabilities
}> = [
  // Code-focused models
  { pattern: /codellama|deepseek-coder|starcoder|codegemma|qwen2?\.?5?-coder/i, capabilities: { code: 0.95, creative: 0.40, analysis: 0.60, conversation: 0.50 } },
  // Creative / writing models
  { pattern: /nous-hermes|mythomax|openhermes|neural-chat/i, capabilities: { code: 0.50, creative: 0.90, analysis: 0.65, conversation: 0.85 } },
  // Analysis / reasoning models
  { pattern: /mixtral|qwen2?\.?5|yi-|solar|phi-?[34]|gemma2?/i, capabilities: { code: 0.75, creative: 0.70, analysis: 0.90, conversation: 0.80 } },
  // General purpose large models
  { pattern: /llama-?3|llama3|mistral(?!-)|vicuna|command-r/i, capabilities: { code: 0.80, creative: 0.80, analysis: 0.80, conversation: 0.85 } },
  // Small / fast models (general but lower quality)
  { pattern: /tinyllama|phi-?2|gemma:2b|orca-mini|stablelm/i, capabilities: { code: 0.50, creative: 0.50, analysis: 0.50, conversation: 0.60 } },
]

/** Default capabilities for unknown models */
const DEFAULT_MODEL_CAPABILITIES: ProviderCapabilities = { code: 0.60, creative: 0.60, analysis: 0.60, conversation: 0.65 }

/** Infer capabilities of a local model from its name */
function inferModelCapabilities(modelName: string): ProviderCapabilities {
  for (const { pattern, capabilities } of MODEL_CAPABILITY_PATTERNS) {
    if (pattern.test(modelName)) return capabilities
  }
  return DEFAULT_MODEL_CAPABILITIES
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
    const category = this.heuristicClassify(userMessage)
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
   * Route user request to the best LOCAL model.
   * Each entry is { id: 'source:modelName', source, name, port }.
   * Uses Gemma to classify, then picks the model best suited for that category.
   */
  async routeLocalModel(
    userMessage: string,
    availableModels: Array<{ id: string; name: string; source: string; port: number }>
  ): Promise<ModelRoutingResult> {
    if (availableModels.length === 0) {
      return {
        category: 'general',
        suggestedModel: '',
        provider: '',
        confidence: 0,
        reasoning: 'No local models available'
      }
    }

    // Single model — no routing needed
    if (availableModels.length === 1) {
      const m = availableModels[0]
      return {
        category: 'general',
        suggestedModel: m.name,
        provider: m.source,
        confidence: 1,
        reasoning: 'Only local model available'
      }
    }

    // Classify request
    let category: RequestCategory
    if (this.isOllamaAvailable) {
      try {
        const prompt = `Classify this user request into ONE category: code, creative, analysis, or conversation.\n\nUser request: "${userMessage}"\n\nRespond with ONLY the category name (code/creative/analysis/conversation) and nothing else.`
        const response = await this.ollama.generate({
          model: this.routingModel,
          prompt,
          options: { temperature: 0.1, num_predict: 10 }
        })
        category = this.parseCategory(response.response.trim().toLowerCase())
      } catch {
        category = this.heuristicClassify(userMessage)
      }
    } else {
      category = this.heuristicClassify(userMessage)
    }

    // Score each local model
    const scored = availableModels.map((m) => {
      const caps = inferModelCapabilities(m.name)
      const score = caps[category as keyof ProviderCapabilities] || 0.5
      return { model: m, score }
    })

    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]

    return {
      category,
      suggestedModel: best.model.name,
      provider: best.model.source,
      confidence: best.score,
      reasoning: `Best local model for ${category} tasks (${best.model.source}:${best.model.name})`
    }
  }

  /**
   * Heuristic classification without Gemma (extracted for reuse).
   */
  private heuristicClassify(userMessage: string): RequestCategory {
    const message = userMessage.toLowerCase()

    const codeKeywords = ['code', 'function', 'class', 'bug', 'debug', 'implement', 'algorithm', 'syntax', 'error', 'typescript', 'javascript', 'python', 'react', 'api', 'database', 'refactor']
    const creativeKeywords = ['write', 'story', 'poem', 'creative', 'imagine', 'brainstorm', 'idea', 'novel', 'character', 'plot', 'narrative', 'essay', 'blog']
    const analysisKeywords = ['analyze', 'compare', 'evaluate', 'research', 'summarize', 'explain', 'breakdown', 'examine', 'assess', 'review', 'critique', 'data', 'study']

    const codeScore = codeKeywords.filter((kw) => message.includes(kw)).length
    const creativeScore = creativeKeywords.filter((kw) => message.includes(kw)).length
    const analysisScore = analysisKeywords.filter((kw) => message.includes(kw)).length

    if (codeScore > 0 || creativeScore > 0 || analysisScore > 0) {
      const maxScore = Math.max(codeScore, creativeScore, analysisScore)
      if (codeScore === maxScore) return 'code'
      if (creativeScore === maxScore) return 'creative'
      if (analysisScore === maxScore) return 'analysis'
    }
    return 'conversation'
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
