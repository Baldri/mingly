/**
 * Snapshot, atomic write and undo (Task 11).
 *
 * The first and only code that writes to a user's files, so the tests run
 * against real files in a real temp directory and check the bytes on disk, not
 * the return value alone. Nothing here depends on the clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import {
  applyPendingEdits,
  undoRun,
  writeFileAtomic,
  acceptEditsForRun,
  rejectEditsForRun,
  undoRunForDirectory,
  type ApplyDeps
} from '../../src/main/coding/apply-edits'
import { createEditProposalStore, type EditProposalStore } from '../../src/main/coding/edit-proposals'
import { ensureProjectWorkspace, type ProjectWorkspace } from '../../src/main/coding/project-workspace'
import type { AllowedDirectory } from '../../src/shared/file-access-types'
import type { CodingMode } from '../../src/shared/coding-types'

const RUN = 'run1'
const ORIGINAL = 'line one\nconst a = 1\nline three\nfooter text\n'

let project: string
let outside: string
let ws: ProjectWorkspace
let store: EditProposalStore
let grants: AllowedDirectory[]
let modes: Map<string, CodingMode>
let extraDeps: Partial<ApplyDeps>

function grant(overrides: Partial<AllowedDirectory> = {}): AllowedDirectory {
  return {
    id: 'dir-1',
    path: project,
    name: 'p',
    location: 'local',
    permissions: ['read', 'edit'],
    recursive: true,
    grantedAt: 1,
    confirmedAt: 1,
    ...overrides
  }
}

function deps(): ApplyDeps {
  return {
    store,
    findGrant: async (id) => grants.find((g) => g.id === id),
    getMode: (id) => modes.get(id) ?? 'off',
    ...extraDeps
  }
}

function write(rel: string, content: string): string {
  const full = path.join(project, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

function read(full: string): string {
  return fs.readFileSync(full, 'utf8')
}

function sha(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

/** Propose against the file as it is on disk right now, like edit_file does. */
function propose(rel: string, oldText: string, newText: string, runId = RUN): void {
  const content = fs.readFileSync(path.join(project, rel), 'utf8')
  const outcome = store.propose(runId, 1, { path: rel, oldText, newText }, content)
  expect(outcome.kind).toBe('proposed')
}

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes('.tmp'))
}

beforeEach(async () => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-outside-')))
  grants = [grant()]
  modes = new Map([['dir-1', 'propose']])
  store = createEditProposalStore()
  extraDeps = {}
  ws = await ensureProjectWorkspace(project, RUN)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('applyPendingEdits: the happy path and the snapshot', () => {
  it('applies the pending proposals and reports the real paths', async () => {
    const a = write('src/a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('src/a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out).toEqual({ kind: 'applied', paths: ['src/a.ts', 'b.ts'] })
    expect(read(a)).toBe('line one\nconst a = 2\nline three\nfooter text\n')
    expect(read(b)).toBe('x = 2\n')
  })

  it('snapshots before the first write: at the first rename the snapshot already holds the old content', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const realRename = fs.promises.rename.bind(fs.promises)
    const seen: string[] = []
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // Only the rename that overwrites the project file counts (the manifest
      // is written with a rename too, into the snapshot batch).
      if (String(to) === a) {
        const batch = path.join(ws.snapshotDir, 'batch-1')
        for (const name of fs.readdirSync(batch)) {
          if (name.endsWith('.bak')) seen.push(read(path.join(batch, name)))
        }
      }
      return realRename(from, to)
    })
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('applied')
    expect(seen).toEqual([ORIGINAL])
    expect(read(a)).not.toBe(ORIGINAL)
  })

  it('writes nothing when the snapshot fails', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    // The snapshot directory is replaced by a file: nothing can be put in it.
    fs.rmSync(ws.snapshotDir, { recursive: true, force: true })
    fs.writeFileSync(ws.snapshotDir, 'not a directory')
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(leftovers(project)).toEqual([])
  })

  it('bounds the TOTAL snapshot size, not each file: three small files over the budget write nothing', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts'].map((n) => write(n, 'x = 1\n' + 'y'.repeat(600) + '\n'))
    for (const n of ['a.ts', 'b.ts', 'c.ts']) propose(n, 'x = 1', 'x = 2')
    extraDeps = { maxSnapshotBytes: 1500 }
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    for (const f of files) expect(read(f)).toMatch(/^x = 1\n/)
    expect(fs.readdirSync(ws.snapshotDir)).toEqual([])
  })

  it('refuses when nothing is pending', async () => {
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
  })
})

