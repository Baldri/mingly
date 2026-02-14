import { useState, useCallback, useEffect } from 'react'
import { Globe, Key, Server, Database, CheckCircle, Monitor, Wifi, ChevronRight, Search, Cpu, Loader2, FolderOpen, HardDrive, CheckCircle2 } from 'lucide-react'
import { useTranslation } from '../utils/i18n'
import { useSettingsStore } from '../stores/settings-store'
import { useSubscriptionStore } from '../stores/subscription-store'

interface SetupWizardProps {
  onComplete: () => void
}

interface DiscoveredModel {
  source: string
  name: string
  size?: number
  modified?: string
  id: string
  port: number
}

const TOTAL_STEPS = 6

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(1)
  const [selectedMode, setSelectedMode] = useState<'standalone' | 'server' | 'hybrid'>('standalone')
  const [ragEnabled, setRagEnabled] = useState(false)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({})
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [ragDirectory, setRagDirectory] = useState<string | null>(null)

  const { updateSettings, saveAPIKey } = useSettingsStore()
  const { t } = useTranslation()

  const handleNext = useCallback(() => {
    setStep(s => Math.min(s + 1, TOTAL_STEPS))
  }, [])

  const handleBack = useCallback(() => {
    setStep(s => Math.max(s - 1, 1))
  }, [])

  const handleSaveKey = useCallback(async (provider: string) => {
    const key = apiKeys[provider]
    if (!key?.trim()) return
    const success = await saveAPIKey(provider, key.trim())
    if (success) {
      setSavedKeys((prev) => ({ ...prev, [provider]: true }))
    }
  }, [apiKeys, saveAPIKey])

  const tier = useSubscriptionStore((s) => s.tier)

  const handleFinish = useCallback(async () => {
    // Register selected local models
    for (const modelId of selectedModels) {
      try {
        await window.electronAPI.localLLM.selectModel(modelId)
      } catch (err) {
        console.warn('Failed to register local model:', modelId, err)
      }
    }

    // RAG setup depends on tier:
    // - Free: only file access (no vector DB context injection)
    // - Pro+: enable full RAG context injection with vector DB
    if (ragEnabled && tier !== 'free') {
      try {
        await window.electronAPI.ragContext.updateConfig({ enabled: true })
      } catch (err) {
        console.warn('Failed to enable RAG context injection:', err)
      }
    }

    await updateSettings({
      wizardCompleted: true,
      deploymentMode: selectedMode,
      ragEnabled,
    })
    onComplete()
  }, [selectedMode, selectedModels, ragEnabled, tier, updateSettings, onComplete])

  const handleLanguageChange = useCallback(async (lang: 'de' | 'en') => {
    await updateSettings({ language: lang })
  }, [updateSettings])

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
                    className={`mx-2 h-0.5 w-8 sm:w-14 transition-colors ${
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
            <StepLocalModels
              t={t}
              selectedModels={selectedModels}
              onSelectionChange={setSelectedModels}
            />
          )}
          {step === 4 && (
            <StepMode
              t={t}
              selectedMode={selectedMode}
              onModeChange={setSelectedMode}
            />
          )}
          {step === 5 && (
            <StepRAG
              t={t}
              ragEnabled={ragEnabled}
              onToggle={setRagEnabled}
              ragDirectory={ragDirectory}
              onDirectoryChange={setRagDirectory}
            />
          )}
          {step === 6 && (
            <StepReady
              t={t}
              savedKeys={savedKeys}
              selectedMode={selectedMode}
              ragEnabled={ragEnabled}
              selectedModels={selectedModels}
              ragDirectory={ragDirectory}
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

        {/* Local model hint */}
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

// ── Step 3: Local LLM Discovery ─────────────────────────────────

const SOURCE_BADGES: Record<string, { label: string; color: string }> = {
  ollama: { label: 'Ollama', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  'lm-studio': { label: 'LM Studio', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  vllm: { label: 'vLLM', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
  localai: { label: 'LocalAI', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  'text-gen-webui': { label: 'Text Gen WebUI', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
  llamacpp: { label: 'llama.cpp', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
}

function StepLocalModels({
  t,
  selectedModels,
  onSelectionChange,
}: {
  t: (key: string) => string
  selectedModels: string[]
  onSelectionChange: (models: string[]) => void
}) {
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [isScanning, setIsScanning] = useState(true)
  const tier = useSubscriptionStore((s) => s.tier)
  const isFree = tier === 'free'

  useEffect(() => {
    let cancelled = false
    async function scan() {
      setIsScanning(true)
      try {
        const result = await window.electronAPI.localLLM.discover()
        if (!cancelled && result.success) {
          setModels(result.models)
        }
      } catch (err) {
        console.warn('Local LLM discovery failed:', err)
      } finally {
        if (!cancelled) setIsScanning(false)
      }
    }
    scan()
    return () => { cancelled = true }
  }, [])

  const handleToggle = useCallback((modelId: string) => {
    const isSelected = selectedModels.includes(modelId)
    if (isSelected) {
      onSelectionChange(selectedModels.filter(id => id !== modelId))
    } else if (isFree) {
      // Free tier: only 1 model allowed — replace selection
      onSelectionChange([modelId])
    } else {
      onSelectionChange([...selectedModels, modelId])
    }
  }, [isFree, selectedModels, onSelectionChange])

  // Group models by source
  const grouped = models.reduce<Record<string, DiscoveredModel[]>>((acc, m) => {
    if (!acc[m.source]) acc[m.source] = []
    acc[m.source].push(m)
    return acc
  }, {})

  const formatSize = (bytes?: number) => {
    if (!bytes) return null
    const gb = bytes / (1024 * 1024 * 1024)
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  }

  return (
    <div>
      <div className="mb-6 text-center">
        <Search className="mx-auto mb-3 h-10 w-10 text-blue-500" />
        <h2 className="text-2xl font-bold">{t('wizard.localLLM.title')}</h2>
        <p className="mt-1 text-gray-500 dark:text-gray-400">{t('wizard.localLLM.subtitle')}</p>
      </div>

      {isScanning ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('wizard.localLLM.scanning')}</p>
        </div>
      ) : models.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 p-8 text-center">
          <Cpu className="mx-auto mb-3 h-10 w-10 text-gray-300 dark:text-gray-600" />
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
            {t('wizard.localLLM.none')}
          </p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {t('wizard.localLLM.noneHint')}
          </p>
        </div>
      ) : (
        <>
          {/* Tier hint */}
          <div className="mb-4 rounded-md bg-gray-50 dark:bg-gray-800/50 px-4 py-2.5 text-center text-xs text-gray-500 dark:text-gray-400">
            {isFree ? t('wizard.localLLM.freeLimit') : t('wizard.localLLM.proRouting')}
          </div>

          <div className="space-y-4 max-h-80 overflow-y-auto">
            {Object.entries(grouped).map(([source, sourceModels]) => (
              <div key={source}>
                {/* Source header badge */}
                <div className="mb-2 flex items-center gap-2">
                  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${SOURCE_BADGES[source]?.color || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}>
                    {SOURCE_BADGES[source]?.label || source}
                  </span>
                  <span className="text-xs text-gray-400">:{sourceModels[0].port}</span>
                </div>

                <div className="space-y-2">
                  {sourceModels.map((model) => {
                    const isSelected = selectedModels.includes(model.id)
                    return (
                      <button
                        key={model.id}
                        onClick={() => handleToggle(model.id)}
                        className={`flex w-full items-center gap-3 rounded-lg border-2 px-4 py-3 text-left transition-all ${
                          isSelected
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        <Cpu className={`h-5 w-5 flex-shrink-0 ${isSelected ? 'text-blue-500' : 'text-gray-400'}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{model.name}</p>
                          {model.size && (
                            <p className="text-xs text-gray-400">{formatSize(model.size)}</p>
                          )}
                        </div>
                        <span className={`text-xs font-medium ${isSelected ? 'text-blue-500' : 'text-gray-400'}`}>
                          {isSelected ? t('wizard.localLLM.selected') : t('wizard.localLLM.select')}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Step 4: Mode Selection ───────────────────────────────────────

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

// ── Step 5: Knowledge Base ───────────────────────────────────────

interface RAGStatus {
  qdrantOnline: boolean
  wissenOnline: boolean
  collections: Array<{ name: string; points_count?: number }>
  loading: boolean
}

function StepRAG({
  t,
  ragEnabled,
  onToggle,
  ragDirectory,
  onDirectoryChange,
}: {
  t: (key: string) => string
  ragEnabled: boolean
  onToggle: (enabled: boolean) => void
  ragDirectory: string | null
  onDirectoryChange: (dir: string | null) => void
}) {
  const tier = useSubscriptionStore((s) => s.tier)
  const isFree = tier === 'free'
  const ragServerName = useSettingsStore((s) => s.settings?.ragServerName) || 'RAG-Wissen'

  const [status, setStatus] = useState<RAGStatus>({
    qdrantOnline: false,
    wissenOnline: false,
    collections: [],
    loading: !isFree, // Free tier skips RAG detection
  })

  // Auto-detect existing RAG infrastructure on mount (Pro+ only)
  useEffect(() => {
    if (isFree) return
    let cancelled = false
    async function detect() {
      const result: RAGStatus = {
        qdrantOnline: false,
        wissenOnline: false,
        collections: [],
        loading: false,
      }

      const checks = await Promise.allSettled([
        window.electronAPI.ragHttp.health(),
        window.electronAPI.ragWissen.health(),
        window.electronAPI.ragHttp.listCollections(),
      ])

      if (cancelled) return

      if (checks[0].status === 'fulfilled' && checks[0].value.success) {
        result.qdrantOnline = true
      }
      if (checks[1].status === 'fulfilled' && checks[1].value.success) {
        result.wissenOnline = true
      }
      if (checks[2].status === 'fulfilled' && checks[2].value.success && checks[2].value.collections) {
        result.collections = checks[2].value.collections
      }

      setStatus(result)

      // Auto-enable if RAG is already configured with collections
      if (result.collections.length > 0 || result.wissenOnline) {
        onToggle(true)
      }
    }
    detect()
    return () => { cancelled = true }
  }, [isFree]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDirectory = async () => {
    try {
      const result = await window.electronAPI.fileAccess.requestDirectory(['read'])
      if (result.success && result.directory) {
        onDirectoryChange(result.directory)
        onToggle(true)
      }
    } catch (err) {
      console.warn('Directory selection failed:', err)
    }
  }

  const hasExistingRAG = status.collections.length > 0 || status.wissenOnline
  const totalDocs = status.collections.reduce((sum, c) => sum + (c.points_count || 0), 0)

  return (
    <div>
      <div className="mb-6 text-center">
        <Database className="mx-auto mb-3 h-10 w-10 text-blue-500" />
        <h2 className="text-2xl font-bold">{t('wizard.rag.title')}</h2>
        <p className="mt-1 text-gray-500 dark:text-gray-400">
          {isFree ? t('wizard.rag.subtitle.free') : t('wizard.rag.subtitle')}
        </p>
      </div>

      <p className="mb-6 text-center text-sm text-gray-600 dark:text-gray-400">
        {isFree ? t('wizard.rag.description.free') : t('wizard.rag.description')}
      </p>

      {/* ── Free Tier: Simple document context ────────────────────── */}
      {isFree ? (
        <div className="space-y-4">
          {/* Enable — share folders for AI context */}
          <button
            onClick={() => onToggle(true)}
            className={`flex w-full items-center gap-4 rounded-lg border-2 p-4 text-left transition-all ${
              ragEnabled
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
            }`}
          >
            <FolderOpen className={`h-5 w-5 flex-shrink-0 ${ragEnabled ? 'text-blue-500' : 'text-gray-400'}`} />
            <div className="flex-1">
              <span className="font-medium">{t('wizard.rag.enable.free')}</span>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {t('wizard.rag.enable.free.desc')}
              </p>
            </div>
          </button>

          {/* Directory picker — shown when enabled */}
          {ragEnabled && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-sm font-medium mb-2">{t('wizard.rag.selectDir.free')}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                {t('wizard.rag.selectDir.free.desc')}
              </p>

              <button
                onClick={handleSelectDirectory}
                className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-4 py-3 w-full text-sm hover:border-blue-400 hover:bg-blue-50 dark:hover:border-blue-600 dark:hover:bg-blue-900/10 transition-all"
              >
                <FolderOpen className="h-5 w-5 text-gray-400" />
                {ragDirectory ? (
                  <span className="text-blue-600 dark:text-blue-400 truncate">{ragDirectory}</span>
                ) : (
                  <span className="text-gray-500 dark:text-gray-400">{t('wizard.rag.selectDir')}</span>
                )}
              </button>
            </div>
          )}

          {/* Upgrade hint */}
          <div className="rounded-lg bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/10 dark:to-purple-900/10 border border-blue-200 dark:border-blue-800 px-4 py-3">
            <div className="flex items-center gap-3">
              <Database className="h-4 w-4 flex-shrink-0 text-blue-500" />
              <p className="text-xs text-blue-700 dark:text-blue-400">
                <span className="font-semibold">Pro:</span> {t('wizard.rag.upgradeHint')}
              </p>
            </div>
          </div>

          {/* Skip */}
          <button
            onClick={() => { onToggle(false); onDirectoryChange(null) }}
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
      ) : status.loading ? (
        /* ── Pro+ Tier: Loading ──────────────────────────────────── */
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('wizard.rag.detecting')}</p>
        </div>
      ) : (
        /* ── Pro+ Tier: Full RAG with vector databases ───────────── */
        <div className="space-y-4">
          {/* Existing RAG detected banner */}
          {hasExistingRAG && (
            <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-900/20 p-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
                <div>
                  <p className="text-sm font-medium text-green-800 dark:text-green-300">
                    {t('wizard.rag.existingFound')}
                  </p>
                  <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                    {status.collections.length > 0 && (
                      <span>{status.collections.length} {t('wizard.rag.collections')} ({totalDocs} {t('wizard.rag.chunks')})</span>
                    )}
                    {status.collections.length > 0 && status.wissenOnline && ' · '}
                    {status.wissenOnline && (
                      <span>{ragServerName} {t('wizard.rag.connected')}</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Show collections */}
              {status.collections.length > 0 && (
                <div className="mt-3 space-y-1">
                  {status.collections.map((col) => (
                    <div key={col.name} className="flex items-center justify-between rounded-md bg-green-100 dark:bg-green-900/30 px-3 py-1.5 text-xs">
                      <span className="font-medium text-green-800 dark:text-green-300">{col.name}</span>
                      {col.points_count !== undefined && (
                        <span className="text-green-600 dark:text-green-400">{col.points_count} {t('wizard.rag.chunks')}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Enable option */}
          <button
            onClick={() => onToggle(true)}
            className={`flex w-full items-center gap-4 rounded-lg border-2 p-4 text-left transition-all ${
              ragEnabled
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
            }`}
          >
            <Database className={`h-5 w-5 flex-shrink-0 ${ragEnabled ? 'text-blue-500' : 'text-gray-400'}`} />
            <div className="flex-1">
              <span className="font-medium">{t('wizard.rag.enable')}</span>
              {hasExistingRAG && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t('wizard.rag.enableExisting')}
                </p>
              )}
            </div>
          </button>

          {/* Directory selection — shown when enabled */}
          {ragEnabled && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-sm font-medium mb-2">{t('wizard.rag.addDocs')}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                {t('wizard.rag.addDocsHint')}
              </p>

              <button
                onClick={handleSelectDirectory}
                className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-4 py-3 w-full text-sm hover:border-blue-400 hover:bg-blue-50 dark:hover:border-blue-600 dark:hover:bg-blue-900/10 transition-all"
              >
                <FolderOpen className="h-5 w-5 text-gray-400" />
                {ragDirectory ? (
                  <span className="text-blue-600 dark:text-blue-400 truncate">{ragDirectory}</span>
                ) : (
                  <span className="text-gray-500 dark:text-gray-400">{t('wizard.rag.selectDir')}</span>
                )}
              </button>

              {ragDirectory && (
                <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                  {t('wizard.rag.indexAfter')}
                </p>
              )}
            </div>
          )}

          {/* Server status — only show if neither server is online and no collections */}
          {!hasExistingRAG && ragEnabled && (
            <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-4 py-3">
              <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                <HardDrive className="h-4 w-4 flex-shrink-0" />
                <span>{t('wizard.rag.localHint')}</span>
              </div>
            </div>
          )}

          {/* Skip option */}
          <button
            onClick={() => { onToggle(false); onDirectoryChange(null) }}
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
      )}
    </div>
  )
}

// ── Step 6: Ready ────────────────────────────────────────────────

function StepReady({
  t,
  savedKeys,
  selectedMode,
  ragEnabled,
  selectedModels,
  ragDirectory,
}: {
  t: (key: string) => string
  savedKeys: Record<string, boolean>
  selectedMode: string
  ragEnabled: boolean
  selectedModels: string[]
  ragDirectory: string | null
}) {
  const configuredProviders = Object.entries(savedKeys)
    .filter(([_, saved]) => saved)
    .map(([provider]) => provider)

  const localModelNames = selectedModels.map(id => {
    const colonIdx = id.indexOf(':')
    return colonIdx > -1 ? id.slice(colonIdx + 1) : id
  })

  const providerSummary = [
    ...configuredProviders,
    ...localModelNames,
  ]

  const ragValue = ragEnabled
    ? ragDirectory
      ? `${t('wizard.ready.enabled')} (${ragDirectory.split('/').pop()})`
      : t('wizard.ready.enabled')
    : t('wizard.ready.disabled')

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
          value={providerSummary.length > 0 ? providerSummary.join(', ') : 'Ollama (local)'}
        />
        <SummaryRow
          label={t('wizard.ready.mode')}
          value={selectedMode.charAt(0).toUpperCase() + selectedMode.slice(1)}
        />
        <SummaryRow
          label={t('wizard.ready.rag')}
          value={ragValue}
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
