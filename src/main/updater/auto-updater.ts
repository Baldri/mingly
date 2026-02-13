/**
 * Auto-Update Manager
 *
 * Handles checking for and applying app updates via electron-updater.
 * In dev mode, gracefully falls back to simulated no-op behavior.
 *
 * Platform support:
 * - macOS:   Updates via .zip (electron-updater extracts and replaces)
 * - Windows: Updates via NSIS installer (silent background install)
 * - Linux:   Updates via AppImage (replaces the running AppImage)
 *
 * All updates are fetched from GitHub Releases (Baldri/mingly).
 *
 * Tier behavior:
 * - Pro+: Auto-download and install on quit
 * - Free: Check only, notify user, redirect to GitHub Releases for manual download
 *
 * Production flow (Pro+):
 * 1. Check for updates on app start + every 4 hours
 * 2. Download update in background (autoDownload)
 * 3. Notify renderer via IPC ('updater:status')
 * 4. Install on next quit (autoInstallOnAppQuit)
 */

import { app, BrowserWindow, shell } from 'electron'
import { EventEmitter } from 'events'
import type { SubscriptionTier } from '../../shared/types'

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
  /** Direct download URL for manual update (Free tier) */
  downloadUrl?: string
}

export interface UpdateStatus {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  error: string | null
  info: UpdateInfo | null
  progress: number | null  // 0-100
  /** Whether auto-update is available (Pro+) or manual only (Free) */
  autoUpdateEnabled: boolean
}

const GITHUB_RELEASES = 'https://github.com/Baldri/mingly/releases'
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const INITIAL_CHECK_DELAY_MS = 10_000 // 10 seconds

export class AutoUpdater extends EventEmitter {
  private status: UpdateStatus = {
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    error: null,
    info: null,
    progress: null,
    autoUpdateEnabled: false
  }

  private mainWindow: BrowserWindow | null = null
  private updater: any = null
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private tier: SubscriptionTier = 'free'

  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Set the current subscription tier.
   * Pro+: full auto-download & install.
   * Free: check-only, notify user.
   */
  setTier(tier: SubscriptionTier): void {
    this.tier = tier
    const autoEnabled = tier !== 'free'

    this.status.autoUpdateEnabled = autoEnabled

    if (this.updater) {
      this.updater.autoDownload = autoEnabled
      this.updater.autoInstallOnAppQuit = autoEnabled
    }
  }

  /**
   * Initialize the auto-updater.
   * Loads electron-updater in production, simulates in dev.
   */
  initialize(): void {
    if (!app.isPackaged) {
      console.log('[updater] dev mode — using simulated checks')
      return
    }

    try {
      // electron-updater must be required at runtime (not available in dev)
      const { autoUpdater } = require('electron-updater')
      this.updater = autoUpdater

      // Configure for GitHub releases
      this.updater.setFeedURL({
        provider: 'github',
        owner: 'Baldri',
        repo: 'mingly'
      })

      // Tier-based behavior (default to check-only until tier is set)
      const autoEnabled = this.tier !== 'free'
      this.updater.autoDownload = autoEnabled
      this.updater.autoInstallOnAppQuit = autoEnabled
      this.status.autoUpdateEnabled = autoEnabled

      // Allow pre-release versions when the user is on a pre-release channel
      this.updater.allowPrerelease = false

      // Logging
      this.updater.logger = {
        info: (msg: string) => console.log('[updater]', msg),
        warn: (msg: string) => console.warn('[updater]', msg),
        error: (msg: string) => console.error('[updater]', msg),
        debug: (msg: string) => console.log('[updater:debug]', msg)
      }

      // Event handlers
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
            releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
            downloadUrl: `${GITHUB_RELEASES}/tag/v${info.version}`
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
            releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
            downloadUrl: `${GITHUB_RELEASES}/tag/v${info.version}`
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

      const platform = process.platform
      console.log(`[updater] initialized on ${platform} (tier: ${this.tier})`)
    } catch (err) {
      console.warn('[updater] electron-updater not available:', (err as Error).message)
    }

    // Initial check after delay
    setTimeout(() => this.checkForUpdates(), INITIAL_CHECK_DELAY_MS)

    // Periodic checks
    this.checkInterval = setInterval(() => this.checkForUpdates(), CHECK_INTERVAL_MS)
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (this.updater) {
      try {
        await this.updater.checkForUpdates()
      } catch (error) {
        console.warn('[updater] check failed:', (error as Error).message)
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
      console.log('[updater] would quit and install (dev mode)')
    }
  }

  /**
   * Open the GitHub Releases page for manual download (Free tier).
   */
  openReleasePage(): void {
    const url = this.status.info?.downloadUrl || GITHUB_RELEASES
    shell.openExternal(url)
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
