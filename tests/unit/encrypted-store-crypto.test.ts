import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gcmEncrypt, gcmDecrypt, deriveKeyFromPath, getOrCreateRandomKey } from '../../src/main/utils/encrypted-store-crypto'

const tmps: string[] = []
const mkTmp = () => { const d = mkdtempSync(join(tmpdir(), 'es-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('encrypted-store crypto', () => {
  it('round-trips with a random key', () => {
    const key = getOrCreateRandomKey(join(mkTmp(), 'k'))
    const entry = gcmEncrypt('s3cret', key)
    expect(gcmDecrypt(entry, key)).toBe('s3cret')
  })
  it('a wrong key fails the auth tag (no silent mis-decrypt)', () => {
    const e = gcmEncrypt('x', getOrCreateRandomKey(join(mkTmp(), 'a')))
    expect(() => gcmDecrypt(e, getOrCreateRandomKey(join(mkTmp(), 'b')))).toThrow()
  })
  it('getOrCreateRandomKey persists and returns the SAME key, not derivable from a path', () => {
    const p = join(mkTmp(), 'k')
    const k1 = getOrCreateRandomKey(p)
    const k2 = getOrCreateRandomKey(p)
    expect(k1.equals(k2)).toBe(true)
    expect(k1.length).toBe(32)
    expect(existsSync(p)).toBe(true)
  })
  it('writes the key file with owner-only (0600) permissions', () => {
    const p = join(mkTmp(), 'k')
    getOrCreateRandomKey(p)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
  it('legacy path-derived data still decrypts (backward compatibility)', () => {
    const legacy = deriveKeyFromPath('/some/userData/path')
    const entry = gcmEncrypt('old', legacy)
    expect(gcmDecrypt(entry, deriveKeyFromPath('/some/userData/path'))).toBe('old')
  })
})
