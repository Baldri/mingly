/**
 * R35: the project path of a coding run is derived in the main process from the
 * grant for `directoryId`. A path the renderer supplies is a CLAIM, checked
 * against the grant and REJECTED on mismatch. It is never corrected: a
 * correction would destroy the one signal that the renderer tried.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  resolveCodingRun,
  setCodingModeForDirectory,
  getPendingPackage,
  type CodingRunDeps
} from '../../src/main/coding/coding-run-request'
import { packageDigest } from '../../src/main/coding/edit-proposals'
import type { AllowedDirectory } from '../../src/shared/file-access-types'
import type { CodingMode, ProposedEdit } from '../../src/shared/coding-types'

const GRANT: AllowedDirectory = {
  id: 'd1',
  path: '/Users/x/proj',
  name: 'proj',
  location: 'local',
  permissions: ['read', 'create', 'edit'],
  recursive: true,
  grantedAt: 1,
  confirmedAt: 1,
  accessCount: 0
}

function deps(over: Partial<CodingRunDeps> = {}, grant: AllowedDirectory | undefined = GRANT): CodingRunDeps {
  return {
    findGrant: async (id) => (grant && id === grant.id ? grant : undefined),
    getMode: () => 'propose',
    setMode: vi.fn(),
    ...over
  }
}

describe('resolveCodingRun (R35)', () => {
  it('derives the project path from the grant when the renderer sends none', async () => {
    const out = await resolveCodingRun({ directoryId: 'd1' }, deps())
    expect(out).toEqual({
      kind: 'resolved',
      coding: { directoryId: 'd1', projectPath: '/Users/x/proj', mode: 'propose' }
    })
  })

  it.each([
    ['an unrelated directory', '/etc'],
    ['a parent of the grant', '/Users/x'],
    ['a parent reached through ..', '/Users/x/proj/../..'],
    ['a subdirectory of the grant', '/Users/x/proj/sub'],
    ['an empty string', ''],
    ['null', null],
    ['a non-string', 42]
  ])('REJECTS a projectPath that is %s, and does not correct it', async (_name, claimed) => {
    const out = await resolveCodingRun({ directoryId: 'd1', projectPath: claimed }, deps())
    expect(out.kind).toBe('refused')
    // Not corrected: there is no `coding` to run with.
    expect('coding' in out).toBe(false)
  })

  it('accepts a claim that equals the grant path (positive control for the rejections above)', async () => {
    const out = await resolveCodingRun({ directoryId: 'd1', projectPath: '/Users/x/proj' }, deps())
    expect(out.kind).toBe('resolved')
  })

  it('refuses an unknown directory id', async () => {
    const out = await resolveCodingRun({ directoryId: 'nope' }, deps())
    expect(out.kind).toBe('refused')
  })

  it.each([[undefined], [null], ['d1'], [[]], [{}], [{ directoryId: '' }], [{ directoryId: 7 }]])(
    'refuses a malformed request %j',
    async (raw) => {
      const out = await resolveCodingRun(raw, deps())
      expect(out.kind).toBe('refused')
    }
  )

  it('refuses a grant without the read permission', async () => {
    const noRead: AllowedDirectory = { ...GRANT, permissions: ['create'] }
    const out = await resolveCodingRun({ directoryId: 'd1' }, deps({}, noRead))
    expect(out.kind).toBe('refused')
  })

  it('takes the mode from the store; a different claimed mode is refused, not overridden', async () => {
    const claim = await resolveCodingRun({ directoryId: 'd1', mode: 'propose-run' }, deps())
    expect(claim.kind).toBe('refused')
    const same = await resolveCodingRun({ directoryId: 'd1', mode: 'propose' }, deps())
    expect(same.kind).toBe('resolved')
  })

  it('an unreadable mode store resolves to a refusal, not to a run', async () => {
    const out = await resolveCodingRun(
      { directoryId: 'd1' },
      deps({
        getMode: () => {
          throw new Error('disk')
        }
      })
    )
    expect(out.kind).toBe('refused')
  })
})

describe('setCodingModeForDirectory', () => {
  it('stores a listed mode for a known grant', async () => {
    const d = deps()
    const out = await setCodingModeForDirectory('d1', 'read-only', d)
    expect(out).toEqual({ kind: 'set', mode: 'read-only' })
    expect(d.setMode).toHaveBeenCalledWith('d1', 'read-only')
  })

  it.each(['auto', 'AUTO', 'propose ', '', 'toString', 7, null, undefined])(
    'refuses %j and stores nothing (no silent coercion to off)',
    async (mode) => {
      const d = deps()
      const out = await setCodingModeForDirectory('d1', mode, d)
      expect(out.kind).toBe('refused')
      expect(d.setMode).not.toHaveBeenCalled()
    }
  )

  it('refuses a mode for a directory that is not a grant', async () => {
    const d = deps()
    const out = await setCodingModeForDirectory('ghost', 'propose', d)
    expect(out.kind).toBe('refused')
    expect(d.setMode).not.toHaveBeenCalled()
  })

  it.each<CodingMode>(['propose', 'propose-run'])(
    'refuses %s on a grant that cannot be edited',
    async (mode) => {
      const readOnlyGrant: AllowedDirectory = { ...GRANT, permissions: ['read'] }
      const d = deps({}, readOnlyGrant)
      const out = await setCodingModeForDirectory('d1', mode, d)
      expect(out.kind).toBe('refused')
      expect(d.setMode).not.toHaveBeenCalled()
    }
  )

  it('allows read-only on a grant without edit', async () => {
    const readOnlyGrant: AllowedDirectory = { ...GRANT, permissions: ['read'] }
    const d = deps({}, readOnlyGrant)
    expect((await setCodingModeForDirectory('d1', 'read-only', d)).kind).toBe('set')
  })
})

describe('getPendingPackage', () => {
  const edit: ProposedEdit = {
    path: 'src/a.ts',
    oldText: 'SECRET OLD FILE TEXT',
    newText: 'SECRET NEW FILE TEXT',
    diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y',
    addedLines: 1,
    removedLines: 1,
    introducesHiddenCharacters: false,
    baseSha256: 'ab'.repeat(32),
    matchIndex: 0
  }

  it('returns the digest of the FULL package and a view without file text', () => {
    const out = getPendingPackage('run_1', {
      store: { pending: () => [edit] },
      runDirectories: { get: () => 'd1' }
    })
    expect(out.kind).toBe('pending')
    if (out.kind !== 'pending') return
    expect(out.digest).toBe(packageDigest([edit]))
    expect(out.directoryId).toBe('d1')
    expect(out.edits).toEqual([
      {
        path: 'src/a.ts',
        diff: edit.diff,
        addedLines: 1,
        removedLines: 1,
        introducesHiddenCharacters: false
      }
    ])
    expect(JSON.stringify(out)).not.toContain('SECRET')
  })

  it('refuses a malformed run id', () => {
    const out = getPendingPackage(42, { store: { pending: () => [edit] }, runDirectories: { get: () => 'd1' } })
    expect(out.kind).toBe('refused')
  })
})
