// ESLint flat config — first rule package: the three typed promise rules.
//
// Scope note, deliberately narrow: this config lints exactly what
// `npm run typecheck` type-checks, and it draws its type information from the
// same four tsconfigs, one config block each. A typed rule is only as good as
// the program behind it, so the mapping is written out instead of being left to
// auto-discovery.
//
//   tsconfig.json       -> src/renderer, src/shared, src/preload
//   tsconfig.main.json  -> src/main (without tests)
//   tsconfig.server.json-> src/server
//   tsconfig.test.json  -> tests/, src/**/__tests__/
//
// NOT linted, because no tsconfig covers them and therefore no typed rule can
// run on them: electron.vite.config.ts, vite.config.ts, vitest.config.ts,
// vitest.redteam.config.ts, scripts/inject-secret.ts, scripts/ner-eval/run.ts,
// scripts/ner-eval/battery.ts. Those seven are outside the typecheck gate too.
// Checked by hand on 2026-11-23: five of the seven contain no `async`,
// `await`, `Promise`, `then(`, `setTimeout` or `setInterval` at all; the two
// that do (scripts/ner-eval/run.ts, scripts/inject-secret.ts) terminate their
// top-level promise with `.then().catch()`. No promise-rule violations today.
//
// Only three rules are enabled. `no-explicit-any` (340 hits in 73 files,
// measured 2026-11-23) is its own later package; a PR touching that many sites
// is not reviewable, and going green on a tolerance list is forbidden by
// CLAUDE.md. Adding a rule here means fixing its findings in the same PR.
import tseslint from 'typescript-eslint'

/**
 * `attributes: false` is a decision, not a tolerance list, and it applies to
 * every file equally. 77 of the 90 `no-misused-promises` hits were React event
 * props (`onClick={handleSomethingAsync}`). Prefixing those with `void` does
 * not observe the rejection — it only silences the rule. Handling them for
 * real needs an error surface in the renderer that does not exist yet, so that
 * is a separate piece of work. The remaining sub-checks stay on, and they are
 * the ones that caught the real defects here: `setInterval(() => asyncFn())`,
 * `ws.on('message', async …)`, `process.on('SIGTERM', () => shutdown())`.
 */
const MISUSED_PROMISES_OPTIONS = {
  checksVoidReturn: {
    arguments: true,
    attributes: false,
    inheritedMethods: true,
    properties: true,
    returns: true,
    variables: true,
  },
}

const PROMISE_RULES = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': ['error', MISUSED_PROMISES_OPTIONS],
  '@typescript-eslint/await-thenable': 'error',
}

/** One typed block per tsconfig; `project` is what makes the rules type-aware. */
const typedBlock = (files, project, ignores = []) => ({
  files,
  ignores,
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { project, tsconfigRootDir: import.meta.dirname },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: PROMISE_RULES,
})

export default [
  {
    // Explicit, not left to the default: a disable directive for a rule that
    // is not enabled suppresses nothing, and a stale one that survives a fix
    // is how a suppression outlives its reason. Six such directives were in
    // the tree when this config landed; they are gone.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    // `.claude/worktrees` holds other sessions' checkouts of this very repo —
    // linting them would report findings from foreign branches.
    ignores: [
      'dist/**',
      'dist-server/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      '.claude/**',
      'rag-server/**',
    ],
  },
  typedBlock(
    ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts', 'src/preload/**/*.ts'],
    './tsconfig.json',
    ['**/__tests__/**'],
  ),
  typedBlock(['src/main/**/*.ts'], './tsconfig.main.json', ['**/__tests__/**', '**/*.test.ts']),
  typedBlock(['src/server/**/*.ts'], './tsconfig.server.json'),
  typedBlock(['tests/**/*.{ts,tsx}', 'src/**/__tests__/**/*.{ts,tsx}'], './tsconfig.test.json'),
]
