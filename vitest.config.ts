import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    // Main process tests (Node environment)
    include: ['src/main/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/e2e/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: [
        'src/main/**/*.ts',
        'src/shared/**/*.ts'
      ],
      exclude: [
        'src/main/index.ts',  // Electron entry point
        '**/*.test.ts',
        '**/__tests__/**'
      ]
    }
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
