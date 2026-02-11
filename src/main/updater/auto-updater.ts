/**
 * Auto-Update Manager
 *
 * Handles checking for and applying app updates via electron-updater.
 * In dev mode, gracefully falls back to simulated no-op behavior.
 *
 * Production flow:
 * 1. Check for updates on app start + every 4 hours
 * 2. Download update in background (autoDownload)
 * 3. Notify renderer via IPC ('updater:status')
 * 4. Install on next quit (autoInstallOnAppQuit)
 */

import { app, BrowserWindow } from 'electron'
import { EventEmitter } from 'events'

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

export interface UpdateStatus {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  error: string | null
  info: UpdateInfo | null
  progress: number | null  // 0-100
}

export class AutoUpdater extends EventEmitter {
  private status: UpdateStatus = {
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    error: null,
    info: null,
    progress: null
  }

  private mainWindow: BrowserWindow | null = null
  private updater: any = null
  private checkInterval: ReturnType<typeof setInterval> | null = null

  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Initialize the auto-updater.
   * Attempts to load electron-updater (production only).
   */
  initialize(): void {
    if (!app.isPackaged) {
      console.log('Auto-updater: dev mode — using simulated checks')
      return
    }

    try {
      const { autoUpdater } = require('electron-updater')
      this.updater = autoUpdater

      this.updater.autoDownload = true
      this.updater.autoInstallOnAppQuit = true

      this.updater.on('checking-for-update', () => {
        this.status = { ...this.status, checking: true, error: null }
        this.notifyRenderer()
      })

      this.updater.on('update-available', (info: any) => {
        this.status = {
          ...this.status,
          checking: false,
          available: true,
          info: {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
          }
        }
        this.notifyRenderer()
      })

      this.updater.on('update-not-available', () => {
        this.status = { ...this.status, checking: false, available: false }
        this.notifyRenderer()
      })

      this.updater.on('download-progress', (progress: any) => {
        this.status = {
          ...this.status,
          downloading: true,
          progress: Math.round(progress.percent)
        }
        this.notifyRenderer()
      })

      this.updater.on('update-downloaded', (info: any) => {
        this.status = {
          ...this.status,
          downloading: false,
          downloaded: true,
          progress: 100,
          info: {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
          }
        }
        this.notifyRenderer()
      })

      this.updater.on('error', (error: Error) => {
        this.status = {
          ...this.status,
          checking: false,
          downloading: false,
          error: error.message
        }
        this.notifyRenderer()
      })

      console.log('Auto-updater: initialized with electron-updater')
    } catch {
      console.log('Auto-updater: electron-updater not available')
    }

    // Initial check after 10 seconds
    setTimeout(() => this.checkForUpdates(), 10_000)

    // Check every 4 hours
    this.checkInterval = setInterval(() => this.checkForUpdates(), 4 * 60 * 60 * 1000)
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (this.updater) {
      // Real electron-updater check
      try {
        await this.updater.checkForUpdates()
      } catch (error) {
        console.warn('Update check failed:', (error as Error).message)
      }
      return this.getStatus()
    }

    // Dev mode: simulate a quick check
    this.status.checking = true
    this.status.error = null
    this.notifyRenderer()

    await new Promise(resolve => setTimeout(resolve, 500))

    this.status.checking = false
    this.status.available = false
    this.notifyRenderer()

    return this.getStatus()
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (!this.status.available) {
      return this.getStatus()
    }

    if (this.updater) {
      // electron-updater handles download automatically when autoDownload=true
      // This method is for manual trigger if autoDownload is disabled
      try {
        await this.updater.downloadUpdate()
      } catch (error) {
        this.status.error = (error as Error).message
        this.notifyRenderer()
      }
      return this.getStatus()
    }

    return this.getStatus()
  }

  installUpdate(): void {
    if (!this.status.downloaded) return

    if (this.updater) {
      this.updater.quitAndInstall()
    } else {
      console.log('Auto-updater: would quit and install (dev mode)')
    }
  }

  shutdown(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }

  private notifyRenderer(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('updater:status', this.getStatus())
    }
  }
}

let instance: AutoUpdater | null = null
export function getAutoUpdater(): AutoUpdater {
  if (!instance) instance = new AutoUpdater()
  return instance
}
