/**
 * Download URLs for Mingly installers.
 *
 * All downloads point to GitHub Releases (Baldri/mingly).
 * Auto-updates also use GitHub Releases via electron-updater.
 *
 * One binary for all tiers — license key unlocks features in-app.
 */

const GITHUB_OWNER = 'Baldri'
const GITHUB_REPO = 'mingly'

/** GitHub Releases URL (browsable page) */
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

/** Latest release URL (redirects to most recent tag) */
export const GITHUB_LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`

/**
 * Get the platform-specific download URL for the latest release.
 * Uses GitHub's release asset naming convention from electron-builder.
 */
export function getDownloadUrl(version?: string): string {
  if (!version) {
    // Without version, link to the latest release page (user picks their platform)
    return GITHUB_LATEST_RELEASE_URL
  }

  const base = `${GITHUB_RELEASES_URL}/download/v${version}`
  const platform = typeof process !== 'undefined' ? process.platform : 'darwin'

  switch (platform) {
    case 'darwin':
      return `${base}/Mingly-${version}.dmg`
    case 'win32':
      return `${base}/Mingly-Setup-${version}.exe`
    case 'linux':
      return `${base}/Mingly-${version}.AppImage`
    default:
      return GITHUB_LATEST_RELEASE_URL
  }
}

/**
 * Download URLs per platform for a specific version.
 * Used by the website to show direct download links.
 */
export function getDownloadUrls(version: string) {
  const base = `${GITHUB_RELEASES_URL}/download/v${version}`
  return {
    mac: {
      dmg: `${base}/Mingly-${version}.dmg`,
      zip: `${base}/Mingly-${version}-mac.zip`
    },
    windows: {
      installer: `${base}/Mingly-Setup-${version}.exe`,
      portable: `${base}/Mingly-${version}-portable.exe`
    },
    linux: {
      appImage: `${base}/Mingly-${version}.AppImage`,
      deb: `${base}/mingly_${version}_amd64.deb`
    }
  } as const
}