describe('applyPendingEdits: grant and mode are checked again, right before the write', () => {
  it('refuses when the grant lost edit between acceptance and write', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    grants = [grant({ permissions: ['read'] })]
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
  })

  it('refuses when the grant is gone altogether', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const stale = grants[0]
    grants = []
    expect((await applyPendingEdits(RUN, ws, stale, deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
  })

  it.each<CodingMode>(['off', 'read-only'])('refuses when the mode dropped to %s', async (mode) => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    modes.set('dir-1', mode)
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
  })
})

describe('applyPendingEdits: R67, the proof that the file is the one the diff was computed against', () => {
  it('positive control: the unchanged file applies', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    expect(read(a)).toContain('const a = 2')
  })

  it('refuses when the user edited the file AT the match', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const edited = ORIGINAL.replace('const a = 1', 'const a = 1 // mine')
    fs.writeFileSync(a, edited)
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(edited)
  })

  it('refuses when the user edited the file OUTSIDE the match, although the old text still occurs exactly once', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const edited = ORIGINAL.replace('footer text', 'footer text, changed by the user')
    fs.writeFileSync(a, edited)
    // Control: the old text is still there exactly once, so a re-count would pass.
    expect(edited.split('const a = 1').length - 1).toBe(1)
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(edited)
  })

  it('refuses a proposal of a second run on a file the first run already changed', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2', 'runA')
    propose('a.ts', 'line three', 'line 3', 'runB')
    const wsA = await ensureProjectWorkspace(project, 'runA')
    const wsB = await ensureProjectWorkspace(project, 'runB')
    expect((await applyPendingEdits('runA', wsA, grants[0], deps())).kind).toBe('applied')
    const afterA = read(a)
    expect((await applyPendingEdits('runB', wsB, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(afterA)
  })
})

describe('applyPendingEdits: atomic write', () => {
  it('leaves the file fully old when the rename fails, and no temp file behind', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('EIO simulated'))
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(leftovers(project)).toEqual([])
  })

  it('rolls the first file back when the second write fails, so nothing is half applied', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    const realRename = fs.promises.rename.bind(fs.promises)
    let writesToB = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // Fail the overwrite of b.ts only; the rollback of a.ts must still work.
      if (String(to) === b) {
        writesToB++
        throw new Error('EIO simulated on the second file')
      }
      return realRename(from, to)
    })
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(writesToB).toBe(1)
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe('x = 1\n')
    expect(leftovers(project)).toEqual([])
  })

  it('writes the temp file in the target directory, not in the system temp directory', async () => {
    const a = write('deep/er/a.ts', ORIGINAL)
    const realRename = fs.promises.rename.bind(fs.promises)
    const moves: Array<[string, string]> = []
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      moves.push([String(from), String(to)])
      return realRename(from, to)
    })
    await writeFileAtomic(a, 'new content\n')
    expect(moves).toHaveLength(1)
    expect(path.dirname(moves[0][0])).toBe(path.dirname(a))
    expect(path.dirname(moves[0][0])).not.toBe(os.tmpdir())
    expect(moves[0][1]).toBe(a)
    expect(read(a)).toBe('new content\n')
  })

  it('keeps the permission bits of the file it replaces', async () => {
    const a = write('tool.ts', ORIGINAL)
    fs.chmodSync(a, 0o750)
    propose('tool.ts', 'const a = 1', 'const a = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    expect(fs.statSync(a).mode & 0o777).toBe(0o750)
  })
})

