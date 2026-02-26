/**
 * macOS Notarization script for electron-builder.
 *
 * Called automatically by electron-builder's afterSign hook.
 * Requires these environment variables:
 *   - APPLE_ID: Apple Developer email
 *   - APPLE_APP_SPECIFIC_PASSWORD: App-specific password from appleid.apple.com
 *   - APPLE_TEAM_ID: 10-character team ID (A336Z3X5AA for digital opua GmbH)
 *
 * When env vars are missing, notarization is silently skipped.
 * This allows unsigned dev builds while enabling signed CI builds.
 *
 * Setup:
 *   1. Generate app-specific password at appleid.apple.com/account/manage
 *   2. Set env vars: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 *   3. For CI: add as GitHub Secrets + CSC_LINK (base64 .p12), CSC_KEY_PASSWORD
 */

const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') {
    return
  }

  // Skip if credentials are not configured
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log('[Notarize] Skipping — APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID not set')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  console.log(`[Notarize] Submitting ${appPath} to Apple...`)

  try {
    await notarize({
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    })
    console.log('[Notarize] Done — app has been notarized')
  } catch (err) {
    console.error('[Notarize] FAILED — build continues without notarization')
    console.error('[Notarize]', err.message || err)
    console.error('[Notarize] You can notarize manually later with:')
    console.error(`[Notarize]   xcrun notarytool submit "${appPath}" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait`)
  }
}
