import { useState, useEffect, lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react'
import { Moon, Sun, Settings } from 'lucide-react'
import { ChatLayout } from './components/ChatLayout'
import { LoadingSpinner } from './components/LoadingSpinner'
import { OnboardingTooltip, TourStartButton } from './components/OnboardingTooltip'
import { useSettingsStore } from './stores/settings-store'
import { useChatStore } from './stores/chat-store'

/** Global Error Boundary — catches render errors and shows recovery UI */
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-white dark:bg-gray-900 p-8" role="alert">
          <div className="max-w-md text-center">
            <h2 className="text-2xl font-bold text-red-600 mb-4">Something went wrong</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="rounded-lg bg-blue-500 px-6 py-2 text-white hover:bg-blue-600 transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/** Lazy-loaded heavy components — only fetched when needed */
const SettingsPage = lazy(() => import('./components/SettingsPage').then(m => ({ default: m.SettingsPage })))
const SetupWizard = lazy(() => import('./components/SetupWizard').then(m => ({ default: m.SetupWizard })))
const NewConversationModal = lazy(() => import('./components/NewConversationModal').then(m => ({ default: m.NewConversationModal })))

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    // Apply dark class immediately to prevent flash of unstyled content
    document.documentElement.classList.add('dark')
    return 'dark'
  })
  const [showSettings, setShowSettings] = useState(false)
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [showWelcome, setShowWelcome] = useState(true)
  const [isLoading, setIsLoading] = useState(true)

  const { settings, loadSettings, checkAPIKeys, apiKeysConfigured } = useSettingsStore()
  const { loadConversations, conversations } = useChatStore()

  useEffect(() => {
    // Initialize app with loading state
    Promise.all([loadSettings(), checkAPIKeys(), loadConversations()])
      .finally(() => setIsLoading(false))

    // Listen for new conversation events
    const handleNewConversation = () => setShowNewConversation(true)
    window.addEventListener('open-new-conversation', handleNewConversation)

    return () => {
      window.removeEventListener('open-new-conversation', handleNewConversation)
    }
  }, [])

  // Sync theme from persisted settings when loaded
  useEffect(() => {
    if (settings?.theme) {
      setTheme(settings.theme as 'light' | 'dark')
    }
  }, [settings?.theme])

  // Apply theme class to <html> whenever it changes
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    // Hide welcome screen if user has conversations or API keys
    if (conversations.length > 0 || Object.keys(apiKeysConfigured).length > 0) {
      setShowWelcome(false)
    }
  }, [conversations, apiKeysConfigured])

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
  }

  const hasAnyAPIKey = Object.values(apiKeysConfigured).some(Boolean)

  // Show loading spinner during initial bootstrap
  if (isLoading) {
    return <LoadingSpinner label="Starting Mingly..." />
  }

  // Setup wizard for first-time users
  if (settings && !settings.wizardCompleted) {
    return (
      <Suspense fallback={<LoadingSpinner label="Loading setup..." />}>
        <SetupWizard
          onComplete={() => {
            checkAPIKeys()
            setShowWelcome(false)
          }}
        />
      </Suspense>
    )
  }

  // Full-page settings view (replaces chat/welcome entirely)
  if (showSettings) {
    return (
      <Suspense fallback={<LoadingSpinner label="Loading settings..." />}>
        <SettingsPage onBack={() => setShowSettings(false)} />
      </Suspense>
    )
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
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
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
              aria-label="Open settings"
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
                action="Open Settings"
                onAction={() => setShowSettings(true)}
              />
            </div>
          </div>
        </main>

        <footer className="border-t border-gray-300 dark:border-gray-700 px-6 py-3 text-center text-sm text-gray-600 dark:text-gray-400">
          Mingly v0.3.2 | Privacy-First
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
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
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
              aria-label="Open settings"
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

      {/* Onboarding System */}
      <OnboardingTooltip />
      <TourStartButton />

      {showNewConversation && (
        <Suspense fallback={<LoadingSpinner label="Loading..." />}>
          <NewConversationModal
            isOpen={showNewConversation}
            onClose={() => setShowNewConversation(false)}
          />
        </Suspense>
      )}
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

function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

export default AppWithErrorBoundary