describe('applyPendingEdits: R69, how the identity check is called', () => {
  it('(1) refuses two hard links to one file and writes neither', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = path.join(project, 'b.ts')
    fs.linkSync(a, b)
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'footer text', 'footer')
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe(ORIGINAL)
  })

  it('(1) checks and writes one file at a time: a change that lands after file 1 was written refuses file 2 and rolls file 1 back', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    const userEdit = 'x = 1\n// the user was here\n'
    extraDeps = {
      hooks: {
        afterWrite: (index) => {
          if (index === 0) fs.writeFileSync(b, userEdit)
        }
      }
    }
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe(userEdit)
  })

  it('(2) resolves the path again: a file swapped for a link to a file outside is refused', async () => {
    const a = write('a.ts', ORIGINAL)
    const outsideFile = path.join(outside, 'a.ts')
    fs.writeFileSync(outsideFile, ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    fs.rmSync(a)
    fs.symlinkSync(outsideFile, a)
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(outsideFile)).toBe(ORIGINAL)
  })

  it('(2) the blocklist runs again on the resolved path: a link to .env inside the project is refused', async () => {
    const a = write('a.ts', ORIGINAL)
    const env = write('.env', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    fs.rmSync(a)
    fs.symlinkSync(env, a)
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(env)).toBe(ORIGINAL)
  })

  it('(3) the write is tied to the file that was verified: a path swapped for another file after the check is refused', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const impostor = ORIGINAL // same bytes, different inode
    extraDeps = {
      hooks: {
        afterVerify: () => {
          fs.rmSync(a)
          fs.writeFileSync(a, impostor)
        }
      }
    }
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(impostor)
    expect(leftovers(project)).toEqual([])
  })

  it('(3) a path swapped for a link to the outside after the check never writes outside', async () => {
    const a = write('a.ts', ORIGINAL)
    const outsideFile = path.join(outside, 'a.ts')
    fs.writeFileSync(outsideFile, ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    extraDeps = {
      hooks: {
        afterVerify: () => {
          fs.rmSync(a)
          fs.symlinkSync(outsideFile, a)
        }
      }
    }
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(outsideFile)).toBe(ORIGINAL)
  })
})

describe('applyPendingEdits: the blocklist and the workspace hold on the write path too', () => {
  it('refuses a proposal whose path is blocked, as given', async () => {
    const env = write('.env', 'KEY=1\n')
    // edit_file would never record this; the store accepts any string, so the
    // write path must not rely on who filled it.
    const outcome = store.propose(RUN, 1, { path: '.env', oldText: 'KEY=1', newText: 'KEY=2' }, 'KEY=1\n')
    expect(outcome.kind).toBe('proposed')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(env)).toBe('KEY=1\n')
  })

  it('refuses a proposal inside the .mingly workspace, so the snapshots cannot be rewritten', async () => {
    const note = write('.mingly/context/notes.md', 'old note\n')
    const outcome = store.propose(
      RUN,
      1,
      { path: '.mingly/context/notes.md', oldText: 'old note', newText: 'new note' },
      'old note\n'
    )
    expect(outcome.kind).toBe('proposed')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(note)).toBe('old note\n')
  })

  it('gives one and the same reason for every refusal that depends on the file system', async () => {
    const reasons = new Set<string>()
    const attempt = async (setup: () => void): Promise<void> => {
      store = createEditProposalStore()
      write('victim.ts', ORIGINAL)
      propose('victim.ts', 'const a = 1', 'const a = 2')
      setup()
      const out = await applyPendingEdits(RUN, ws, grants[0], deps())
      expect(out.kind).toBe('refused')
      if (out.kind === 'refused') reasons.add(out.reason)
      fs.rmSync(path.join(project, 'victim.ts'), { force: true })
    }
    await attempt(() => fs.rmSync(path.join(project, 'victim.ts')))
    await attempt(() => {
      fs.rmSync(path.join(project, 'victim.ts'))
      fs.symlinkSync(path.join(outside, 'nowhere.ts'), path.join(project, 'victim.ts'))
    })
    await attempt(() => fs.writeFileSync(path.join(project, 'victim.ts'), 'changed\n'))
    expect(reasons.size).toBe(1)
  })

  it('refuses a second apply that starts while the first is between its check and its write', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let paused: () => void = () => undefined
    const reachedPause = new Promise<void>((resolve) => {
      paused = resolve
    })
    extraDeps = {
      hooks: {
        afterVerify: async () => {
          paused()
          await gate
        }
      }
    }
    const first = applyPendingEdits(RUN, ws, grants[0], deps())
    await reachedPause
    extraDeps = {}
    const second = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(second.kind).toBe('refused')
    release()
    expect((await first).kind).toBe('applied')
    expect(read(a)).toBe('line one\nconst a = 2\nline three\nfooter text\n')
  })

  it('does not let two overlapping applies both write', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const [one, two] = await Promise.all([
      applyPendingEdits(RUN, ws, grants[0], deps()),
      applyPendingEdits(RUN, ws, grants[0], deps())
    ])
    expect([one.kind, two.kind].sort()).toEqual(['applied', 'refused'])
    expect(read(a)).toBe('line one\nconst a = 2\nline three\nfooter text\n')
  })
})

