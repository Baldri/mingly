/**
 * The version the UI shows must be the version that ships.
 *
 * `src/renderer/App.tsx` carried the literal `Mingly v0.5.0` in its footer
 * while package.json said 0.7.2 — a number that was right once and then went
 * stale silently, because nothing connects the two. The fix routes it through a
 * build-time constant, and these tests hold each link of that chain:
 *
 *   package.json version  ->  vite `define.__APP_VERSION__`  ->  App.tsx
 *   electron-builder.yml must not override the version on top of that
 *
 * WHAT THIS DOES NOT CHECK, and what covers it instead:
 *
 *  - The rendered DOM. There is no @testing-library/react here, and pulling a
 *    full `vite build` into the unit suite to inspect the artefact would cost
 *    seconds per run for a footer string.
 *  - Whether the `__APP_VERSION__` DECLARATION is actually visible to App.tsx.
 *    `npm run typecheck` is the sharper instrument for that and it caught a
 *    real mistake while this was written: the declaration first went to the
 *    top level of `src/renderer/global.d.ts`, which is a module (it has an
 *    `import type` and an `export {}`), so it was module-local and compiled to
 *    `TS2304: Cannot find name '__APP_VERSION__'` — with all five assertions
 *    below green. Reading source is not measuring effect; that is why the gap
 *    is named here instead of being assumed away.
 *
 * The electron-builder assertion is the point of the whole file. A build-time
 * constant from package.json is only correct while packaging does not rewrite
 * the version — `extraMetadata` already rewrites `name` and `productName`
 * here. That assumption is machine-checked rather than left in a comment,
 * because an assumption in a comment is exactly how `v0.5.0` survived.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf-8')
}

const pkg = JSON.parse(read('package.json')) as { version: string }

describe('the app version the UI shows', () => {
  it('package.json carries a plain semver version', () => {
    // Positive control for every assertion below: if this is not a version,
    // comparing against it proves nothing.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('vite defines __APP_VERSION__ as exactly that version', async () => {
    const mod = await import('../../vite.config')
    const config = mod.default as { define?: Record<string, string> }
    expect(config.define, 'vite config has no define block').toBeDefined()
    expect(config.define?.__APP_VERSION__).toBe(JSON.stringify(pkg.version))
  })

  it('App.tsx reads the constant instead of spelling a version out', () => {
    const app = read('src/renderer/App.tsx')
    expect(app).toContain('__APP_VERSION__')
  })

  it('no renderer source spells out a vX.Y.Z literal', () => {
    // The defect as a class, not just its one instance: any such literal in
    // the renderer is a number that can go stale without anything noticing.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        const text = fs.readFileSync(full, 'utf-8')
        text.split('\n').forEach((line, i) => {
          // A URL may legitimately contain a version; a displayed string may not.
          if (/v\d+\.\d+\.\d+/.test(line) && !line.includes('http')) {
            offenders.push(`${path.relative(ROOT, full)}:${i + 1}: ${line.trim()}`)
          }
        })
      }
    }
    walk(path.join(ROOT, 'src/renderer'))
    expect(offenders).toEqual([])
  })

  it('electron-builder does not rewrite the version on top of package.json', () => {
    // If it ever does, the build-time constant becomes a lie and this file's
    // whole approach is wrong — which is why this is an assertion and not a
    // comment. `name` and `productName` ARE rewritten, so the mechanism is
    // live in this project, not hypothetical.
    const yml = read('electron-builder.yml')
    const extra = yml.split('\n')
    const start = extra.findIndex((l) => l.trimEnd() === 'extraMetadata:')
    // Positive control: the block exists and does rewrite something, so a
    // "no version here" result is a real reading and not an empty search.
    expect(start, 'extraMetadata block not found').toBeGreaterThanOrEqual(0)
    const block: string[] = []
    for (let i = start + 1; i < extra.length; i++) {
      if (extra[i].trim() === '') continue
      if (!/^\s+\S/.test(extra[i])) break
      block.push(extra[i].trim())
    }
    expect(block.length, 'extraMetadata block is empty').toBeGreaterThan(0)
    expect(block.some((l) => l.startsWith('name:'))).toBe(true)
    expect(block.some((l) => l.startsWith('version:'))).toBe(false)
  })
})
