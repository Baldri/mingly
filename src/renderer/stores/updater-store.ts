/**
 * Updater Store — manages auto-update state and actions.
 *
 * All methods guard against window.electronAPI being unavailable
 * (dev mode, HMR reload, or timing issues during app bootstrap).
 */

import { create } from 'zustand'

interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
  downloadUrl?: string
}

interface UpdateStatus {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  error: string | null
  info: UpdateInfo | null
  progress: number | null
  autoUpdateEnabled: boolean
}

interface UpdaterState {
  status: UpdateStatus
  loadStatus: () => Promise<void>
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  openReleasePage: () => Promise<void>
  subscribeToStatus: () => () => void
}

const INITIAL_STATUS: UpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  error: null,
  info: null,
  progress: null,
  autoUpdateEnabled: false,
}

/** Safe accessor — returns the updater bridge or undefined */
function getUpdaterAPI() {
  return window.electronAPI?.updater
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  status: INITIAL_STATUS,

  loadStatus: async () => {
    try {
      const api = getUpdaterAPI()
      if (!api) return
      const status = await api.getStatus()
      set({ status })
    } catch {
      // Updater not available (dev mode)
    }
  },

  checkForUpdates: async () => {
    try {
      const api = getUpdaterAPI()
      if (!api) return
      const status = await api.check()
      set({ status })
    } catch (err) {
      set((state) => ({
        status: { ...state.status, error: (err as Error).message, checking: false }
      }))
    }
  },

  downloadUpdate: async () => {
    try {
      const api = getUpdaterAPI()
      if (!api) return
      const status = await api.download()
      set({ status })
    } catch (err) {
      set((state) => ({
        status: { ...state.status, error: (err as Error).message, downloading: false }
      }))
    }
  },

  installUpdate: async () => {
    try {
      const api = getUpdaterAPI()
      if (!api) return
      await api.install()
    } catch {
      // Will quit app
    }
  },

  openReleasePage: async () => {
    try {
      const api = getUpdaterAPI()
      if (!api) return
      await api.openReleasePage()
    } catch {
      // Fallback: nothing
    }
  },

  subscribeToStatus: () => {
    const api = getUpdaterAPI()
    if (!api) return () => {}
    const unsubscribe = api.onStatus((status: UpdateStatus) => {
      set({ status })
    })
    return unsubscribe
  },
}))