describe('undoRun', () => {
  it('restores every file of the run', async () => {
    const a = write('src/a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('src/a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    expect(read(a)).not.toBe(ORIGINAL)
    const restored = await undoRun(RUN, ws)
    expect([...restored].sort()).toEqual(['b.ts', 'src/a.ts'])
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe('x = 1\n')
  })

  it('does not overwrite a file the user changed after the run, and says so by leaving it out', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    const later = 'x = 2\n// later work of the user\n'
    fs.writeFileSync(b, later)
    const restored = await undoRun(RUN, ws)
    expect(restored).toEqual(['a.ts'])
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe(later)
  })

  it('is idempotent: a second undo restores nothing and changes nothing', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(await undoRun(RUN, ws)).toEqual(['a.ts'])
    expect(await undoRun(RUN, ws)).toEqual([])
    expect(read(a)).toBe(ORIGINAL)
  })

  it('never writes snapshot content that does not match its recorded hash', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    const applied = read(a)
    fs.writeFileSync(path.join(ws.snapshotDir, 'batch-1', '0.bak'), 'tampered\n')
    expect(await undoRun(RUN, ws)).toEqual([])
    expect(read(a)).toBe(applied)
  })

  it('does not follow a file swapped for a link to the outside', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    const outsideFile = path.join(outside, 'a.ts')
    fs.writeFileSync(outsideFile, read(a))
    fs.rmSync(a)
    fs.symlinkSync(outsideFile, a)
    expect(await undoRun(RUN, ws)).toEqual([])
    expect(read(outsideFile)).toContain('const a = 2')
  })

  it('refuses to guess when a manifest is malformed: throws and restores nothing', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    const afterA = read(a)
    fs.writeFileSync(path.join(ws.snapshotDir, 'batch-1', 'manifest.json'), '{"entries": "no"}')
    await expect(undoRun(RUN, ws)).rejects.toThrow()
    expect(read(a)).toBe(afterA)
    expect(read(b)).toBe('x = 1\n')
  })

  it('undoes two batches of one run newest first, back to the oldest content', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    store.resolve(RUN, true)
    propose('a.ts', 'const a = 2', 'const a = 3')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    expect(read(a)).toContain('const a = 3')
    await undoRun(RUN, ws)
    expect(read(a)).toBe(ORIGINAL)
  })
})

