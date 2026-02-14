# Building Mingly

## Prerequisites

- Node.js 18+
- npm 9+
- macOS for `.dmg` builds, Windows for `.exe`, Linux for `.AppImage`/`.deb`

## Development

```bash
npm run dev          # Start dev mode (Vite HMR + Electron)
npm run build        # Compile TypeScript (main + renderer)
npm run typecheck    # Type-check without emitting
npm test             # Run all tests
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
```

## Build Commands

| Command | What it does |
|---------|-------------|
| `npm run pack` | Build + create unpacked app (fast, for testing) |
| `npm run dist` | Build + create platform installers |
| `npm run dist:mac` | Build macOS DMG + ZIP |
| `npm run dist:win` | Build Windows NSIS installer + portable |
| `npm run dist:linux` | Build Linux AppImage + DEB |
| `npm run dist:publish` | Build + publish to GitHub Releases |

## Output

All build artifacts go to `release/`:

```
release/
  mac-arm64/            # Unpacked .app (from pack)
  Mingly-{version}-arm64.dmg
  Mingly-{version}-arm64-mac.zip
  Mingly-Setup-{version}.exe     # Windows
  Mingly-{version}.AppImage      # Linux
  latest-mac.yml                 # Auto-update manifest
```

## Auto-Updates

Auto-updates use `electron-updater` with GitHub Releases as the provider.

Config in `electron-builder.yml`:
```yaml
publish:
  provider: github
  owner: Baldri
  repo: mingly
```

The update flow:
1. App checks GitHub Releases API for newer version
2. Downloads update in background (Pro+ tier)
3. Installs on next quit/restart
4. Free tier: shows "Download manually" link to GitHub Releases page

## Code Signing

Currently unsigned (development). To enable code signing:

1. Get an Apple Developer ID certificate
2. Uncomment in `electron-builder.yml`:
   ```yaml
   mac:
     hardenedRuntime: true
     entitlements: build/entitlements.mac.plist
     entitlementsInherit: build/entitlements.mac.plist
   ```
3. Set `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables
4. For Windows: get an EV code signing certificate

## CI/CD

GitHub Actions runs on push to `main`:
1. Install dependencies
2. Run tests
3. Type-check
4. Build

Release builds are triggered by `npm run dist:publish` or manually via GitHub Actions.
