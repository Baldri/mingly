/**
 * Display name of the external knowledge server.
 *
 * "RAG-Wissen" is Holger's own knowledge base — "not bundled for users", as
 * shared/types.ts says. It leaked to every customer because three places in the
 * renderer repeated it as a fallback literal. One constant now owns the default.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

import { DEFAULT_RAG_SERVER_NAME, resolveRagServerName } from '../../src/shared/rag-server-name'

const RENDERER_DIR = path.resolve(__dirname, '../../src/renderer')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

describe('resolveRagServerName', () => {
  it('falls back to the default when nothing is configured', () => {
    expect(resolveRagServerName(undefined)).toBe(DEFAULT_RAG_SERVER_NAME)
    expect(resolveRagServerName('')).toBe(DEFAULT_RAG_SERVER_NAME)
    expect(resolveRagServerName('   ')).toBe(DEFAULT_RAG_SERVER_NAME)
  })

  it('keeps a name the user chose, trimmed', () => {
    expect(resolveRagServerName('  DocMind  ')).toBe('DocMind')
    expect(resolveRagServerName('Kanzlei-Archiv')).toBe('Kanzlei-Archiv')
  })

  it('does not name a product the customer may not have', () => {
    expect(DEFAULT_RAG_SERVER_NAME).not.toMatch(/RAG-Wissen/i)
    expect(DEFAULT_RAG_SERVER_NAME).not.toMatch(/DocMind/i)
    expect(DEFAULT_RAG_SERVER_NAME).not.toMatch(/Holger/i)
  })
})

describe('renderer sources', () => {
  it('can be scanned (positive control: the scan sees the renderer files)', () => {
    const files = sourceFiles(RENDERER_DIR)

    expect(files.some((f) => f.endsWith('RAGSettingsTab.tsx'))).toBe(true)
    expect(files.some((f) => f.endsWith('SetupWizard.tsx'))).toBe(true)
  })

  it('do not hard-code "RAG-Wissen" as a string a customer can read', () => {
    const offenders = sourceFiles(RENDERER_DIR).flatMap((file) =>
      fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .flatMap((line, index) =>
          /['"`]RAG-Wissen['"`]/.test(line) ? [`${path.relative(RENDERER_DIR, file)}:${index + 1}`] : []
        )
    )

    expect(offenders).toEqual([])
  })
})
