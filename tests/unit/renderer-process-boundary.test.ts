/**
 * The renderer must not import from the Electron main process.
 *
 * `tsconfig.json` covers only src/renderer, src/shared and src/preload — but
 * TypeScript follows imports past that boundary. Every such import grafts a
 * piece of the main-process module graph onto the renderer's type-check, and
 * it grows on its own: a new import inside the main-process file extends the
 * renderer's graph without anyone touching the renderer.
 *
 * That is not hypothetical. Adding a guard import to hybrid-orchestrator.ts
 * (PR #26) extended the renderer's graph through orchestrator-store.ts down to
 * src/main/database/index.ts, whose `sql.js` dependency ships no types and has
 * no @types package installed. `npm run typecheck` failed with TS7016 in a
 * file nobody had edited.
 *
 * Types the UI renders belong in src/shared. This test is what keeps the next
 * one from creeping back — a review will not catch a single import line.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const RENDERER_ROOT = resolve(process.cwd(), 'src/renderer')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** Matches `from '../../main/...'` and `import('../main/...')` alike. */
const CROSSES_BOUNDARY = /(?:from|import\()\s*['"](?:\.\.?\/)+main\/[^'"]*['"]/g

describe('renderer/main process boundary', () => {
  const files = sourceFiles(RENDERER_ROOT)

  it('finds renderer sources to check', () => {
    // Without this the assertion below would pass vacuously on an empty set.
    expect(files.length).toBeGreaterThan(10)
  })

  it('has no import from src/main anywhere in src/renderer', () => {
    const offenders: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(CROSSES_BOUNDARY)) {
        offenders.push(`${relative(process.cwd(), file)}: ${match[0]}`)
      }
    }

    expect(
      offenders,
      `The renderer must not reach into the main process. Move the type to ` +
        `src/shared and re-export it from the main-process module, as ` +
        `src/shared/orchestrator-types.ts does.\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
