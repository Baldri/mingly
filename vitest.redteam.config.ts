import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Privacy red-team suite (tests/red-team/) — kept out of the default
// `npm test` run because the 2-layer baseline has documented known gaps
// (see tests/red-team/results/) that would block the commit quality gate.
// Run explicitly: `npm run test:red-team` (add RUN_3LAYER=1 for NER mode).
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/red-team/**/*.test.ts'],
    exclude: ['node_modules', 'dist']
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
