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

  const tierColors: Record<string, string> = {
    free: '#6b7280', pro: '#2563eb', team: '#7c3aed', enterprise: '#b45309'
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1001,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: 'var(--bg-primary, #1a1a2e)', borderRadius: 16,
        padding: 32, maxWidth: 480, width: '90vw',
        border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 25px 50px rgba(0,0,0,0.4)'
      }} onKeyDown={handleKeyDown}>

        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff', margin: '0 0 8px' }}>
          Lizenz aktivieren
        </h2>
        <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 20px' }}>
          Gib deinen Lizenzschluessel ein, den du nach dem Kauf per E-Mail erhalten hast.
        </p>

        {/* Current tier badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20,
          padding: '8px 12px', borderRadius: 8,
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <span style={{ color: '#94a3b8', fontSize: 12 }}>Aktueller Plan:</span>
          <span style={{
            background: tierColors[tier] || '#6b7280', color: '#fff',
            padding: '2px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600
          }}>
            {tier.charAt(0).toUpperCase() + tier.slice(1)}
          </span>
          {license && (
            <span style={{ color: '#64748b', fontSize: 11, marginLeft: 'auto' }}>
              {license.validated ? 'Online validiert' : 'Offline-Modus'}
            </span>
          )}
        </div>

        {/* License key input */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>
            Lizenzschluessel
          </label>
          <input
            type="text"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="MINGLY-PRO-XXXXXXXX-XXXX"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.05)',
              color: '#fff', fontSize: 14, fontFamily: 'monospace',
              outline: 'none', boxSizing: 'border-box',
              textTransform: 'uppercase', letterSpacing: 1
            }}
            disabled={isLoading}
            autoFocus
          />
        </div>

        {/* Email (optional) */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>
            E-Mail (optional)
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="deine@email.ch"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.05)',
              color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box'
            }}
            disabled={isLoading}
          />
        </div>

        {/* Error / Success messages */}
        {localError && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 16,
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            color: '#f87171', fontSize: 13
          }}>
            {localError}
          </div>
        )}
        {successMessage && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 16,
            background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
            color: '#4ade80', fontSize: 13
          }}>
            {successMessage}
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleActivate}
            disabled={isLoading || !key.trim()}
            style={{
              flex: 1, padding: '10px 0', borderRadius: 8, border: 'none',
              background: isLoading || !key.trim() ? '#374151' : '#2563eb',
              color: '#fff', fontWeight: 600, fontSize: 14, cursor: isLoading ? 'wait' : 'pointer'
            }}
          >
            {isLoading ? 'Aktiviere...' : 'Aktivieren'}
          </button>

          {license && (
            <button
              onClick={handleDeactivate}
              disabled={isLoading}
              style={{
                padding: '10px 16px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)',
                background: 'transparent', color: '#f87171', fontWeight: 500,
                fontSize: 13, cursor: 'pointer'
              }}
            >
              Deaktivieren
            </button>
          )}

          <button
            onClick={closeLicenseDialog}
            style={{
              padding: '10px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent', color: '#94a3b8', fontWeight: 500,
              fontSize: 13, cursor: 'pointer'
            }}
          >
            Schliessen
          </button>
        </div>

        {/* Help text */}
        <p style={{ color: '#475569', fontSize: 11, marginTop: 16, textAlign: 'center' }}>
          Noch keinen Schluessel? Kaufe ein Upgrade auf mingly.ch/pricing
        </p>
      </div>
    </div>
  )
}

export default memo(LicenseKeyDialog)
