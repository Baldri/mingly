import { useState } from 'react'
import { X, Plus, Server, Check, AlertCircle, Loader2 } from 'lucide-react'

interface Props {
  isOpen: boolean
  onClose: () => void
  onAddProvider: (config: CustomProviderConfig) => void
}

export interface CustomProviderConfig {
  id: string
  name: string
  apiBase: string
  apiKeyRequired: boolean
}

const PROVIDER_TEMPLATES = [
  {
    id: 'lm-studio',
    name: 'LM Studio (Local)',
    apiBase: 'http://localhost:1234/v1',
    apiKeyRequired: false,
    description: 'Local LLM server with OpenAI-compatible API',
    category: 'local'
  },
  {
    id: 'lm-studio-network',
    name: 'LM Studio (Network)',
    apiBase: 'http://192.168.1.100:1234/v1',
    apiKeyRequired: false,
    description: 'LM Studio running on network server',
    category: 'network'
  },
  {
    id: 'vllm',
    name: 'vLLM Server',
    apiBase: 'http://192.168.1.100:8000/v1',
    apiKeyRequired: false,
    description: 'High-performance inference server',
    category: 'network'
  },
  {
    id: 'localai',
    name: 'LocalAI',
    apiBase: 'http://localhost:8080/v1',
    apiKeyRequired: false,
    description: 'Self-hosted OpenAI alternative',
    category: 'local'
  },
  {
    id: 'text-generation-webui',
    name: 'Text Generation WebUI',
    apiBase: 'http://localhost:5000/v1',
    apiKeyRequired: false,
    description: 'Gradio web UI for running LLMs',
    category: 'local'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiBase: 'https://openrouter.ai/api/v1',
    apiKeyRequired: true,
    description: 'Unified API for multiple LLM providers',
    category: 'cloud'
  },
  {
    id: 'together-ai',
    name: 'Together AI',
    apiBase: 'https://api.together.xyz/v1',
    apiKeyRequired: true,
    description: 'Fast inference for open-source models',
    category: 'cloud'
  }
]

export function CustomProviderModal({ isOpen, onClose, onAddProvider }: Props) {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [customId, setCustomId] = useState('')
  const [customName, setCustomName] = useState('')
  const [customApiBase, setCustomApiBase] = useState('')
  const [customApiKeyRequired, setCustomApiKeyRequired] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; models?: string[] } | null>(null)
  const [activeCategory, setActiveCategory] = useState<'local' | 'network' | 'cloud'>('network')

  const handleSelectTemplate = (templateId: string) => {
    const template = PROVIDER_TEMPLATES.find((t) => t.id === templateId)
    if (template) {
      setSelectedTemplate(templateId)
      setCustomId(template.id)
      setCustomName(template.name)
      setCustomApiBase(template.apiBase)
      setCustomApiKeyRequired(template.apiKeyRequired)
      setTestResult(null) // Reset test result when changing template
    }
  }

  const handleTestConnection = async () => {
    if (!customApiBase) {
      setTestResult({ success: false, message: 'Please enter an API Base URL first' })
      return
    }

    setTesting(true)
    setTestResult(null)

    try {
      // Test connection by fetching models
      const response = await fetch(`${customApiBase}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      const models = data.data?.map((m: any) => m.id) || []

      setTestResult({
        success: true,
        message: `✅ Connection successful! Found ${models.length} model(s)`,
        models: models.slice(0, 5) // Show first 5 models
      })
    } catch (error) {
      console.error('Connection test failed:', error)
      setTestResult({
        success: false,
        message: `❌ Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      })
    } finally {
      setTesting(false)
    }
  }

  const [validationError, setValidationError] = useState<string | null>(null)

  const handleAddCustom = () => {
    if (!customId || !customName || !customApiBase) {
      setValidationError('Please fill in all required fields (Provider ID, Display Name, API Base URL)')
      return
    }
    setValidationError(null)

    onAddProvider({
      id: customId,
      name: customName,
      apiBase: customApiBase,
      apiKeyRequired: customApiKeyRequired
    })

    // Reset form
    setSelectedTemplate(null)
    setCustomId('')
    setCustomName('')
    setCustomApiBase('')
    setCustomApiKeyRequired(false)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-[700px] max-w-[90vw] max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Server size={24} />
            Add Custom Provider
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6">
          {/* Category Tabs */}
          <div className="flex gap-2 border-b border-gray-300 dark:border-gray-700">
            {(['local', 'network', 'cloud'] as const).map((category) => (
              <button
                key={category}
                onClick={() => setActiveCategory(category)}
                className={`px-4 py-2 font-medium transition-colors ${
                  activeCategory === category
                    ? 'border-b-2 border-blue-500 text-blue-500'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
              >
                {category.charAt(0).toUpperCase() + category.slice(1)}
              </button>
            ))}
          </div>

          {/* Templates */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Quick Setup Templates</h3>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDER_TEMPLATES.filter(t => t.category === activeCategory).map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleSelectTemplate(template.id)}
                  className={`p-3 rounded-lg border-2 transition-all text-left ${
                    selectedTemplate === template.id
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-700 hover:border-gray-400'
                  }`}
                >
                  <div className="font-medium">{template.name}</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {template.description}
                  </div>
                  <div className="text-xs text-gray-500 mt-1 font-mono">
                    {template.apiBase}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Custom Configuration */}
          <div className="space-y-4 pt-4 border-t border-gray-300 dark:border-gray-700">
            <h3 className="text-sm font-semibold">Provider Configuration</h3>

            <div>
              <label className="block text-sm font-medium mb-1">
                Provider ID *
              </label>
              <input
                type="text"
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="e.g., lm-studio"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Unique identifier (lowercase, no spaces)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Display Name *
              </label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g., LM Studio"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                API Base URL *
              </label>
              <input
                type="url"
                value={customApiBase}
                onChange={(e) => setCustomApiBase(e.target.value)}
                placeholder="http://localhost:1234/v1"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                OpenAI-compatible endpoint (must include /v1)
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="apiKeyRequired"
                checked={customApiKeyRequired}
                onChange={(e) => setCustomApiKeyRequired(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300"
              />
              <label htmlFor="apiKeyRequired" className="text-sm">
                Requires API Key
              </label>
            </div>

            {/* Test Connection Button */}
            <div className="pt-2">
              <button
                onClick={handleTestConnection}
                disabled={!customApiBase || testing}
                className="w-full px-4 py-2 rounded-lg border-2 border-blue-500 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {testing ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Testing Connection...
                  </>
                ) : (
                  <>
                    <Server size={18} />
                    Test Connection
                  </>
                )}
              </button>
            </div>

            {/* Test Result */}
            {testResult && (
              <div
                className={`p-3 rounded-lg flex items-start gap-2 ${
                  testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                    : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                }`}
              >
                {testResult.success ? (
                  <Check size={20} className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle size={20} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <p className={`text-sm font-medium ${
                    testResult.success
                      ? 'text-green-800 dark:text-green-200'
                      : 'text-red-800 dark:text-red-200'
                  }`}>
                    {testResult.message}
                  </p>
                  {testResult.models && testResult.models.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-green-700 dark:text-green-300 font-medium mb-1">
                        Available models:
                      </p>
                      <ul className="text-xs text-green-600 dark:text-green-400 space-y-0.5">
                        {testResult.models.map((model) => (
                          <li key={model} className="font-mono">• {model}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Validation Error */}
          {validationError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
            >
              {validationError}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 justify-end pt-4 border-t border-gray-300 dark:border-gray-700">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAddCustom}
              disabled={!customId || !customName || !customApiBase}
              className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              <Plus size={18} />
              Add Provider
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
