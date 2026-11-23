/**
 * The directory id and the one-time migration of the two stores keyed by it.
 *
 * Against REAL files in a temp directory, and against fixtures written in the
 * OLD format BY HAND: a fixture produced by the code under test could not
 * falsify the migration. Every expected id is computed outside this process
 * (`printf '%s' <path> | shasum -a 256 | cut -c1-16` and the same with
 * `base64`), so no assertion compares the module against itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { directoryId } from '../../src/main/file-access/directory-id'
import {
  CODING_MODES_SCHEMA_VERSION,
  migrateDirectoryIdStores
} from '../../src/main/file-access/store-migration'

/**
 * Measured outside this process. The three home paths are the collision the
 * fix removes: all three produced the SAME legacy id.
 */
const ALPHA = '/Users/holgervonellerts/projects/alpha'
const BETA = '/Users/holgervonellerts/projects/beta'
const MINGLY = '/Users/holgervonellerts/mingly'
const TMP_X = '/tmp/x'
const SHARE = '/Volumes/share'

const SHA16 = {
  [ALPHA]: 'ae25e3b553a1bc27',
  [BETA]: '43b5de69c974ca8f',
  [MINGLY]: '5d1f128b01c5a1eb',
  [TMP_X]: '2e56aa36f538b33b',
  [SHARE]: '106f88690675f1a3'
} as const

/** What the old `Buffer.from(p).toString('base64').substring(0, 16)` produced. */
const LEGACY16 = {
  [ALPHA]: 'L1VzZXJzL2hvbGdl',
  [BETA]: 'L1VzZXJzL2hvbGdl',
  [MINGLY]: 'L1VzZXJzL2hvbGdl',
  [TMP_X]: 'L3RtcC94',
  [SHARE]: 'L1ZvbHVtZXMvc2hh'
} as const

let dir: string

const accessFile = (): string => path.join(dir, 'file-access.json')
const modesFile = (): string => path.join(dir, 'coding-modes.json')

const write = (file: string, text: string): void => fs.writeFileSync(file, text, 'utf-8')
const read = (file: string): string => fs.readFileSync(file, 'utf-8')
const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(read(file)) as Record<string, unknown>
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const leftovers = (): string[] => fs.readdirSync(dir).filter((n) => n.startsWith('.mingly-tmp-'))

/**
 * A file-access.json as the OLD code wrote it: three sibling projects that all
 * collided on one legacy id, plus a network share (whose id was never
 * path-derived) and an entry with no usable path.
 */
const OLD_FILE_ACCESS = JSON.stringify(
  {
    allowedDirectories: [
      {
        id: LEGACY16[ALPHA],
        path: ALPHA,
        name: 'alpha',
        location: 'local',
        permissions: ['read', 'create', 'edit'],
        recursive: true,
        grantedAt: 1,
        confirmedAt: 1,
        accessCount: 3
      },
      {
        id: LEGACY16[BETA],
        path: BETA,
        name: 'beta',
        location: 'local',
        permissions: ['read'],
        recursive: true,
        grantedAt: 2,
        confirmedAt: 2,
        accessCount: 0
      },
      {
        id: 'smb://nas.local/team',
        path: SHARE,
        name: 'team',
        location: 'network-smb',
        permissions: ['read', 'create'],
        recursive: true,
        networkHost: 'nas.local',
        shareName: 'team',
        grantedAt: 3,
        confirmedAt: 3,
        accessCount: 0
      },
      {
        id: 'no-path-entry',
        name: 'broken',
        location: 'local',
        permissions: ['read'],
        recursive: true,
        grantedAt: 4,
        accessCount: 0
      }
    ],
    unconfirmedDirectories: [
      {
        id: LEGACY16[MINGLY],
        path: MINGLY,
        name: 'mingly',
        location: 'local',
        permissions: [],
        recursive: true,
        grantedAt: 5,
        accessCount: 0
      }
    ]
  },
  null,
  2
)

/** A coding-modes.json as the OLD code wrote it: keyed on the colliding id. */
const OLD_CODING_MODES = JSON.stringify(
  { modes: { [LEGACY16[ALPHA]]: 'propose-run', [LEGACY16[TMP_X]]: 'read-only' } },
  null,
  2
)

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-store-mig-')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('directoryId', () => {
  it('the three measured paths get three DIFFERENT ids', () => {
    const ids = [ALPHA, BETA, MINGLY].map(directoryId)
    expect(ids).toEqual([SHA16[ALPHA], SHA16[BETA], SHA16[MINGLY]])
    expect(new Set(ids).size).toBe(3)
  })

  it('the legacy form collided on exactly those three paths (what is being fixed)', () => {
    // Not the code under test — the old expression, spelled out, against the
    // values measured outside this process.
    const legacy = (p: string): string => Buffer.from(p).toString('base64').substring(0, 16)
    expect([legacy(ALPHA), legacy(BETA), legacy(MINGLY)]).toEqual([
      LEGACY16[ALPHA],
      LEGACY16[BETA],
      LEGACY16[MINGLY]
    ])
    expect(new Set([legacy(ALPHA), legacy(BETA), legacy(MINGLY)]).size).toBe(1)
    // The control the finding used: a short path outside a home does differ.
    expect(legacy(TMP_X)).toBe(LEGACY16[TMP_X])
  })

  it('is deterministic: the same path gives the same id (every grant depends on it)', () => {
    expect(directoryId(ALPHA)).toBe(directoryId(ALPHA))
    expect(directoryId(SHARE)).toBe(SHA16[SHARE])
  })

  it('is 16 lowercase hex characters and carries no readable path', () => {
    for (const p of [ALPHA, BETA, MINGLY, TMP_X, SHARE]) {
      const id = directoryId(p)
      expect(id).toMatch(/^[0-9a-f]{16}$/)
      // The old id decoded back into a path prefix; this one must not.
      expect(Buffer.from(id, 'base64').toString('utf-8')).not.toContain('/')
    }
  })
})

