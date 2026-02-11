# Icon Placeholder

Replace these files with proper app icons before release:

- `icon.png` — 1024x1024 source PNG
- `icon.icns` — macOS icon (generated from PNG)
- `icon.ico` — Windows icon (generated from PNG)

Generate icons using:
```bash
# macOS: Use iconutil or electron-icon-builder
npx electron-icon-builder --input=build/icon.png --output=build/
```