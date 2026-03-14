/**
 * PrivacyShield — Live PII detection preview shown above the message input.
 * Shows a compact warning when PII is detected in the current input text.
 */

import { memo, useEffect, useRef } from 'react'
import { usePrivacyStore } from '../stores/privacy-store'

/** Debounce delay for PII detection (ms) */
const DETECT_DELAY = 300

interface PrivacyShieldProps {
  /** Current input text to scan */
  inputText: string
}

const CATEGORY_LABELS: Record<string, string> = {
  PERSON: 'Name',
  EMAIL: 'Email',
  PHONE: 'Telefon',
  IBAN: 'IBAN',
  AHV: 'AHV-Nr.',
  ADDRESS: 'Adresse',
  LOCATION: 'Ort',
  DATE_OF_BIRTH: 'Geburtsdatum',
  AGE: 'Alter',
  IP_ADDRESS: 'IP',
  CREDIT_CARD: 'Kreditkarte',
  PASSPORT: 'Pass-Nr.',
  URL: 'URL',
  MEDICAL: 'Medizinisch'
}

export const PrivacyShield = memo(function PrivacyShield({ inputText }: PrivacyShieldProps) {
  const preview = usePrivacyStore((s) => s.preview)
  const enabled = usePrivacyStore((s) => s.enabled)
  const mode = usePrivacyStore((s) => s.mode)
  const detectPreview = usePrivacyStore((s) => s.detectPreview)
  const clearPreview = usePrivacyStore((s) => s.clearPreview)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  // Debounced PII detection on input change
  useEffect(() => {
    if (!enabled || !inputText.trim()) {
      clearPreview()
      return
    }

    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      detectPreview(inputText)
    }, DETECT_DELAY)

    return () => clearTimeout(timerRef.current)
  }, [inputText, enabled, detectPreview, clearPreview])

  if (!enabled || !preview || preview.entityCount === 0) return null

  const categoryLabels = preview.categories
    .map((c) => CATEGORY_LABELS[c] || c)
    .join(', ')

  const modeLabel =
    mode === 'shield'
      ? 'wird anonymisiert'
      : mode === 'vault'
        ? 'wird geschwärzt'
        : 'erkannt'

  return (
    <div
      className={`flex items-center gap-2 rounded-t-lg border-x border-t px-3 py-1.5 text-xs ${
        preview.hasCritical
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300'
          : 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300'
      }`}
    >
      <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
        />
      </svg>
      <span>
        <strong>{preview.entityCount}</strong> PII ({categoryLabels}) — {modeLabel}
      </span>
    </div>
  )
})
