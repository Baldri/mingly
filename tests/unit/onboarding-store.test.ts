/**
 * Onboarding Store — Tests for tip management and tour flow
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electronAPI — the store uses settings.get() (no args) and settings.update()
const mockElectronAPI = {
  settings: {
    get: vi.fn(),
    set: vi.fn(),
    update: vi.fn()
  }
}

vi.stubGlobal('window', { electronAPI: mockElectronAPI })

const { useOnboardingStore, ONBOARDING_TIPS } = await import('../../src/renderer/stores/onboarding-store')

describe('OnboardingStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOnboardingStore.setState({
      seenTips: new Set(),
      activeTip: null,
      isTourActive: false,
      tourIndex: 0
    })
  })

  describe('ONBOARDING_TIPS', () => {
    it('should have at least 10 tips defined', () => {
      expect(ONBOARDING_TIPS.length).toBeGreaterThanOrEqual(10)
    })

    it('should have unique IDs for all tips', () => {
      const ids = ONBOARDING_TIPS.map(t => t.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('should cover all categories', () => {
      const categories = new Set(ONBOARDING_TIPS.map(t => t.category))
      expect(categories.has('getting-started')).toBe(true)
      expect(categories.has('rag')).toBe(true)
      expect(categories.has('mcp')).toBe(true)
      expect(categories.has('commands')).toBe(true)
      expect(categories.has('advanced')).toBe(true)
    })

    it('should have required fields on every tip', () => {
      for (const tip of ONBOARDING_TIPS) {
        expect(tip.id).toBeTruthy()
        expect(tip.title).toBeTruthy()
        expect(tip.description).toBeTruthy()
        expect(tip.target).toBeTruthy()
        expect(typeof tip.order).toBe('number')
      }
    })
  })

  describe('initialize', () => {
    it('should load seen tips from storage', async () => {
      mockElectronAPI.settings.get.mockResolvedValue({ onboardingSeenTips: ['tip-new-chat', 'tip-settings'] })

      await useOnboardingStore.getState().initialize()

      const { seenTips } = useOnboardingStore.getState()
      expect(seenTips.has('tip-new-chat')).toBe(true)
      expect(seenTips.has('tip-settings')).toBe(true)
      expect(seenTips.has('tip-rag-status')).toBe(false)
    })

    it('should handle missing storage gracefully', async () => {
      mockElectronAPI.settings.get.mockRejectedValue(new Error('not found'))

      await useOnboardingStore.getState().initialize()

      expect(useOnboardingStore.getState().seenTips.size).toBe(0)
    })
  })

  describe('showTip', () => {
    it('should show an unseen tip', () => {
      useOnboardingStore.getState().showTip('tip-new-chat')

      const tip = useOnboardingStore.getState().activeTip
      expect(tip).not.toBeNull()
      expect(tip?.id).toBe('tip-new-chat')
    })

    it('should not show a seen tip', () => {
      useOnboardingStore.setState({ seenTips: new Set(['tip-new-chat']) })

      useOnboardingStore.getState().showTip('tip-new-chat')

      expect(useOnboardingStore.getState().activeTip).toBeNull()
    })

    it('should not show a non-existent tip', () => {
      useOnboardingStore.getState().showTip('non-existent')
      expect(useOnboardingStore.getState().activeTip).toBeNull()
    })
  })

  describe('dismissTip', () => {
    it('should mark tip as seen and clear active', () => {
      useOnboardingStore.getState().showTip('tip-new-chat')
      expect(useOnboardingStore.getState().activeTip).not.toBeNull()

      useOnboardingStore.getState().dismissTip('tip-new-chat')

      expect(useOnboardingStore.getState().activeTip).toBeNull()
      expect(useOnboardingStore.getState().seenTips.has('tip-new-chat')).toBe(true)
    })

    it('should persist seen tips to storage', () => {
      useOnboardingStore.getState().dismissTip('tip-new-chat')

      expect(mockElectronAPI.settings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          onboardingSeenTips: expect.arrayContaining(['tip-new-chat'])
        })
      )
    })
  })

  describe('tour flow', () => {
    it('should start tour with unseen tips', () => {
      useOnboardingStore.getState().startTour()

      const state = useOnboardingStore.getState()
      expect(state.isTourActive).toBe(true)
      expect(state.activeTip).not.toBeNull()
      expect(state.tourIndex).toBe(0)
    })

    it('should not start tour when all tips seen', () => {
      const allSeen = new Set(ONBOARDING_TIPS.map(t => t.id))
      useOnboardingStore.setState({ seenTips: allSeen })

      useOnboardingStore.getState().startTour()

      expect(useOnboardingStore.getState().isTourActive).toBe(false)
    })

    it('should advance to next tip', () => {
      useOnboardingStore.getState().startTour()
      const firstTip = useOnboardingStore.getState().activeTip

      useOnboardingStore.getState().nextTip()

      const secondTip = useOnboardingStore.getState().activeTip
      // Second tip should be different (first was dismissed)
      expect(secondTip?.id).not.toBe(firstTip?.id)
    })

    it('should end tour', () => {
      useOnboardingStore.getState().startTour()
      expect(useOnboardingStore.getState().isTourActive).toBe(true)

      useOnboardingStore.getState().endTour()

      expect(useOnboardingStore.getState().isTourActive).toBe(false)
      expect(useOnboardingStore.getState().activeTip).toBeNull()
    })

    it('should filter tour by category', () => {
      useOnboardingStore.getState().startTour('rag')

      const tip = useOnboardingStore.getState().activeTip
      expect(tip?.category).toBe('rag')
    })
  })

  describe('getUnseenTips', () => {
    it('should return all tips when none seen', () => {
      const unseen = useOnboardingStore.getState().getUnseenTips()
      expect(unseen.length).toBe(ONBOARDING_TIPS.length)
    })

    it('should exclude seen tips', () => {
      useOnboardingStore.setState({ seenTips: new Set(['tip-new-chat', 'tip-settings']) })

      const unseen = useOnboardingStore.getState().getUnseenTips()
      expect(unseen.length).toBe(ONBOARDING_TIPS.length - 2)
      expect(unseen.find(t => t.id === 'tip-new-chat')).toBeUndefined()
    })

    it('should filter by category', () => {
      const ragTips = useOnboardingStore.getState().getUnseenTips('rag')
      expect(ragTips.every(t => t.category === 'rag')).toBe(true)
    })

    it('should return tips sorted by order', () => {
      const tips = useOnboardingStore.getState().getUnseenTips('getting-started')
      for (let i = 1; i < tips.length; i++) {
        expect(tips[i].order).toBeGreaterThanOrEqual(tips[i - 1].order)
      }
    })
  })

  describe('resetAllTips', () => {
    it('should clear all seen tips', () => {
      useOnboardingStore.setState({
        seenTips: new Set(['tip-new-chat', 'tip-settings']),
        isTourActive: true,
        activeTip: ONBOARDING_TIPS[0]
      })

      useOnboardingStore.getState().resetAllTips()

      const state = useOnboardingStore.getState()
      expect(state.seenTips.size).toBe(0)
      expect(state.activeTip).toBeNull()
      expect(state.isTourActive).toBe(false)
    })

    it('should persist empty array to storage', () => {
      useOnboardingStore.getState().resetAllTips()

      expect(mockElectronAPI.settings.update).toHaveBeenCalledWith(
        expect.objectContaining({ onboardingSeenTips: [] })
      )
    })
  })
})
