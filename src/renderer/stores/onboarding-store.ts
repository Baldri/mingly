/**
 * Onboarding Store — manages in-app tips and feature discovery.
 *
 * Tips are shown once per feature, persisted via electronAPI so
 * they survive app restarts. Dismissing a tip marks it as seen.
 */

import { create } from 'zustand'

export interface OnboardingTip {
  id: string
  title: string
  description: string
  /** Target element data-tip attribute to anchor the tooltip */
  target: string
  /** Category for grouping tips */
  category: 'getting-started' | 'rag' | 'mcp' | 'commands' | 'advanced'
  /** Order within category (lower = shown first) */
  order: number
}

/** All discoverable in-app tips */
export const ONBOARDING_TIPS: OnboardingTip[] = [
  // Getting Started
  {
    id: 'tip-new-chat',
    title: 'Start a New Chat',
    description: 'Click the + button in the sidebar to create a new conversation with any AI provider.',
    target: 'new-chat-btn',
    category: 'getting-started',
    order: 1
  },
  {
    id: 'tip-provider-switch',
    title: 'Switch AI Providers',
    description: 'You can use Claude, GPT, Gemini, and local models — all in one app. Each conversation remembers its provider.',
    target: 'provider-select',
    category: 'getting-started',
    order: 2
  },
  {
    id: 'tip-settings',
    title: 'Configure Your API Keys',
    description: 'Open Settings to add API keys for each provider. Keys are stored encrypted on your device.',
    target: 'settings-btn',
    category: 'getting-started',
    order: 3
  },

  // RAG / Knowledge Base
  {
    id: 'tip-rag-status',
    title: 'Knowledge Base Status',
    description: 'The status bar shows your RAG server connection. When active, your documents are automatically used as context.',
    target: 'rag-status-bar',
    category: 'rag',
    order: 1
  },
  {
    id: 'tip-rag-settings',
    title: 'Set Up Knowledge Base',
    description: 'Go to Settings > Knowledge to connect your RAG server and enable automatic context injection from your documents.',
    target: 'rag-settings',
    category: 'rag',
    order: 2
  },

  // MCP Tools
  {
    id: 'tip-mcp',
    title: 'MCP Tool Servers',
    description: 'Connect external tools via the MCP protocol. Go to Settings > MCP Tools to add servers like file access, web search, and more.',
    target: 'mcp-settings',
    category: 'mcp',
    order: 1
  },

  // Commands
  {
    id: 'tip-slash-commands',
    title: 'Slash Commands',
    description: 'Type / in the message input to see available commands like /export, /compare, /template, and more.',
    target: 'message-input',
    category: 'commands',
    order: 1
  },
  {
    id: 'tip-attachments',
    title: 'Attach Files & Images',
    description: 'Click the paperclip icon or drag & drop files into the chat to share them with AI. Supports images, PDFs, and code files.',
    target: 'attachment-btn',
    category: 'commands',
    order: 2
  },

  // Advanced
  {
    id: 'tip-orchestration',
    title: 'Smart Delegation',
    description: 'Mingly can automatically route sub-tasks to the best AI model. Enable delegation in Settings for optimal results.',
    target: 'orchestration-bar',
    category: 'advanced',
    order: 1
  },
  {
    id: 'tip-analytics',
    title: 'Usage Analytics',
    description: 'Track token usage, costs, and performance across all providers in Settings > Analytics.',
    target: 'analytics-settings',
    category: 'advanced',
    order: 2
  }
]

interface OnboardingState {
  /** Tips the user has already seen */
  seenTips: Set<string>
  /** Currently displayed tip, if any */
  activeTip: OnboardingTip | null
  /** Whether the onboarding tour is running */
  isTourActive: boolean
  /** Index in the current tour */
  tourIndex: number

  // Actions
  initialize: () => Promise<void>
  showTip: (tipId: string) => void
  dismissTip: (tipId: string) => void
  startTour: (category?: OnboardingTip['category']) => void
  nextTip: () => void
  previousTip: () => void
  endTour: () => void
  resetAllTips: () => void
  getUnseenTips: (category?: OnboardingTip['category']) => OnboardingTip[]
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  seenTips: new Set<string>(),
  activeTip: null,
  isTourActive: false,
  tourIndex: 0,

  initialize: async () => {
    try {
      const settings = await window.electronAPI.settings.get()
      const tipIds = (settings as any)?.onboardingSeenTips
      const seen = Array.isArray(tipIds) ? new Set<string>(tipIds) : new Set<string>()
      set({ seenTips: seen })
    } catch {
      // First launch or no stored data
      set({ seenTips: new Set() })
    }
  },

  showTip: (tipId: string) => {
    const tip = ONBOARDING_TIPS.find(t => t.id === tipId)
    if (tip && !get().seenTips.has(tipId)) {
      set({ activeTip: tip })
    }
  },

  dismissTip: (tipId: string) => {
    const { seenTips } = get()
    const updated = new Set(seenTips)
    updated.add(tipId)
    set({ seenTips: updated, activeTip: null })

    // Persist via settings.update
    try {
      window.electronAPI.settings.update({ onboardingSeenTips: [...updated] } as any)
    } catch {
      // non-critical
    }
  },

  startTour: (category) => {
    const tips = get().getUnseenTips(category)
    if (tips.length > 0) {
      set({ isTourActive: true, tourIndex: 0, activeTip: tips[0] })
    }
  },

  nextTip: () => {
    const { tourIndex, activeTip, isTourActive } = get()
    if (!isTourActive || !activeTip) return

    // Dismiss current
    get().dismissTip(activeTip.id)

    const tips = get().getUnseenTips()
    if (tips.length > 0) {
      set({ tourIndex: tourIndex + 1, activeTip: tips[0] })
    } else {
      set({ isTourActive: false, activeTip: null, tourIndex: 0 })
    }
  },

  previousTip: () => {
    const { tourIndex } = get()
    if (tourIndex <= 0) return

    const allTips = ONBOARDING_TIPS.sort((a, b) => a.order - b.order)
    const prevIndex = Math.max(0, tourIndex - 1)
    set({ tourIndex: prevIndex, activeTip: allTips[prevIndex] })
  },

  endTour: () => {
    set({ isTourActive: false, activeTip: null, tourIndex: 0 })
  },

  resetAllTips: () => {
    set({ seenTips: new Set(), activeTip: null, isTourActive: false, tourIndex: 0 })
    try {
      window.electronAPI.settings.update({ onboardingSeenTips: [] } as any)
    } catch {
      // non-critical
    }
  },

  getUnseenTips: (category) => {
    const { seenTips } = get()
    return ONBOARDING_TIPS
      .filter(t => !seenTips.has(t.id))
      .filter(t => !category || t.category === category)
      .sort((a, b) => a.order - b.order)
  }
}))
