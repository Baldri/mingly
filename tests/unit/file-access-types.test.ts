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