describe('migrateDirectoryIdStores: file-access.json', () => {
  it('re-keys every LOCAL grant from its own path, in both grant lists', () => {
    write(accessFile(), OLD_FILE_ACCESS)

    migrateDirectoryIdStores(dir)

    const store = readJson(accessFile())
    const dirs = store.allowedDirectories as Array<Record<string, unknown>>
    expect(dirs.map((d) => d.id)).toEqual([
      SHA16[ALPHA],
      SHA16[BETA],
      'smb://nas.local/team',
      'no-path-entry'
    ])
    // The three colliding grants are now three distinct keys.
    expect(new Set([dirs[0].id, dirs[1].id]).size).toBe(2)
    const parked = store.unconfirmedDirectories as Array<Record<string, unknown>>
    expect(parked.map((d) => d.id)).toEqual([SHA16[MINGLY]])
  })

  it('keeps every other field of a grant untouched', () => {
    write(accessFile(), OLD_FILE_ACCESS)

    migrateDirectoryIdStores(dir)

    const before = (JSON.parse(OLD_FILE_ACCESS) as Record<string, unknown>)
      .allowedDirectories as Array<Record<string, unknown>>
    const after = readJson(accessFile()).allowedDirectories as Array<Record<string, unknown>>
    for (let i = 0; i < before.length; i++) {
      expect({ ...after[i], id: before[i].id }).toEqual(before[i])
    }
  })

  it('a NETWORK grant keeps its structural id (addNetworkShare finds it by that)', () => {
    write(accessFile(), OLD_FILE_ACCESS)

    migrateDirectoryIdStores(dir)

    const dirs = readJson(accessFile()).allowedDirectories as Array<Record<string, unknown>>
    const share = dirs.find((d) => d.location === 'network-smb')
    expect(share?.id).toBe('smb://nas.local/team')
    expect(share?.id).not.toBe(SHA16[SHARE])
  })

  it('is idempotent: the second run leaves the file byte-identical and writes nothing new', () => {
    write(accessFile(), OLD_FILE_ACCESS)
    migrateDirectoryIdStores(dir)
    const first = read(accessFile())
    const firstMtime = fs.statSync(accessFile()).mtimeMs

    migrateDirectoryIdStores(dir)
    migrateDirectoryIdStores(dir)

    expect(sha(read(accessFile()))).toBe(sha(first))
    expect(fs.statSync(accessFile()).mtimeMs).toBe(firstMtime)
    expect(leftovers()).toEqual([])
  })

  it('an interrupted migration is completable: the OLD file is migrated on a later start', () => {
    // What an interruption leaves is one of the two whole files (temp-and-rename).
    // The "old file survived" case is the one that still has work to do.
    write(accessFile(), OLD_FILE_ACCESS)
    migrateDirectoryIdStores(dir)
    const done = read(accessFile())

    write(accessFile(), OLD_FILE_ACCESS)
    migrateDirectoryIdStores(dir)

    expect(read(accessFile())).toBe(done)
    expect(leftovers()).toEqual([])
  })

  it('leaves no temp file behind and never writes in place', () => {
    write(accessFile(), OLD_FILE_ACCESS)
    const inode = fs.statSync(accessFile()).ino

    migrateDirectoryIdStores(dir)

    expect(leftovers()).toEqual([])
    // A rename over the target gives the path a NEW inode; an in-place write
    // would keep the old one.
    expect(fs.statSync(accessFile()).ino).not.toBe(inode)
  })

  it('a damaged file is moved aside with its bytes, not overwritten', () => {
    const garbage = '{ this is not json'
    write(accessFile(), garbage)

    migrateDirectoryIdStores(dir)

    expect(fs.existsSync(accessFile())).toBe(false)
    const aside = fs.readdirSync(dir).filter((n) => n.startsWith('file-access.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(read(path.join(dir, aside[0]))).toBe(garbage)
  })

  it('a missing file and a missing directory are nothing to do, not an error', () => {
    expect(() => migrateDirectoryIdStores(dir)).not.toThrow()
    expect(fs.existsSync(accessFile())).toBe(false)
    expect(() => migrateDirectoryIdStores(path.join(dir, 'does-not-exist'))).not.toThrow()
  })

  /**
   * What an interruption can actually leave behind, and that none of it is a
   * state a later start cannot read. Two cases:
   *
   *  - the WRITE failed (no permission, no space): the temp file is cleaned up
   *    and the original file is untouched, so the next start migrates it.
   *  - the process DIED between writing the temp file and the rename: the
   *    original file is untouched (rename is atomic inside one file system) and
   *    a stray `.mingly-tmp-*` is left, which nothing reads.
   */
  it('a write that fails leaves the ORIGINAL file intact, and a later start completes it', () => {
    write(accessFile(), OLD_FILE_ACCESS)
    // No new entries in the directory: the temp file cannot be created.
    fs.chmodSync(dir, 0o500)
    try {
      expect(() => migrateDirectoryIdStores(dir)).not.toThrow()
      expect(read(accessFile())).toBe(OLD_FILE_ACCESS)
    } finally {
      fs.chmodSync(dir, 0o700)
    }

    migrateDirectoryIdStores(dir)

    const dirs = readJson(accessFile()).allowedDirectories as Array<Record<string, unknown>>
    expect(dirs[0].id).toBe(SHA16[ALPHA])
    expect(leftovers()).toEqual([])
  })

  it('a stray temp file from a killed process is ignored, and the migration still runs', () => {
    write(accessFile(), OLD_FILE_ACCESS)
    write(path.join(dir, '.mingly-tmp-deadbeefdeadbeef'), 'half a store')

    migrateDirectoryIdStores(dir)

    const dirs = readJson(accessFile()).allowedDirectories as Array<Record<string, unknown>>
    expect(dirs[0].id).toBe(SHA16[ALPHA])
    // Left where it is: nothing reads it, and deleting a file this code did not
    // write in this run would be a guess about whose it is.
    expect(leftovers()).toEqual(['.mingly-tmp-deadbeefdeadbeef'])
  })

  it('a store whose grant list is not a list is left alone', () => {
    write(accessFile(), JSON.stringify({ allowedDirectories: 'nonsense', other: 1 }))

    migrateDirectoryIdStores(dir)

    expect(readJson(accessFile())).toEqual({ allowedDirectories: 'nonsense', other: 1 })
  })
})

describe('migrateDirectoryIdStores: coding-modes.json', () => {
  it('discards every stored mode and stamps the schema version', () => {
    write(modesFile(), OLD_CODING_MODES)

    migrateDirectoryIdStores(dir)

    const store = readJson(modesFile())
    expect(store.modes).toBeUndefined()
    expect(store.schemaVersion).toBe(CODING_MODES_SCHEMA_VERSION)
    // The `propose-run` that was stored under the colliding key is gone.
    expect(read(modesFile())).not.toContain('propose-run')
  })

  it('does not run twice: a mode chosen after the migration holds', () => {
    write(modesFile(), OLD_CODING_MODES)
    migrateDirectoryIdStores(dir)

    // What setMode writes once the user grades a project again.
    write(
      modesFile(),
      JSON.stringify({
        schemaVersion: CODING_MODES_SCHEMA_VERSION,
        modes: { [SHA16[ALPHA]]: 'propose-run' }
      })
    )
    migrateDirectoryIdStores(dir)

    const store = readJson(modesFile())
    expect(store.modes).toEqual({ [SHA16[ALPHA]]: 'propose-run' })
    expect(store.schemaVersion).toBe(CODING_MODES_SCHEMA_VERSION)
  })

  it('keeps other keys of the file, and leaves no temp file', () => {
    write(modesFile(), JSON.stringify({ modes: { a: 'propose' }, somethingElse: 'keep me' }))

    migrateDirectoryIdStores(dir)

    expect(readJson(modesFile())).toEqual({
      schemaVersion: CODING_MODES_SCHEMA_VERSION,
      somethingElse: 'keep me'
    })
    expect(leftovers()).toEqual([])
  })

  it('a damaged file is moved aside, which is also the strict side (no modes = off)', () => {
    write(modesFile(), 'not json at all')

    migrateDirectoryIdStores(dir)

    expect(fs.existsSync(modesFile())).toBe(false)
    expect(
      fs.readdirSync(dir).filter((n) => n.startsWith('coding-modes.json.corrupt-'))
    ).toHaveLength(1)
  })

  it('migrates both files in one call, in either order of what is present', () => {
    write(accessFile(), OLD_FILE_ACCESS)
    write(modesFile(), OLD_CODING_MODES)

    migrateDirectoryIdStores(dir)

    const dirs = readJson(accessFile()).allowedDirectories as Array<Record<string, unknown>>
    expect(dirs[0].id).toBe(SHA16[ALPHA])
    expect(readJson(modesFile()).modes).toBeUndefined()
  })
})
