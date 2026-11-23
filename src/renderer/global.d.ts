import type { ElectronAPI } from '../preload/index'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  /**
   * The app version, replaced at build time by vite's `define` from
   * package.json, so the footer needs no IPC round trip. See vite.config.ts
   * and tests/unit/app-version-not-hardcoded.test.ts.
   *
   * Inside `declare global` on purpose: this file is a MODULE (it has an
   * `import type` and an `export {}`), so a top-level `declare const` here is
   * module-local and invisible to App.tsx. Measured — that spelling compiled
   * to `TS2304: Cannot find name '__APP_VERSION__'`.
   */
  const __APP_VERSION__: string
}

export {}
