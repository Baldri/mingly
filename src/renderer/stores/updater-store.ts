/**
 * Updater Store — manages auto-update state and actions.
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

export const useUpdaterStore = create<UpdaterState>((set) => ({
  status: INITIAL_STATUS,

  loadStatus: async () => {
    try {
      const status = await window.electronAPI.updater.getStatus()
      set({ status })
    } catch {
      // Updater not available (dev mode)
    }
  },

  checkForUpdates: async () => {
    try {
      const status = await window.electronAPI.updater.check()
      set({ status })
    } catch (err) {
      set((state) => ({
        status: { ...state.status, error: (err as Error).message, checking: false }
      }))
    }
  },

  downloadUpdate: async () => {
    try {
      const status = await window.electronAPI.updater.download()
      set({ status })
    } catch (err) {
      set((state) => ({
        status: { ...state.status, error: (err as Error).message, downloading: false }
      }))
    }
  },

  installUpdate: async () => {
    try {
      await window.electronAPI.updater.install()
    } catch {
      // Will quit app
    }
  },

  openReleasePage: async () => {
    try {
      await window.electronAPI.updater.openReleasePage()
    } catch {
      // Fallback: nothing
    }
  },

  subscribeToStatus: () => {
    const unsubscribe = window.electronAPI.updater.onStatus((status: UpdateStatus) => {
      set({ status })
    })
    return unsubscribe
  },
}))
