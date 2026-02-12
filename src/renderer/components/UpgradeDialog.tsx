/**
 * UpgradeDialog — shows tier comparison and upgrade options.
 * Opens when a gated feature is accessed or via the settings.
 */

import React, { memo, useCallback, useMemo } from 'react'
import { useSubscriptionStore } from '../stores/subscription-store'
import type { SubscriptionTier } from '../../shared/types'

const TIER_DETAILS: Record<SubscriptionTier, {
  name: string
  price: string
  priceYearly?: string
  features: string[]
  color: string
}> = {
  free: {
    name: 'Free',
    price: 'CHF 0',
    features: [
      'Lokale Modelle (Ollama)',
      'Basis-Chat',
      '3 Konversationen / Tag',
      'Basis-RAG (lokal)'
    ],
    color: '#6b7280'
  },
  pro: {
    name: 'Pro',
    price: 'CHF 24/Mt.',
    priceYearly: 'CHF 199/Jahr',
    features: [
      'Alles in Free',
      'Cloud APIs (OpenAI, Anthropic, Google)',
      'Multimodal / Vision',
      'Prompt Templates',
      'Export (Markdown, JSON, HTML)',
      'Side-by-Side Vergleich',
      'Agenten / Orchestrator',
      'Unbegrenzte Konversationen',
      'Auto-Update'
    ],
    color: '#2563eb'
  },
  team: {
    name: 'Team',
    price: 'CHF 69/User/Mt.',
    priceYearly: 'CHF 599/User/Jahr',
    features: [
      'Alles in Pro',
      'Team-Workspaces',
      'Shared RAG',
      'Team-RBAC',
      'Usage-Tracking',
      'Audit-Logs',
      'SSO (OAuth)',
      'Min. 5 User'
    ],
    color: '#7c3aed'
  },
  enterprise: {
    name: 'Enterprise',
    price: 'Auf Anfrage',
    features: [
      'Alles in Team',
      'SSO / SAML / LDAP',
      'On-Premise Deployment',
      'Compliance Dashboard',
      'Priority SLA',
      'Custom Integrations',
      'Dedizierter Support'
    ],
    color: '#b45309'
  }
}

const FEATURE_LABELS: Record<string, string> = {
  cloud_apis: 'Cloud APIs',
  multimodal: 'Multimodal / Vision',
  export: 'Export',
  auto_update: 'Auto-Update',
  agents: 'Agenten / Orchestrator',
  templates_custom: 'Custom Templates',
  comparison: 'Side-by-Side Vergleich',
  unlimited_conversations: 'Unbegrenzte Konversationen',
  team_workspaces: 'Team-Workspaces',
  shared_rag: 'Shared RAG',
  team_rbac: 'Team-RBAC',
  usage_tracking: 'Usage-Tracking',
  audit_logs: 'Audit-Logs',
  sso_oauth: 'SSO (OAuth)',
  sso_saml_ldap: 'SSO / SAML / LDAP',
  on_premise: 'On-Premise',
  compliance_dashboard: 'Compliance Dashboard',
  priority_sla: 'Priority SLA',
  custom_integrations: 'Custom Integrations'
}

const UpgradeDialog: React.FC = () => {
  const {
    showUpgradeDialog,
    closeUpgradeDialog,
    openLicenseDialog,
    upgradePromptFeature,
    tier: currentTier,
    getCheckoutUrl
  } = useSubscriptionStore()

  const featureLabel = useMemo(() => {
    if (!upgradePromptFeature) return null
    return FEATURE_LABELS[upgradePromptFeature] || upgradePromptFeature
  }, [upgradePromptFeature])

  const handleUpgrade = useCallback(async (tier: Exclude<SubscriptionTier, 'free'>) => {
    const url = await getCheckoutUrl(tier)
    window.open(url, '_blank')
  }, [getCheckoutUrl])

  const handleEnterKey = useCallback(() => {
    closeUpgradeDialog()
    openLicenseDialog()
  }, [closeUpgradeDialog, openLicenseDialog])

  if (!showUpgradeDialog) return null

  const tiers: SubscriptionTier[] = ['free', 'pro', 'team', 'enterprise']

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: 'var(--bg-primary, #1a1a2e)', borderRadius: 16,
        padding: 32, maxWidth: 900, width: '95vw', maxHeight: '90vh', overflowY: 'auto',
        border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 25px 50px rgba(0,0,0,0.4)'
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: '#fff', margin: 0 }}>
            Upgrade dein Mingly
          </h2>
          {featureLabel && (
            <p style={{ color: '#94a3b8', marginTop: 8, fontSize: 14 }}>
              <strong style={{ color: '#f59e0b' }}>{featureLabel}</strong> ist ab dem Pro-Plan verfuegbar.
            </p>
          )}
        </div>

        {/* Tier cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          {tiers.map(tier => {
            const info = TIER_DETAILS[tier]
            const isCurrent = tier === currentTier
            const isHighlighted = tier === 'pro'

            return (
              <div key={tier} style={{
                border: `2px solid ${isCurrent ? info.color : isHighlighted ? '#2563eb' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 12, padding: 20,
                background: isCurrent ? `${info.color}15` : 'rgba(255,255,255,0.03)',
                position: 'relative'
              }}>
                {isCurrent && (
                  <div style={{
                    position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                    background: info.color, color: '#fff', fontSize: 11, fontWeight: 600,
                    padding: '2px 10px', borderRadius: 10
                  }}>
                    Aktuell
                  </div>
                )}
                {isHighlighted && !isCurrent && (
                  <div style={{
                    position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                    background: '#2563eb', color: '#fff', fontSize: 11, fontWeight: 600,
                    padding: '2px 10px', borderRadius: 10
                  }}>
                    Empfohlen
                  </div>
                )}

                <h3 style={{ color: info.color, fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
                  {info.name}
                </h3>
                <div style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>
                  {info.price}
                </div>
                {info.priceYearly && (
                  <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
                    oder {info.priceYearly}
                  </div>
                )}

                <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0' }}>
                  {info.features.map((f, i) => (
                    <li key={i} style={{
                      color: '#cbd5e1', fontSize: 12, padding: '3px 0',
                      display: 'flex', alignItems: 'flex-start', gap: 6
                    }}>
                      <span style={{ color: info.color, flexShrink: 0 }}>&#10003;</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {tier !== 'free' && tier !== currentTier && (
                  <button
                    onClick={() => handleUpgrade(tier as Exclude<SubscriptionTier, 'free'>)}
                    style={{
                      width: '100%', padding: '8px 0', borderRadius: 8, border: 'none',
                      background: tier === 'enterprise' ? 'transparent' : info.color,
                      color: tier === 'enterprise' ? info.color : '#fff',
                      fontWeight: 600, fontSize: 13, cursor: 'pointer',
                      ...(tier === 'enterprise' ? { border: `1px solid ${info.color}` } : {})
                    }}
                  >
                    {tier === 'enterprise' ? 'Kontaktieren' : 'Upgraden'}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'center', gap: 16, marginTop: 24,
          paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.1)'
        }}>
          <button
            onClick={handleEnterKey}
            style={{
              padding: '8px 20px', borderRadius: 8, border: '1px solid #2563eb',
              background: 'transparent', color: '#2563eb', fontWeight: 600,
              fontSize: 13, cursor: 'pointer'
            }}
          >
            Lizenzschluessel eingeben
          </button>
          <button
            onClick={closeUpgradeDialog}
            style={{
              padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent', color: '#94a3b8', fontWeight: 500,
              fontSize: 13, cursor: 'pointer'
            }}
          >
            Schliessen
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(UpgradeDialog)
