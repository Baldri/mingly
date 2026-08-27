/**
 * Loading configuration from a .env file.
 *
 * The Electron app never loaded one, so INFOMANIAK_PRODUCT_ID was unset in a
 * packaged, GUI-launched build and the Swiss endpoint silently failed to
 * register. These tests pin the parts that decide whether that can happen
 * again — and, just as importantly, that an already-set variable wins, so a
 * stale file cannot quietly override the environment a process was started in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvFile, applyEnvFile } from '../../src/main/config/env-file'

describe('parseEnvFile', () => {
  it('reads plain KEY=value pairs', () => {
    expect(parseEnvFile('A=1\nB=two')).toEqual({ A: '1', B: 'two' })
  })

  it('ignores blank lines and comments', () => {
    expect(parseEnvFile('# note\n\nA=1\n   # indented\nB=2')).toEqual({ A: '1', B: '2' })
  })

  it('strips one layer of surrounding quotes', () => {
    expect(parseEnvFile(`A="quoted"\nB='single'\nC=bare`)).toEqual({
      A: 'quoted',
      B: 'single',
      C: 'bare'
    })
  })

  it('keeps everything after the first equals sign', () => {
    expect(parseEnvFile('URL=https://example.invalid/a=b')).toEqual({
      URL: 'https://example.invalid/a=b'
    })
  })

  it('skips malformed lines instead of throwing', () => {
    expect(parseEnvFile('nonsense\nA=1\n=novalue')).toEqual({ A: '1' })
  })

  it('accepts an empty value', () => {
    expect(parseEnvFile('A=')).toEqual({ A: '' })
  })
})

describe('applyEnvFile', () => {
  let dir: string
  const KEY = 'MINGLY_ENV_FILE_TEST_KEY'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mingly-env-'))
    delete process.env[KEY]
  })

  afterEach(() => {
    delete process.env[KEY]
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies the first file that exists and reports which one', () => {
    const file = join(dir, '.env')
    writeFileSync(file, `${KEY}=from-file\n`)

    expect(applyEnvFile([join(dir, 'missing', '.env'), file])).toBe(file)
    expect(process.env[KEY]).toBe('from-file')
  })

  it('never overwrites a variable that is already set', () => {
    process.env[KEY] = 'from-environment'
    writeFileSync(join(dir, '.env'), `${KEY}=from-file\n`)

    applyEnvFile([join(dir, '.env')])

    // A file left over from a previous install must not be able to redirect a
    // process that was started with an explicit value.
    expect(process.env[KEY]).toBe('from-environment')
  })

  it('reports null when no candidate exists', () => {
    expect(applyEnvFile([join(dir, 'nope', '.env')])).toBeNull()
    expect(process.env[KEY]).toBeUndefined()
  })

  it('does not throw when a candidate cannot be read', () => {
    expect(() => applyEnvFile([dir])).not.toThrow()
  })
})
