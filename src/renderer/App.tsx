import { useState, useEffect } from 'react'
import { Moon, Sun, Settings } from 'lucide-react'
import { ChatLayout } from './components/ChatLayout'
import { SettingsPage } from './components/SettingsPage'
import { SetupWizard } from './components/SetupWizard'
import { NewConversationModal } from './components/NewConversationModal'
import { useSettingsStore } from './stores/settings-store'
import { useChatStore } from './stores/chat-store'

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [showSettings, setShowSettings] = useState(false)
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [showWelcome, setShowWelcome] = useState(true)

  const { settings, loadSettings, checkAPIKeys, apiKeysConfigured } = useSettingsStore()
  const { loadConversations, conversations } = useChatStore()

  useEffect(() => {
    // Initialize app
    loadSettings()
    checkAPIKeys()
    loadConversations()

    // Apply theme
    document.documentElement.classList.toggle('dark', theme === 'dark')

    // Listen for new conversation events
    const handleNewConversation = () => setShowNewConversation(true)
    window.addEventListener('open-new-conversation', handleNewConversation)

    return () => {
      window.removeEventListener('open-new-conversation', handleNewConversation)
    }
  }, [])

  useEffect(() => {
    // Hide welcome screen if user has conversations or API keys
    if (conversations.length > 0 || Object.keys(apiKeysConfigured).length > 0) {
      setShowWelcome(false)
    }
  }, [conversations, apiKeysConfigured])

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
    document.documentElement.classList.toggle('dark')
  }

  const hasAnyAPIKey = Object.values(apiKeysConfigured).some(Boolean)

  // Setup wizard for first-time users
  if (settings && !settings.wizardCompleted) {
    return (
      <SetupWizard
        onComplete={() => {
          checkAPIKeys()
          setShowWelcome(false)
        }}
      />
    )
  }

  // Full-page settings view (replaces chat/welcome entirely)
  if (showSettings) {
    return <SettingsPage onBack={() => setShowSettings(false)} />
  }

  if (showWelcome && !hasAnyAPIKey) {
    return (
      <div className="flex h-screen flex-col bg-white dark:bg-gray-900">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-gray-300 dark:border-gray-700 px-6 py-4">
          <h1 className="text-xl font-semibold">Mingly</h1>

          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="rounded-lg p-2 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              {theme === 'light' ? (
                <Moon className="h-5 w-5" />
              ) : (
                <Sun className="h-5 w-5" />
              )}
            </button>

            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg p-2 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Welcome Screen */}
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-2xl text-center">
            <h2 className="text-4xl font-bold mb-4">Welcome to Mingly</h2>

            <p className="text-lg text-gray-600 dark:text-gray-400 mb-8">
              Mingle with all AI minds in one place. Unified access to Claude, ChatGPT, and Gemini with secure API key storage.
            </p>

            {/* Setup Steps */}
            <div className="grid gap-4 text-left">
              <SetupStep
                step={1}
                title="Configure API Keys"
                description="Add your Claude, ChatGPT, or Gemini API keys to get started"
                action="Open Settings"
                onAction={() => setShowSettings(true)}
              />
              <SetupStep
                step={2}
                title="Start a Conversation"
                description="Choose a provider and begin chatting with AI"
                completed={conversations.length > 0}
              />
              <SetupStep
                step={3}
                title="Explore Features"
                description="Knowledge base, analytics, integrations and more in Settings"
              />
            </div>
          </div>
        </main>

        <footer className="border-t border-gray-300 dark:border-gray-700 px-6 py-3 text-center text-sm text-gray-600 dark:text-gray-400">
          Mingly v0.1.0 | Privacy-First
        </footer>
      </div>
    )
  }

  return (
    <>
      <div className="flex h-screen flex-col">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-gray-300 dark:border-gray-700 px-6 py-3 bg-white dark:bg-gray-900">
          <h1 className="text-lg font-semibold">Mingly</h1>

          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="rounded-lg p-2 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              {theme === 'light' ? (
                <Moon className="h-5 w-5" />
              ) : (
                <Sun className="h-5 w-5" />
              )}
            </button>

            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg p-2 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Chat Interface */}
        <div className="flex-1 overflow-hidden">
          <ChatLayout />
        </div>
      </div>

      <NewConversationModal
        isOpen={showNewConversation}
        onClose={() => setShowNewConversation(false)}
      />
    </>
  )
}

function SetupStep({ step, title, description, action, onAction, completed }: {
  step: number
  title: string
  description: string
  action?: string
  onAction?: () => void
  completed?: boolean
}) {
  return (
    <div className={`flex items-start gap-4 rounded-lg border p-4 ${
      completed
        ? 'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-900/20'
        : 'border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-800'
    }`}>
      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${
        completed
          ? 'bg-green-500 text-white'
          : 'bg-blue-500 text-white'
      }`}>
        {completed ? '\u2713' : step}
      </div>
      <div className="flex-1">
        <h4 className="font-semibold text-gray-900 dark:text-white">{title}</h4>
        <p className="text-sm text-gray-600 dark:text-gray-400">{description}</p>
        {action && onAction && !completed && (
          <button
            onClick={onAction}
            className="mt-2 rounded-lg bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600 transition-colors"
          >
            {action}
          </button>
        )}
      </div>
    </div>
  )
}

export default App
