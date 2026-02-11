import { useState } from 'react'
import { Globe, Key, Server, Database, CheckCircle, Monitor, Wifi, ChevronRight } from 'lucide-react'
import { useTranslation } from '../utils/i18n'
import { useSettingsStore } from '../stores/settings-store'

interface SetupWizardProps {
  onComplete: () => void
}

const TOTAL_STEPS = 5

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(1)
  const [selectedMode, setSelectedMode] = useState<'standalone' | 'server' | 'hybrid'>('standalone')
  const [ragEnabled, setRagEnabled] = useState(false)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({})

  const { updateSettings, saveAPIKey } = useSettingsStore()
  const { t } = useTranslation()

  const handleNext = () => {
    if (step < TOTAL_STEPS) setStep(step + 1)
  }

  const handleBack = () => {
    if (step > 1) setStep(step - 1)
  }

  const handleSaveKey = async (provider: string) => {
    const key = apiKeys[provider]
    if (!key?.trim()) return
    const success = await saveAPIKey(provider, key.trim())
    if (success) {
      setSavedKeys((prev) => ({ ...prev, [provider]: true }))
    }
  }

  const handleFinish = async () => {
    await updateSettings({
      wizardCompleted: true,
      deploymentMode: selectedMode,
    })
    onComplete()
  }

  const handleLanguageChange = async (lang: 'de' | 'en') => {
    await updateSettings({ language: lang })
  }

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
      {/* Progress Bar */}
      <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center justify-between mb-2">
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <div key={i} className="flex items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold transition-colors ${
                    i + 1 <= step
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
                  }`}
                >
                  {i + 1 < step ? (
                    <CheckCircle className="h-5 w-5" />
                  ) : (
                    i + 1
                  )}
                </div>
                {i < TOTAL_STEPS - 1 && (
                  <div
                    className={`mx-2 h-0.5 w-12 sm:w-20 transition-colors ${
                      i + 1 < step ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Step Content */}
      <main className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="mx-auto w-full max-w-2xl">
          {step === 1 && (
            <StepWelcome
              t={t}
              onLanguageChange={handleLanguageChange}
            />
          )}
          {step === 2 && (
            <StepAPIKeys
              t={t}
              apiKeys={apiKeys}
              savedKeys={savedKeys}
              onKeyChange={(provider, value) =>
                setApiKeys((prev) => ({ ...prev, [provider]: value }))
              }
              onSaveKey={handleSaveKey}
            />
          )}
          {step === 3 && (
            <StepMode
              t={t}
              selectedMode={selectedMode}
              onModeChange={setSelectedMode}
            />
          )}
          {step === 4 && (
            <StepRAG
              t={t}
              ragEnabled={ragEnabled}
              onToggle={setRagEnabled}
            />
          )}
          {step === 5 && (
            <StepReady
              t={t}
              savedKeys={savedKeys}
              selectedMode={selectedMode}
              ragEnabled={ragEnabled}
            />
          )}
        </div>
      </main>

      {/* Navigation Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-700 px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <button
            onClick={handleBack}
            disabled={step === 1}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-0 transition-all"
          >
            {t('wizard.back')}
          </button>

          <div className="flex items-center gap-3">
            {step < TOTAL_STEPS && step !== 1 && (
              <button
                onClick={handleNext}
                className="rounded-lg px-5 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              >
                {t('wizard.skip')}
              </button>
            )}

            {step < TOTAL_STEPS ? (
              <button
                onClick={handleNext}
                className="flex items-center gap-2 rounded-lg bg-blue-500 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-600 transition-colors"
              >
                {t('wizard.next')}
                <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleFinish}
                className="rounded-lg bg-green-500 px-6 py-2.5 text-sm font-medium text-white hover:bg-green-600 transition-colors"
              >
                {t('wizard.finish')}
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}

// ── Step 1: Welcome ──────────────────────────────────────────────

function StepWelcome({
  t,
  onLanguageChange,
}: {
  t: (key: string) => string
  onLanguageChange: (lang: 'de' | 'en') => void
}) {
  const settings = useSettingsStore((s) => s.settings)
  const lang = settings?.language || 'en'

  return (
    <div className="text-center">
      {/* Logo placeholder */}
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 text-4xl font-bold text-white shadow-lg">
        M
      </div>

      <h1 className="mb-2 text-3xl font-bold">{t('wizard.welcome.title')}</h1>
      <p className="mb-4 text-lg text-gray-500 dark:text-gray-400">
        {t('wizard.welcome.subtitle')}
      </p>
      <p className="mb-8 text-gray-600 dark:text-gray-400 max-w-lg mx-auto">
        {t('wizard.welcome.description')}
      </p>

      {/* Language Toggle */}
      <div className="inline-flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-1">
        <Globe className="ml-2 h-4 w-4 text-gray-400" />
        <button
          onClick={() => onLanguageChange('en')}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            lang === 'en'
              ? 'bg-blue-500 text-white'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          English
        </button>
        <button
          onClick={() => onLanguageChange('de')}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            lang === 'de'
              ? 'bg-blue-500 text-white'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          Deutsch
        </button>
      </div>
    </div>
  )
}

