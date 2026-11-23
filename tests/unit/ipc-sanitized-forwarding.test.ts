/**
 * Typed user text reaches the provider in its SANITISED form.
 *
 * The README states that typed text goes out cleaned (invisible characters
 * removed, homoglyphs normalised) while a tool result goes out unchanged. The
 * first half of that sentence hangs on one line in ipc-handlers.ts: if the
 * fallback became the raw `userMessage`, the claim would be false and nothing
 * else in the suite would notice. ipc-handlers has no harness that can run the
 * send path, so this pins the wiring in the source and fails when it is
 * rewritten.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const source = fs.readFileSync(path.resolve(__dirname, '../../src/main/ipc-handlers.ts'), 'utf8')

/** Source without comments, so a comment cannot satisfy the pattern. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('ipc-handlers forwards the sanitiser output for typed text', () => {
  it('derives the forwarded message from inputGuard.sanitizedText', () => {
    expect(code).toMatch(/const\s+cleanedUserMessage\s*=\s*inputGuard\.sanitizedText\s*\?\?\s*userMessage\b/)
  })

  it('hands exactly that cleaned message to the command handler', () => {
    expect(code).toMatch(/extractMessage\(\s*cleanedUserMessage\s*,/)
  })
})
