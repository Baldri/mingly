/**
 * Minimal i18n for Mingly (DE/EN)
 *
 * Lightweight translation system — no external dependencies.
 * Uses the language setting from the settings store.
 */

import { useSettingsStore } from '../stores/settings-store'

type TranslationKey = keyof typeof translations.en

const translations = {
  en: {
    // Wizard
    'wizard.welcome.title': 'Welcome to Mingly',
    'wizard.welcome.subtitle': 'Mingle with all AI minds in one place',
    'wizard.welcome.description': 'Unified access to Claude, ChatGPT, Gemini, and local LLMs — secure, private, and fully under your control.',
    'wizard.welcome.language': 'Language',
    'wizard.next': 'Next',
    'wizard.back': 'Back',
    'wizard.skip': 'Skip',
    'wizard.finish': 'Start Chatting',

    // Wizard Step 2 — API Keys
    'wizard.keys.title': 'Connect Your AI Providers',
    'wizard.keys.subtitle': 'Add at least one API key to get started — or use a local model.',
    'wizard.keys.anthropic': 'Anthropic (Claude)',
    'wizard.keys.openai': 'OpenAI (ChatGPT)',
    'wizard.keys.google': 'Google (Gemini)',
    'wizard.keys.local': 'Local Model (Ollama)',
    'wizard.keys.local.description': 'No API key needed — runs on your machine.',
    'wizard.keys.placeholder': 'Enter API key...',
    'wizard.keys.save': 'Save',
    'wizard.keys.saved': 'Saved',
    'wizard.keys.noKey': "Skip — I'll add keys later",

    // Wizard Step 3 — Mode
    'wizard.mode.title': 'Choose Your Setup',
    'wizard.mode.subtitle': 'How would you like to use Mingly?',
    'wizard.mode.standalone': 'Standalone',
    'wizard.mode.standalone.desc': 'Everything runs locally on this computer. Recommended for personal use.',
    'wizard.mode.server': 'Server',
    'wizard.mode.server.desc': 'Share AI access across your network. Other devices can connect to this instance.',
    'wizard.mode.client': 'Client',
    'wizard.mode.client.desc': 'Connect to an existing Mingly Server on your network.',
    'wizard.mode.recommended': 'Recommended',

    // Wizard Step 4 — Knowledge Base
    'wizard.rag.title': 'Knowledge Base (Optional)',
    'wizard.rag.subtitle': 'Give your AI access to your documents for more relevant answers.',
    'wizard.rag.enable': 'Enable Knowledge Base',
    'wizard.rag.disable': 'Skip for now',
    'wizard.rag.selectDir': 'Select Document Directory',
    'wizard.rag.description': 'Mingly can index your local documents (PDF, Markdown, Text) so AI responses include context from your files.',

    // Wizard Step 5 — Ready
    'wizard.ready.title': "You're All Set!",
    'wizard.ready.subtitle': "Here's a summary of your setup:",
    'wizard.ready.provider': 'Provider',
    'wizard.ready.mode': 'Mode',
    'wizard.ready.rag': 'Knowledge Base',
    'wizard.ready.enabled': 'Enabled',
    'wizard.ready.disabled': 'Disabled',

    // Common
    'common.settings': 'Settings',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.close': 'Close',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.success': 'Success',
  },
  de: {
    // Wizard
    'wizard.welcome.title': 'Willkommen bei Mingly',
    'wizard.welcome.subtitle': 'Alle KI-Modelle an einem Ort',
    'wizard.welcome.description': 'Einheitlicher Zugang zu Claude, ChatGPT, Gemini und lokalen LLMs — sicher, privat und unter Ihrer Kontrolle.',
    'wizard.welcome.language': 'Sprache',
    'wizard.next': 'Weiter',
    'wizard.back': 'Zurueck',
    'wizard.skip': 'Ueberspringen',
    'wizard.finish': 'Jetzt chatten',

    // Wizard Step 2 — API Keys
    'wizard.keys.title': 'KI-Anbieter verbinden',
    'wizard.keys.subtitle': 'Fuegen Sie mindestens einen API-Schluessel hinzu — oder nutzen Sie ein lokales Modell.',
    'wizard.keys.anthropic': 'Anthropic (Claude)',
    'wizard.keys.openai': 'OpenAI (ChatGPT)',
    'wizard.keys.google': 'Google (Gemini)',
    'wizard.keys.local': 'Lokales Modell (Ollama)',
    'wizard.keys.local.description': 'Kein API-Schluessel noetig — laeuft auf Ihrem Rechner.',
    'wizard.keys.placeholder': 'API-Schluessel eingeben...',
    'wizard.keys.save': 'Speichern',
    'wizard.keys.saved': 'Gespeichert',
    'wizard.keys.noKey': 'Ueberspringen — Schluessel spaeter hinzufuegen',

    // Wizard Step 3 — Mode
    'wizard.mode.title': 'Betriebsmodus waehlen',
    'wizard.mode.subtitle': 'Wie moechten Sie Mingly nutzen?',
    'wizard.mode.standalone': 'Standalone',
    'wizard.mode.standalone.desc': 'Alles laeuft lokal auf diesem Computer. Empfohlen fuer persoenliche Nutzung.',
    'wizard.mode.server': 'Server',
    'wizard.mode.server.desc': 'KI-Zugang im Netzwerk teilen. Andere Geraete koennen sich mit dieser Instanz verbinden.',
    'wizard.mode.client': 'Client',
    'wizard.mode.client.desc': 'Mit einem bestehenden Mingly Server im Netzwerk verbinden.',
    'wizard.mode.recommended': 'Empfohlen',

    // Wizard Step 4 — Knowledge Base
    'wizard.rag.title': 'Wissensdatenbank (Optional)',
    'wizard.rag.subtitle': 'Geben Sie der KI Zugang zu Ihren Dokumenten fuer relevantere Antworten.',
    'wizard.rag.enable': 'Wissensdatenbank aktivieren',
    'wizard.rag.disable': 'Vorerst ueberspringen',
    'wizard.rag.selectDir': 'Dokumentenverzeichnis auswaehlen',
    'wizard.rag.description': 'Mingly kann Ihre lokalen Dokumente (PDF, Markdown, Text) indexieren, damit KI-Antworten Kontext aus Ihren Dateien enthalten.',

    // Wizard Step 5 — Ready
    'wizard.ready.title': 'Alles eingerichtet!',
    'wizard.ready.subtitle': 'Zusammenfassung Ihrer Einstellungen:',
    'wizard.ready.provider': 'Anbieter',
    'wizard.ready.mode': 'Modus',
    'wizard.ready.rag': 'Wissensdatenbank',
    'wizard.ready.enabled': 'Aktiviert',
    'wizard.ready.disabled': 'Deaktiviert',

    // Common
    'common.settings': 'Einstellungen',
    'common.cancel': 'Abbrechen',
    'common.save': 'Speichern',
    'common.close': 'Schliessen',
    'common.loading': 'Laden...',
    'common.error': 'Fehler',
    'common.success': 'Erfolg',
  },
} as const

/**
 * Get translation function for the current language.
 */
export function useTranslation() {
  const settings = useSettingsStore((s) => s.settings)
  const lang = settings?.language || 'en'

  function t(key: string): string {
    const k = key as TranslationKey
    return translations[lang]?.[k] || translations.en[k] || key
  }

  return { t, lang }
}

/**
 * Get a translation without React hooks (for non-component use).
 */
export function translate(key: string, lang: 'de' | 'en' = 'en'): string {
  const k = key as TranslationKey
  return translations[lang]?.[k] || translations.en[k] || key
}
