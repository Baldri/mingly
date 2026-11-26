import { describe, it, expect } from 'vitest'
import { isPathSafe, survivingPermissions, hasPermission, isConfirmationTimestamp } from '../../src/shared/file-access-types'
import type { AllowedDirectory } from '../../src/shared/file-access-types'

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

  it.each([
    ['a newline in host', 'host', 'nas\nEingebunden unter: /Volumes/Harmless'],
    ['a carriage return in the share name', 'shareName', 'share\rfake'],
    ['a bidi override in the name', 'name', 'NAS\u202e/stnuoM/']
  ])('rejects %s (dialog-spoofing vector)', (_label, field, value) => {
    const result = parseNetworkShareConfig({ ...VALID, [field]: value })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('control character')
  })

  it('rejects an over-long field', () => {
    const result = parseNetworkShareConfig({ ...VALID, host: 'h'.repeat(1025) })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('exceeds')
  })
})

// Security: `edit` lets the agent overwrite an EXISTING file, so a persisted
// grant may only keep it when the confirmation marker proves the user
// confirmed it. Local grants used to bypass the marker check entirely.
describe('survivingPermissions', () => {
  const localDir: AllowedDirectory = {
    id: 'local-docs',
    path: '/a/docs',
    name: 'docs',
    location: 'local',
    permissions: ['read'],
    recursive: true,
    grantedAt: 1_700_000_000_000,
    accessCount: 0
  }
  const networkDir: AllowedDirectory = {
    ...localDir,
    id: 'smb://nas/share',
    location: 'network-smb',
    permissions: ['read', 'create']
  }

  it('a local grant without the marker keeps read and create but loses edit', () => {
    const dir: AllowedDirectory = { ...localDir, permissions: ['read', 'create', 'edit'], confirmedAt: undefined }
    expect(survivingPermissions(dir)).toEqual(['read', 'create'])
  })
  it('a local grant with the marker keeps edit', () => {
    const dir: AllowedDirectory = { ...localDir, permissions: ['read', 'edit'], confirmedAt: Date.now() }
    expect(survivingPermissions(dir)).toEqual(['read', 'edit'])
  })
  it('a network grant without the marker survives with nothing', () => {
    expect(survivingPermissions({ ...networkDir, confirmedAt: undefined })).toEqual([])
  })
  it('a network grant with the marker keeps every permission', () => {
    const dir: AllowedDirectory = { ...networkDir, permissions: ['read', 'edit'], confirmedAt: Date.now() }
    expect(survivingPermissions(dir)).toEqual(['read', 'edit'])
  })
  it('a local grant without the marker and without edit is unchanged', () => {
    expect(survivingPermissions({ ...localDir, permissions: ['read-create'] })).toEqual(['read-create'])
  })
  it('an unusable marker is treated as absent', () => {
    for (const bad of [0, -1, NaN, Infinity, '1700000000000' as unknown as number]) {
      expect(survivingPermissions({ ...localDir, permissions: ['edit'], confirmedAt: bad })).toEqual([])
    }
  })
  // The store value arrives through an unchecked cast, and this runs from the
  // FileAccessManager constructor: a malformed entry must grant nothing, never
  // throw at startup.
  it('returns [] when permissions is not a list, with or without a valid marker', () => {
    for (const bad of [undefined, null, 'read', { 0: 'read' }]) {
      for (const confirmedAt of [undefined, Date.now()]) {
        const dir = { ...localDir, permissions: bad as unknown as AllowedDirectory['permissions'], confirmedAt }
        expect(() => survivingPermissions(dir)).not.toThrow()
        expect(survivingPermissions(dir)).toEqual([])
      }
    }
  })
  it('does not mutate the stored permission list', () => {
    const permissions: AllowedDirectory['permissions'] = ['read', 'edit']
    survivingPermissions({ ...localDir, permissions })
    expect(permissions).toEqual(['read', 'edit'])
  })
})

describe('hasPermission', () => {
  const base: AllowedDirectory = {
    id: 'd',
    path: '/a/docs',
    name: 'docs',
    location: 'local',
    permissions: [],
    recursive: true,
    grantedAt: 1,
    accessCount: 0
  }

  it('read-create implies read and create but never edit', () => {
    const dir: AllowedDirectory = { ...base, permissions: ['read-create'] }
    expect(hasPermission(dir, 'read')).toBe(true)
    expect(hasPermission(dir, 'create')).toBe(true)
    expect(hasPermission(dir, 'edit')).toBe(false)
  })
  it('plain read implies neither create nor edit', () => {
    const dir: AllowedDirectory = { ...base, permissions: ['read'] }
    expect(hasPermission(dir, 'read')).toBe(true)
    expect(hasPermission(dir, 'create')).toBe(false)
    expect(hasPermission(dir, 'edit')).toBe(false)
  })
  it('plain create implies neither read nor edit', () => {
    const dir: AllowedDirectory = { ...base, permissions: ['create'] }
    expect(hasPermission(dir, 'create')).toBe(true)
    expect(hasPermission(dir, 'read')).toBe(false)
    expect(hasPermission(dir, 'edit')).toBe(false)
  })
  it('only an explicit edit entry grants edit, and edit grants nothing else', () => {
    const dir: AllowedDirectory = { ...base, permissions: ['edit'] }
    expect(hasPermission(dir, 'edit')).toBe(true)
    expect(hasPermission(dir, 'read')).toBe(false)
    expect(hasPermission(dir, 'create')).toBe(false)
  })
  it('a permissions field that is not a list grants nothing', () => {
    for (const bad of [undefined, null, 'read', { 0: 'read' }]) {
      const dir = { ...base, permissions: bad as unknown as AllowedDirectory['permissions'] }
      for (const needed of ['read', 'create', 'edit'] as const) {
        expect(hasPermission(dir, needed)).toBe(false)
      }
    }
  })
  it('an empty permission list grants nothing', () => {
    for (const needed of ['read', 'create', 'edit'] as const) {
      expect(hasPermission(base, needed)).toBe(false)
    }
  })
})

describe('isConfirmationTimestamp', () => {
  it('accepts a positive finite number', () => {
    expect(isConfirmationTimestamp(1764000000000)).toBe(true)
    expect(isConfirmationTimestamp(1)).toBe(true)
  })
  it('fails closed on everything else', () => {
    for (const v of [0, -1, NaN, Infinity, -Infinity, '1764000000000', null, undefined, {}, []])
      expect(isConfirmationTimestamp(v)).toBe(false)
  })
  // Review Focus 4: ein Zeitstempel in der Zukunft gilt, und das ist Absicht.
  it('accepts a timestamp in the future, by design', () => {
    expect(isConfirmationTimestamp(Date.now() + 10 ** 12)).toBe(true)
  })
})
