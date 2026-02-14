/**
 * RoutingModeToggle — mini icon in the chat header.
 * Toggles between "manual" (user picks model) and "auto" (Gemma routes).
 */

import { useState, useEffect } from 'react'
import { User, Sparkles } from 'lucide-react'
import { useSettingsStore } from '../stores/settings-store'

export function RoutingModeToggle() {
  const { settings, updateSettings } = useSettingsStore()
  const [mode, setMode] = useState<'manual' | 'auto'>(settings?.routingMode || 'manual')

  useEffect(() => {
    if (settings?.routingMode) {
      setMode(settings.routingMode)
    }
  }, [settings?.routingMode])

  const toggle = () => {
    const next = mode === 'manual' ? 'auto' : 'manual'
    setMode(next)
    updateSettings({ routingMode: next })
  }

  const isAuto = mode === 'auto'

  return (
    <button
      onClick={toggle}
      title={isAuto ? 'KI entscheidet (Auto-Routing)' : 'Lass mich wählen (Manual)'}
      className={`p-1.5 rounded-md transition-colors ${
        isAuto
          ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-900/50'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300'
      }`}
    >
      {isAuto ? <Sparkles size={16} /> : <User size={16} />}
    </button>
  )
}
