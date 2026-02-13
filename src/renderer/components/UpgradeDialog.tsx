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
  colorClass: string
  borderClass: string
  bgActiveClass: string
  badgeBgClass: string
  checkColorClass: string
  btnClass: string
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
    colorClass: 'text-gray-500',
    borderClass: 'border-gray-500',
    bgActiveClass: 'bg-gray-500/10',
    badgeBgClass: 'bg-gray-500',
    checkColorClass: 'text-gray-500',
    btnClass: ''
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
    colorClass: 'text-blue-600',
    borderClass: 'border-blue-600',
    bgActiveClass: 'bg-blue-600/10',
    badgeBgClass: 'bg-blue-600',
    checkColorClass: 'text-blue-600',
    btnClass: 'bg-blue-600 hover:bg-blue-700 text-white'
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
    colorClass: 'text-purple-600',
    borderClass: 'border-purple-600',
    bgActiveClass: 'bg-purple-600/10',
    badgeBgClass: 'bg-purple-600',
    checkColorClass: 'text-purple-600',
    btnClass: 'bg-purple-600 hover:bg-purple-700 text-white'
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
    colorClass: 'text-amber-700',
    borderClass: 'border-amber-700',
    bgActiveClass: 'bg-amber-700/10',
    badgeBgClass: 'bg-amber-700',
    checkColorClass: 'text-amber-700',
    btnClass: 'border border-amber-700 text-amber-700 bg-transparent hover:bg-amber-700/10'
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
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1a2e] rounded-2xl p-8 max-w-[900px] w-[95vw] max-h-[90vh] overflow-y-auto border border-white/10 shadow-2xl">
        {/* Header */}
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-white m-0">
            Upgrade dein Mingly
          </h2>
          {featureLabel && (
            <p className="text-slate-400 mt-2 text-sm">
              <strong className="text-amber-500">{featureLabel}</strong> ist ab dem Pro-Plan verfuegbar.
            </p>
          )}
        </div>

        {/* Tier cards */}
        <div className="grid grid-cols-4 gap-4">
          {tiers.map(tier => {
            const info = TIER_DETAILS[tier]
            const isCurrent = tier === currentTier
            const isHighlighted = tier === 'pro'

            return (
              <div
                key={tier}
                className={`rounded-xl p-5 relative border-2 ${
                  isCurrent
                    ? `${info.borderClass} ${info.bgActiveClass}`
                    : isHighlighted
                      ? 'border-blue-600 bg-white/[0.03]'
                      : 'border-white/10 bg-white/[0.03]'
                }`}
              >
                {isCurrent && (
                  <div className={`absolute -top-2.5 left-1/2 -translate-x-1/2 ${info.badgeBgClass} text-white text-[11px] font-semibold px-2.5 py-0.5 rounded-full`}>
                    Aktuell
                  </div>
                )}
                {isHighlighted && !isCurrent && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[11px] font-semibold px-2.5 py-0.5 rounded-full">
                    Empfohlen
                  </div>
                )}

                <h3 className={`${info.colorClass} text-lg font-bold mb-1`}>
                  {info.name}
                </h3>
                <div className="text-white text-xl font-bold mb-1">
                  {info.price}
                </div>
                {info.priceYearly && (
                  <div className="text-slate-500 text-xs mb-3">
                    oder {info.priceYearly}
                  </div>
                )}

                <ul className="list-none p-0 my-3 space-y-1">
                  {info.features.map((f, i) => (
                    <li key={i} className="text-slate-300 text-xs py-0.5 flex items-start gap-1.5">
                      <span className={`${info.checkColorClass} shrink-0`}>&#10003;</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {tier !== 'free' && tier !== currentTier && (
                  <button
                    onClick={() => handleUpgrade(tier as Exclude<SubscriptionTier, 'free'>)}
                    className={`w-full py-2 rounded-lg border-none font-semibold text-[13px] cursor-pointer transition-colors ${info.btnClass}`}
                  >
                    {tier === 'enterprise' ? 'Kontaktieren' : 'Upgraden'}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex justify-center gap-4 mt-6 pt-4 border-t border-white/10">
          <button
            onClick={handleEnterKey}
            className="px-5 py-2 rounded-lg border border-blue-600 bg-transparent text-blue-600 font-semibold text-[13px] cursor-pointer hover:bg-blue-600/10 transition-colors"
          >
            Lizenzschluessel eingeben
          </button>
          <button
            onClick={closeUpgradeDialog}
            className="px-5 py-2 rounded-lg border border-white/20 bg-transparent text-slate-400 font-medium text-[13px] cursor-pointer hover:bg-white/5 transition-colors"
          >
            Schliessen
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(UpgradeDialog)
