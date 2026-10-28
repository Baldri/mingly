import { describe, it, expect } from 'vitest'
import { isPathSafe } from '../../src/shared/file-access-types'

// Security regression: the granted-directory permission model used a bare
// startsWith(), so a sibling dir sharing the name prefix (/a/photos-evil)
// escaped the grant for /a/photos.
describe('isPathSafe', () => {
  it('allows a file inside the granted directory', () => {
    expect(isPathSafe('/a/photos/x.png', '/a/photos')).toBe(true)
  })
  it('allows the granted directory itself', () => {
    expect(isPathSafe('/a/photos', '/a/photos')).toBe(true)
  })
  it('rejects a sibling directory that shares the name prefix', () => {
    expect(isPathSafe('/a/photos-evil/secret', '/a/photos')).toBe(false)
  })
  it('rejects an unrelated path', () => {
    expect(isPathSafe('/a/other/x', '/a/photos')).toBe(false)
  })
  it('rejects a traversal that resolves outside the grant', () => {
    expect(isPathSafe('/a/photos/../etc/passwd', '/a/photos')).toBe(false)
  })
})

import { isPathWithinAllowedDirs } from '../../src/shared/file-access-types'
describe('isPathWithinAllowedDirs', () => {
  it('accepts a path inside one of the granted dirs', () => {
    expect(isPathWithinAllowedDirs('/a/photos/x', ['/a/docs', '/a/photos'])).toBe(true)
  })
  it('rejects a path outside every granted dir', () => {
    expect(isPathWithinAllowedDirs('/etc/passwd', ['/a/docs', '/a/photos'])).toBe(false)
  })
  it('rejects a sibling-prefix escape of a granted dir', () => {
    expect(isPathWithinAllowedDirs('/a/photos-evil/x', ['/a/photos'])).toBe(false)
  })
  it('rejects everything when no directory is granted', () => {
    expect(isPathWithinAllowedDirs('/a/photos/x', [])).toBe(false)
  })
})

import { parseNetworkShareConfig } from '../../src/shared/file-access-types'

// Security regression: FILE_ACCESS_ADD_NETWORK_SHARE took `config: any` from
// the renderer, so protocol/host/mountPoint were whatever arrived on the wire
// (audit 2026-10-26). Parsing settles the SHAPE; whether a mountPoint may be
// granted is decided separately in FileAccessManager.addNetworkShare.
describe('parseNetworkShareConfig', () => {
  const VALID = { name: 'NAS', protocol: 'smb', host: '192.168.1.100', shareName: 'share' }

  it('accepts a minimal valid config', () => {
    const result = parseNetworkShareConfig(VALID)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.config).toEqual(VALID)
    }
  })

  it('keeps the optional fields it recognises and drops unknown ones', () => {
    const result = parseNetworkShareConfig({
      ...VALID,
      username: 'holger',
      mountPoint: '/Volumes/NAS',
      somethingElse: 'ignored'
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.config.mountPoint).toBe('/Volumes/NAS')
      expect(result.config.username).toBe('holger')
      expect(result.config).not.toHaveProperty('somethingElse')
    }
  })

  it.each([
    ['not an object', 'not an object'],
    ['null', null],
    ['an array', [{ ...VALID }]]
  ])('rejects %s', (_label, raw) => {
    expect(parseNetworkShareConfig(raw)).toEqual({
      valid: false,
      error: 'Network share config must be an object'
    })
  })

  it.each(['ftp', '', undefined, 42, { protocol: 'smb' }])(
    'rejects protocol %o',
    (protocol) => {
      const result = parseNetworkShareConfig({ ...VALID, protocol })
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toContain("'protocol'")
    }
  )

  it.each(['name', 'host', 'shareName'])('requires a non-empty %s', (field) => {
    for (const bad of [undefined, '', '   ', 7, {}]) {
      const result = parseNetworkShareConfig({ ...VALID, [field]: bad })
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toContain(`'${field}'`)
    }
  })

  it('rejects a mountPoint that is not a string', () => {
    const result = parseNetworkShareConfig({ ...VALID, mountPoint: { toString: () => '/' } })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain("'mountPoint' must be a string")
  })

  it('rejects a null byte in a path field', () => {
    const result = parseNetworkShareConfig({ ...VALID, mountPoint: '/Volumes/NAS\0/etc' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('null byte')
  })

  it('rejects an over-long field', () => {
    const result = parseNetworkShareConfig({ ...VALID, host: 'h'.repeat(1025) })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('exceeds')
  })
})