// ── Step 2: API Keys ─────────────────────────────────────────────

function StepAPIKeys({
  t,
  apiKeys,
  savedKeys,
  onKeyChange,
  onSaveKey,
}: {
  t: (key: string) => string
  apiKeys: Record<string, string>
  savedKeys: Record<string, boolean>
  onKeyChange: (provider: string, value: string) => void
  onSaveKey: (provider: string) => Promise<void>
}) {
  const providers = [
    { id: 'anthropic', label: t('wizard.keys.anthropic'), icon: Key },
    { id: 'openai', label: t('wizard.keys.openai'), icon: Key },
    { id: 'google', label: t('wizard.keys.google'), icon: Key },
  ]

  return (
    <div>
      <div className="mb-6 text-center">
        <Key className="mx-auto mb-3 h-10 w-10 text-blue-500" />
        <h2 className="text-2xl font-bold">{t('wizard.keys.title')}</h2>
        <p className="mt-1 text-gray-500 dark:text-gray-400">{t('wizard.keys.subtitle')}</p>
      </div>

      <div className="space-y-4">
        {providers.map(({ id, label }) => (
          <div
            key={id}
            className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4"
          >
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">{label}</label>
              <input
                type="password"
                value={apiKeys[id] || ''}
                onChange={(e) => onKeyChange(id, e.target.value)}
                placeholder={t('wizard.keys.placeholder')}
                disabled={savedKeys[id]}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              />
            </div>
            <button
              onClick={() => onSaveKey(id)}
              disabled={!apiKeys[id]?.trim() || savedKeys[id]}
              className={`mt-5 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                savedKeys[id]
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50'
              }`}
            >
              {savedKeys[id] ? t('wizard.keys.saved') : t('wizard.keys.save')}
            </button>
          </div>
        ))}

        {/* Local model option */}
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 p-4">
          <div className="flex items-center gap-3">
            <Monitor className="h-5 w-5 text-gray-400" />
            <div>
              <p className="text-sm font-medium">{t('wizard.keys.local')}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('wizard.keys.local.description')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Step 3: Mode Selection ───────────────────────────────────────

function StepMode({
  t,
  selectedMode,
  onModeChange,
}: {
  t: (key: string) => string
  selectedMode: string
  onModeChange: (mode: 'standalone' | 'server' | 'hybrid') => void
}) {
  const modes = [
    {
      id: 'standalone' as const,
      icon: Monitor,
      label: t('wizard.mode.standalone'),
      desc: t('wizard.mode.standalone.desc'),
      recommended: true,
    },
    {
      id: 'server' as const,
      icon: Server,
      label: t('wizard.mode.server'),
      desc: t('wizard.mode.server.desc'),
      recommended: false,
    },
    {
      id: 'hybrid' as const,
      icon: Wifi,
      label: t('wizard.mode.client'),
      desc: t('wizard.mode.client.desc'),
      recommended: false,
    },
  ]

  return (
    <div>
      <div className="mb-6 text-center">
        <Server className="mx-auto mb-3 h-10 w-10 text-blue-500" />
        <h2 className="text-2xl font-bold">{t('wizard.mode.title')}</h2>
        <p className="mt-1 text-gray-500 dark:text-gray-400">{t('wizard.mode.subtitle')}</p>
      </div>

      <div className="space-y-3">
        {modes.map(({ id, icon: Icon, label, desc, recommended }) => (
          <button
            key={id}
            onClick={() => onModeChange(id)}
            className={`flex w-full items-start gap-4 rounded-lg border-2 p-4 text-left transition-all ${
              selectedMode === id
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <Icon
              className={`mt-0.5 h-6 w-6 flex-shrink-0 ${
                selectedMode === id ? 'text-blue-500' : 'text-gray-400'
              }`}
            />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{label}</span>
                {recommended && (
                  <span className="rounded-full bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                    {t('wizard.mode.recommended')}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{desc}</p>
            </div>
            <div
              className={`mt-1 h-5 w-5 flex-shrink-0 rounded-full border-2 ${
                selectedMode === id
                  ? 'border-blue-500 bg-blue-500'
                  : 'border-gray-300 dark:border-gray-600'
              }`}
            >
              {selectedMode === id && (
                <div className="flex h-full w-full items-center justify-center">
                  <div className="h-2 w-2 rounded-full bg-white" />
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Step 4: Knowledge Base ───────────────────────────────────────

function StepRAG({
  t,
  ragEnabled,
  onToggle,
}: {
  t: (key: string) => string
  ragEnabled: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div>
      <div className="mb-6 text-center">
        <Database className="mx-auto mb-3 h-10 w-10 text-blue-500" />
        <h2 className="text-2xl font-bold">{t('wizard.rag.title')}</h2>
        <p className="mt-1 text-gray-500 dark:text-gray-400">{t('wizard.rag.subtitle')}</p>
      </div>

      <p className="mb-6 text-center text-sm text-gray-600 dark:text-gray-400">
        {t('wizard.rag.description')}
      </p>

      <div className="space-y-3">
        <button
          onClick={() => onToggle(true)}
          className={`flex w-full items-center gap-4 rounded-lg border-2 p-4 text-left transition-all ${
            ragEnabled
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
          }`}
        >
          <Database className={`h-5 w-5 ${ragEnabled ? 'text-blue-500' : 'text-gray-400'}`} />
          <span className="font-medium">{t('wizard.rag.enable')}</span>
        </button>

        <button
          onClick={() => onToggle(false)}
          className={`flex w-full items-center gap-4 rounded-lg border-2 p-4 text-left transition-all ${
            !ragEnabled
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
          }`}
        >
          <ChevronRight className={`h-5 w-5 ${!ragEnabled ? 'text-blue-500' : 'text-gray-400'}`} />
          <span className="font-medium">{t('wizard.rag.disable')}</span>
        </button>
      </div>
    </div>
  )
}

// ── Step 5: Ready ────────────────────────────────────────────────

function StepReady({
  t,
  savedKeys,
  selectedMode,
  ragEnabled,
}: {
  t: (key: string) => string
  savedKeys: Record<string, boolean>
  selectedMode: string
  ragEnabled: boolean
}) {
  const configuredProviders = Object.entries(savedKeys)
    .filter(([_, saved]) => saved)
    .map(([provider]) => provider)

  return (
    <div className="text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
        <CheckCircle className="h-10 w-10 text-green-500" />
      </div>

      <h2 className="mb-2 text-2xl font-bold">{t('wizard.ready.title')}</h2>
      <p className="mb-8 text-gray-500 dark:text-gray-400">{t('wizard.ready.subtitle')}</p>

      <div className="mx-auto max-w-sm space-y-3 text-left">
        <SummaryRow
          label={t('wizard.ready.provider')}
          value={configuredProviders.length > 0 ? configuredProviders.join(', ') : 'Ollama (local)'}
        />
        <SummaryRow
          label={t('wizard.ready.mode')}
          value={selectedMode.charAt(0).toUpperCase() + selectedMode.slice(1)}
        />
        <SummaryRow
          label={t('wizard.ready.rag')}
          value={ragEnabled ? t('wizard.ready.enabled') : t('wizard.ready.disabled')}
        />
      </div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
      <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}
