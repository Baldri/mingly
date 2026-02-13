/**
 * OnboardingTooltip — shows contextual tips anchored near UI elements.
 * Lightweight: no external dependencies, pure CSS animations.
 */
import { memo, useCallback, useEffect } from 'react'
import { X, ChevronRight, Lightbulb } from 'lucide-react'
import { useOnboardingStore } from '../stores/onboarding-store'

export const OnboardingTooltip = memo(function OnboardingTooltip() {
  const activeTip = useOnboardingStore((s) => s.activeTip)
  const isTourActive = useOnboardingStore((s) => s.isTourActive)
  const dismissTip = useOnboardingStore((s) => s.dismissTip)
  const nextTip = useOnboardingStore((s) => s.nextTip)
  const endTour = useOnboardingStore((s) => s.endTour)
  const getUnseenTips = useOnboardingStore((s) => s.getUnseenTips)

  const handleDismiss = useCallback(() => {
    if (activeTip) {
      if (isTourActive) {
        endTour()
      }
      dismissTip(activeTip.id)
    }
  }, [activeTip, isTourActive, dismissTip, endTour])

  const handleNext = useCallback(() => {
    nextTip()
  }, [nextTip])

  // Keyboard shortcuts
  useEffect(() => {
    if (!activeTip) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDismiss()
      if (e.key === 'Enter' || e.key === 'ArrowRight') handleNext()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeTip, handleDismiss, handleNext])

  if (!activeTip) return null

  const unseenCount = getUnseenTips().length

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* Semi-transparent backdrop */}
      <div
        className="absolute inset-0 bg-black/20 pointer-events-auto"
        onClick={handleDismiss}
      />

      {/* Tooltip card */}
      <div className="absolute bottom-24 right-6 pointer-events-auto animate-in slide-in-from-bottom-4 fade-in duration-300">
        <div className="w-80 rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
          {/* Header */}
          <div className="flex items-start gap-3 px-4 pt-4 pb-2">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
              <Lightbulb size={16} className="text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                {activeTip.title}
              </h4>
              <span className="text-[10px] font-medium uppercase tracking-wider text-blue-500 dark:text-blue-400">
                {activeTip.category.replace('-', ' ')}
              </span>
            </div>
            <button
              onClick={handleDismiss}
              className="flex-shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            >
              <X size={14} />
            </button>
          </div>

          {/* Body */}
          <p className="px-4 pb-3 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
            {activeTip.description}
          </p>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5 dark:border-gray-700">
            {isTourActive ? (
              <>
                <span className="text-[10px] text-gray-400">
                  {unseenCount} tip{unseenCount !== 1 ? 's' : ''} remaining
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleDismiss}
                    className="rounded-md px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Skip All
                  </button>
                  <button
                    onClick={handleNext}
                    className="flex items-center gap-1 rounded-md bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600"
                  >
                    Next
                    <ChevronRight size={12} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-[10px] text-gray-400">
                  Tip {ONBOARDING_TIPS_COUNT - unseenCount} of {ONBOARDING_TIPS_COUNT}
                </span>
                <button
                  onClick={handleDismiss}
                  className="rounded-md bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600"
                >
                  Got it
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

// Keep constant to avoid re-renders
import { ONBOARDING_TIPS } from '../stores/onboarding-store'
const ONBOARDING_TIPS_COUNT = ONBOARDING_TIPS.length

/**
 * TourStartButton — floating button to start the onboarding tour.
 * Only visible when there are unseen tips.
 */
export const TourStartButton = memo(function TourStartButton() {
  const startTour = useOnboardingStore((s) => s.startTour)
  const getUnseenTips = useOnboardingStore((s) => s.getUnseenTips)
  const activeTip = useOnboardingStore((s) => s.activeTip)
  const initialize = useOnboardingStore((s) => s.initialize)

  useEffect(() => {
    initialize()
  }, [initialize])

  const unseenCount = getUnseenTips().length

  // Don't show if no unseen tips or if a tip is already showing
  if (unseenCount === 0 || activeTip) return null

  return (
    <button
      onClick={() => startTour()}
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-blue-500 px-4 py-2 text-xs font-medium text-white shadow-lg hover:bg-blue-600 transition-all hover:scale-105"
      title="Start onboarding tour"
    >
      <Lightbulb size={14} />
      <span>{unseenCount} tip{unseenCount !== 1 ? 's' : ''}</span>
    </button>
  )
})
