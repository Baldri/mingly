/**
 * LicenseKeyDialog — allows user to enter a license key to activate a tier.
 */

import React, { memo, useCallback, useState } from 'react'
import { useSubscriptionStore } from '../stores/subscription-store'

const LicenseKeyDialog: React.FC = () => {
  const {
    showLicenseDialog,
    closeLicenseDialog,
    activateLicense,
    deactivateLicense,
    license,
    tier,
    isLoading
  } = useSubscriptionStore()

  const [key, setKey] = useState('')
  const [email, setEmail] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const handleActivate = useCallback(async () => {
    if (!key.trim()) {
      setLocalError('Bitte Lizenzschluessel eingeben')
      return
    }

    setLocalError(null)
    setSuccessMessage(null)

    const result = await activateLicense(key.trim(), email.trim() || undefined)
    if (result.valid) {
      setSuccessMessage('Lizenz erfolgreich aktiviert!')
      setKey('')
      setEmail('')
    } else {
      setLocalError(result.error || 'Aktivierung fehlgeschlagen')
    }
  }, [key, email, activateLicense])

  const handleDeactivate = useCallback(async () => {
    await deactivateLicense()
    setSuccessMessage(null)
    setLocalError(null)
  }, [deactivateLicense])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleActivate()
    }
    if (e.key === 'Escape') {
      closeLicenseDialog()
    }
  }, [handleActivate, isLoading, closeLicenseDialog])

  if (!showLicenseDialog) return null

  const tierBgClass: Record<string, string> = {
    free: 'bg-gray-500',
    pro: 'bg-blue-600',
    team: 'bg-purple-600',
    enterprise: 'bg-amber-700'
  }

  return (
    <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="rounded-2xl bg-[#1a1a2e] p-8 max-w-[480px] w-[90vw] border border-white/10 shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-xl font-bold text-white mb-2">
          Lizenz aktivieren
        </h2>
        <p className="text-slate-400 text-[13px] mb-5">
          Gib deinen Lizenzschluessel ein, den du nach dem Kauf per E-Mail erhalten hast.
        </p>

        {/* Current tier badge */}
        <div className="flex items-center gap-2 mb-5 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
          <span className="text-slate-400 text-xs">Aktueller Plan:</span>
          <span className={`${tierBgClass[tier] || 'bg-gray-500'} text-white px-2.5 py-0.5 rounded-full text-xs font-semibold`}>
            {tier.charAt(0).toUpperCase() + tier.slice(1)}
          </span>
          {license && (
            <span className="text-slate-500 text-[11px] ml-auto">
              {license.validated ? 'Online validiert' : 'Offline-Modus'}
            </span>
          )}
        </div>

        {/* License key input */}
        <div className="mb-3">
          <label className="block text-slate-400 text-xs mb-1">
            Lizenzschluessel
          </label>
          <input
            type="text"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="MINGLY-PRO-XXXXXXXX-XXXX"
            className="w-full px-3 py-2.5 rounded-lg border border-white/20 bg-white/5 text-white text-sm font-mono uppercase tracking-wider outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            disabled={isLoading}
            autoFocus
          />
        </div>

        {/* Email (optional) */}
        <div className="mb-5">
          <label className="block text-slate-400 text-xs mb-1">
            E-Mail (optional)
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="deine@email.ch"
            className="w-full px-3 py-2.5 rounded-lg border border-white/20 bg-white/5 text-white text-sm outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            disabled={isLoading}
          />
        </div>

        {/* Error / Success messages */}
        {localError && (
          <div className="px-3 py-2 rounded-lg mb-4 bg-red-500/10 border border-red-500/30 text-red-400 text-[13px]">
            {localError}
          </div>
        )}
        {successMessage && (
          <div className="px-3 py-2 rounded-lg mb-4 bg-green-500/10 border border-green-500/30 text-green-400 text-[13px]">
            {successMessage}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2.5">
          <button
            onClick={handleActivate}
            disabled={isLoading || !key.trim()}
            className="flex-1 py-2.5 rounded-lg border-none font-semibold text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {isLoading ? 'Aktiviere...' : 'Aktivieren'}
          </button>

          {license && (
            <button
              onClick={handleDeactivate}
              disabled={isLoading}
              className="px-4 py-2.5 rounded-lg border border-red-500/40 bg-transparent text-red-400 font-medium text-[13px] cursor-pointer hover:bg-red-500/10 transition-colors"
            >
              Deaktivieren
            </button>
          )}

          <button
            onClick={closeLicenseDialog}
            className="px-4 py-2.5 rounded-lg border border-white/20 bg-transparent text-slate-400 font-medium text-[13px] cursor-pointer hover:bg-white/5 transition-colors"
          >
            Schliessen
          </button>
        </div>

        {/* Help text */}
        <p className="text-slate-600 text-[11px] mt-4 text-center">
          Noch keinen Schluessel? Kaufe ein Upgrade auf mingly.ch/pricing
        </p>
      </div>
    </div>
  )
}

export default memo(LicenseKeyDialog)
