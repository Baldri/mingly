/**
 * Download URLs for Mingly installers.
 *
 * Website downloads (initial install): Supabase Storage on mingly.ch
 * Auto-updates (in-app): GitHub Releases on Baldri/mingly
 *
 * To update: upload new installers to the Supabase bucket and update
 * the version number here. The filenames follow electron-builder conventions.
 */

export const MINGLY_VERSION = '0.1.0'

/** Supabase project URL for mingly.ch */
const SUPABASE_URL = 'https://your-project-ref.supabase.co'

/** Public bucket name for installer files */
const BUCKET = 'releases'

/** Base URL for downloads */
const BASE_URL = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`

/**
 * Download URLs for each platform.
 * Update filenames when the version changes.
 */
export const DOWNLOAD_URLS = {
  mac: {
    dmg: `${BASE_URL}/Mingly-${MINGLY_VERSION}.dmg`,
    zip: `${BASE_URL}/Mingly-${MINGLY_VERSION}-mac.zip`
  },
  windows: {
    installer: `${BASE_URL}/Mingly-Setup-${MINGLY_VERSION}.exe`,
    portable: `${BASE_URL}/Mingly-${MINGLY_VERSION}-portable.exe`
  },
  linux: {
    appImage: `${BASE_URL}/Mingly-${MINGLY_VERSION}.AppImage`,
    deb: `${BASE_URL}/mingly_${MINGLY_VERSION}_amd64.deb`
  }
} as const

/**
 * GitHub Releases URL (used by auto-updater, also as fallback download).
 */
export const GITHUB_RELEASES_URL = 'https://github.com/Baldri/mingly/releases'

/**
 * Get the appropriate download URL for the current platform.
 */
export function getDownloadUrl(): string {
  const platform = typeof process !== 'undefined' ? process.platform : 'darwin'
  switch (platform) {
    case 'darwin': return DOWNLOAD_URLS.mac.dmg
    case 'win32': return DOWNLOAD_URLS.windows.installer
    case 'linux': return DOWNLOAD_URLS.linux.appImage
    default: return GITHUB_RELEASES_URL
  }
}
