import { describe, it, expect } from 'vitest'
import { validateCommand } from '../../src/main/utils/mcp-sanitizer'

describe('validateCommand — path validated before basename allowlist', () => {
  it('allows a bare allowlisted command', () => { expect(validateCommand('python3').valid).toBe(true) })
  it('allows an allowlisted binary from a safe directory', () => { expect(validateCommand('/usr/bin/python3').valid).toBe(true) })
  it('rejects an allowlisted basename in an UNSAFE absolute dir', () => { expect(validateCommand('/tmp/evil/python3').valid).toBe(false) })
  it('rejects an allowlisted basename via a RELATIVE path', () => {
    expect(validateCommand('./evil/python3').valid).toBe(false)
    expect(validateCommand('evil/python3').valid).toBe(false)
  })
  it('rejects a bare command not on the allowlist', () => { expect(validateCommand('rm').valid).toBe(false) })
  it('still allows npx package runners', () => { expect(validateCommand('npx some-mcp-server').valid).toBe(true) })
})
