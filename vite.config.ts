import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

/**
 * The version that ships, read from the one file that decides it.
 *
 * The renderer used to spell its own version out (`Mingly v0.5.0` in App.tsx,
 * while package.json said 0.7.2). Reading it here rather than over IPC keeps
 * the footer synchronous and adds no channel; it is correct because
 * `electron-builder.yml` rewrites `name` and `productName` via
 * `extraMetadata` but NOT `version` — an assumption asserted in
 * tests/unit/app-version-not-hardcoded.test.ts, so it cannot rot quietly.
 */
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version)
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-markdown': [
            'react-markdown',
            'react-syntax-highlighter'
          ],
          'vendor-virtuoso': [
            'react-virtuoso'
          ]
        }
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5173
  }
})