describe('handlers: R56 (the workspace is rebuilt from the grant) and R63 (proposals outlive a finished run)', () => {
  it('accept rebuilds the workspace from the grant, applies, and only then resolves the package', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const out = await acceptEditsForRun(RUN, 'dir-1', deps())
    expect(out.kind).toBe('applied')
    expect(read(a)).toContain('const a = 2')
    expect(store.pending(RUN)).toEqual([])
    expect(store.auditRecords(RUN).records.map((r) => r.outcome)).toContain('package-accepted')
  })

  it('a refused apply leaves the proposal standing', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    fs.writeFileSync(a, ORIGINAL + 'user line\n')
    const out = await acceptEditsForRun(RUN, 'dir-1', deps())
    expect(out.kind).toBe('refused')
    expect(store.pending(RUN)).toHaveLength(1)
  })

  it('accept still works AFTER a completed or max-steps run ended (R63)', async () => {
    for (const run of ['done1', 'maxed']) {
      write(`${run}.ts`, ORIGINAL)
      propose(`${run}.ts`, 'const a = 1', 'const a = 2', run)
      store.endRun(run, 'finished')
      const out = await acceptEditsForRun(run, 'dir-1', deps())
      expect(out.kind, run).toBe('applied')
      expect(read(path.join(project, `${run}.ts`))).toContain('const a = 2')
    }
  })

  it('nothing is left to accept after a cancelled or failed run (R63)', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    store.endRun(RUN, 'abandoned')
    const out = await acceptEditsForRun(RUN, 'dir-1', deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
  })

  it('accept with a revoked grant refuses and does NOT rebuild the workspace', async () => {
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-fresh-')))
    try {
      grants = [grant({ path: fresh })]
      const a = path.join(fresh, 'a.ts')
      fs.writeFileSync(a, ORIGINAL)
      store.propose(RUN, 1, { path: 'a.ts', oldText: 'const a = 1', newText: 'const a = 2' }, ORIGINAL)
      grants = []
      const out = await acceptEditsForRun(RUN, 'dir-1', deps())
      expect(out.kind).toBe('refused')
      expect(fs.existsSync(path.join(fresh, '.mingly'))).toBe(false)
      expect(fs.readFileSync(a, 'utf8')).toBe(ORIGINAL)
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('undo with a revoked grant refuses and does NOT rebuild the workspace or restore anything', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await acceptEditsForRun(RUN, 'dir-1', deps())).kind).toBe('applied')
    const applied = read(a)
    // A second project that never had a workspace: a rebuild would create one.
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-fresh-')))
    try {
      grants = [grant({ path: fresh })]
      grants = []
      const gone = await undoRunForDirectory(RUN, 'dir-1', deps())
      expect(gone.kind).toBe('refused')
      expect(fs.existsSync(path.join(fresh, '.mingly'))).toBe(false)
      // Same project, grant present but without edit: also refused, file untouched.
      grants = [grant({ permissions: ['read'] })]
      expect((await undoRunForDirectory(RUN, 'dir-1', deps())).kind).toBe('refused')
      expect(read(a)).toBe(applied)
      // And with the grant back, it works.
      grants = [grant()]
      const back = await undoRunForDirectory(RUN, 'dir-1', deps())
      expect(back).toEqual({ kind: 'restored', paths: ['a.ts'] })
      expect(read(a)).toBe(ORIGINAL)
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('takes nothing but a run id and a directory id: bad input is refused', async () => {
    expect((await acceptEditsForRun(undefined, 'dir-1', deps())).kind).toBe('refused')
    expect((await acceptEditsForRun(RUN, 42, deps())).kind).toBe('refused')
    expect((await acceptEditsForRun('../escape', 'dir-1', deps())).kind).toBe('refused')
    expect((await undoRunForDirectory('../escape', 'dir-1', deps())).kind).toBe('refused')
  })

  it('reject clears the package without touching a file', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const out = rejectEditsForRun(RUN, deps(), 'not wanted')
    expect(out).toEqual({ kind: 'rejected', count: 1 })
    expect(store.pending(RUN)).toEqual([])
    expect(read(a)).toBe(ORIGINAL)
  })
})

describe('writeFileAtomic as an exported helper', () => {
  it('creates a missing target and leaves the content complete', async () => {
    const target = path.join(project, 'new.txt')
    await writeFileAtomic(target, 'hello\n')
    expect(read(target)).toBe('hello\n')
    expect(sha(read(target))).toBe(sha('hello\n'))
    expect(leftovers(project)).toEqual([])
  })
})
