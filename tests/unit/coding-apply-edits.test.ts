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
import { createSnapshotLedger, createFileSnapshotLedger, LEDGER_MAX_ROWS, type SnapshotLedger } from '../../src/main/coding/snapshot-ledger'
import { createRunDirectoryRegistry, type RunDirectoryRegistry } from '../../src/main/coding/run-directories'
import { packageDigest, createEditProposalStore, type EditProposalStore } from '../../src/main/coding/edit-proposals'
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
let runDirs: RunDirectoryRegistry
let ledger: SnapshotLedger

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
    runDirectories: runDirs,
    ledger,
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

/** The digest of what is pending for a run right now: what the human is shown. */
function pkg(runId: unknown): string {
  return packageDigest(store.pending(runId as string))
}

function leftovers(dir: string): string[] {
  // The temp files are named `.mingly-tmp-<hex>`; a filter on '.tmp' matches nothing.
  return fs.readdirSync(dir).filter((n) => n.startsWith('.mingly-tmp-'))
}

beforeEach(async () => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-outside-')))
  grants = [grant()]
  modes = new Map([['dir-1', 'propose']])
  store = createEditProposalStore()
  extraDeps = {}
  runDirs = createRunDirectoryRegistry()
  const rows = new Map<string, unknown>()
  ledger = createSnapshotLedger({ get: (k, d) => rows.get(k) ?? d, set: (k, v) => void rows.set(k, v) })
  for (const r of [RUN, 'runA', 'runB', 'done1', 'maxed']) runDirs.record(r, 'dir-1')
  ws = await ensureProjectWorkspace(project, RUN)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('applyPendingEdits: the happy path and the snapshot', () => {
  it('leftovers() sees a stale temp file (the helper behind every no-temp-left assertion can fail)', () => {
    fs.writeFileSync(path.join(project, '.mingly-tmp-0123456789abcdef'), 'x')
    expect(leftovers(project)).toEqual(['.mingly-tmp-0123456789abcdef'])
  })

  it('applies the pending proposals and reports the real paths', async () => {
    const a = write('src/a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('src/a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out).toMatchObject({ kind: 'applied', paths: ['src/a.ts', 'b.ts'] })
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
    const realRename = fs.promises.rename.bind(fs.promises)
    let attempts = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // Only the overwrite of the project file fails (the manifest rename must work,
      // or the test would end in the snapshot step and never reach the project write).
      if (String(to) === a) {
        attempts++
        throw new Error('EIO simulated')
      }
      return realRename(from, to)
    })
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(attempts).toBe(1)
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
    const restored = (await undoRun(RUN, ws, deps())).restored
    expect([...restored].sort()).toEqual(['b.ts', 'src/a.ts'])
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe('x = 1\n')
  })

  it('does not overwrite a file the user changed after the run, and reports it as skipped with the reason', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    const later = 'x = 2\n// later work of the user\n'
    fs.writeFileSync(b, later)
    const result = await undoRun(RUN, ws, deps())
    expect(result.restored).toEqual(['a.ts'])
    expect(result.skipped).toEqual([{ path: 'b.ts', reason: 'changed-since-apply' }])
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe(later)
  })

  it('is idempotent: a second undo restores nothing and changes nothing', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    expect((await undoRun(RUN, ws, deps())).restored).toEqual(['a.ts'])
    // Second time the file no longer holds what the apply wrote: reported, not hidden.
    expect(await undoRun(RUN, ws, deps())).toEqual({
      restored: [],
      skipped: [{ path: 'a.ts', reason: 'changed-since-apply' }]
    })
    expect(read(a)).toBe(ORIGINAL)
  })

  it('never writes snapshot content that does not match its recorded hash', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    const applied = read(a)
    fs.writeFileSync(path.join(ws.snapshotDir, 'batch-1', '0.bak'), 'tampered\n')
    expect(await undoRun(RUN, ws, deps())).toEqual({
      restored: [],
      skipped: [{ path: 'a.ts', reason: 'snapshot-damaged' }]
    })
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
    const result = await undoRun(RUN, ws, deps())
    expect(result.restored).toEqual([])
    expect(result.skipped).toEqual([{ path: 'a.ts', reason: 'path-not-allowed' }])
    expect(read(outsideFile)).toContain('const a = 2')
  })

  it('does not guess when a manifest is malformed: that batch is skipped with its reason, nothing is restored from it', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    const afterA = read(a)
    const malformed = '{"entries": "no"}'
    fs.writeFileSync(path.join(ws.snapshotDir, 'batch-1', 'manifest.json'), malformed)
    // Vouched for by the ledger, so the test reaches the parser and not the ledger check.
    await ledger.record(fs.realpathSync(project), RUN, 1, sha(malformed))
    const result = await undoRun(RUN, ws, deps())
    expect(result.restored).toEqual([])
    expect(result.skipped).toEqual([{ path: '.mingly/snapshots/run1/batch-1', reason: 'batch-manifest-invalid' }])
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
    await undoRun(RUN, ws, deps())
    expect(read(a)).toBe(ORIGINAL)
  })
})

describe('FIX C: undo trusts only batches this app recorded outside the project', () => {
  async function appliedWithManifest(): Promise<{ a: string; manifest: string }> {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    return { a, manifest: path.join(ws.snapshotDir, 'batch-1', 'manifest.json') }
  }

  it('a batch this app created restores (positive control)', async () => {
    const { a } = await appliedWithManifest()
    expect((await undoRun(RUN, ws, deps())).restored).toEqual(['a.ts'])
    expect(read(a)).toBe(ORIGINAL)
  })

  it('refuses a batch whose manifest was changed on disk after the record was written, naming the reason', async () => {
    const { a, manifest } = await appliedWithManifest()
    const applied = read(a)
    // Same shape, same hashes of file bodies: only a byte of the manifest differs.
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8') + ' ')
    expect(await undoRun(RUN, ws, deps())).toEqual({
      restored: [],
      skipped: [{ path: '.mingly/snapshots/run1/batch-1', reason: 'batch-manifest-changed' }]
    })
    expect(read(a)).toBe(applied)
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/no record in this app/)
    expect(read(a)).toBe(applied)
  })

  it('refuses a planted batch that has no record at all, and never writes its content', async () => {
    const a = write('a.ts', ORIGINAL)
    const planted = path.join(ws.snapshotDir, 'batch-1')
    fs.mkdirSync(planted)
    const evil = 'EVIL CONTENT\n'
    fs.writeFileSync(path.join(planted, '0.bak'), evil)
    fs.writeFileSync(
      path.join(planted, 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: [{ rel: 'a.ts', file: '0.bak', before: sha(evil), after: sha(ORIGINAL) }]
      })
    )
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/no record in this app/)
    expect(read(a)).toBe(ORIGINAL)
  })

  it('refuses when the record is gone, even for a genuine snapshot (accepted consequence)', async () => {
    const { a } = await appliedWithManifest()
    const applied = read(a)
    ledger = createSnapshotLedger({ get: (_k, d) => d, set: () => undefined })
    expect(await undoRun(RUN, ws, deps())).toEqual({
      restored: [],
      skipped: [{ path: '.mingly/snapshots/run1/batch-1', reason: 'batch-not-recorded' }]
    })
    expect(read(a)).toBe(applied)
  })

  it('writes the record before the first project file is overwritten', async () => {
    write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    let recordedBeforeWrite = false
    extraDeps = {
      hooks: {
        afterVerify: async () => {
          recordedBeforeWrite = (await ledger.lookup(RUN, 1)) !== undefined
        }
      }
    }
    await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(recordedBeforeWrite).toBe(true)
  })

  it('writes nothing when the record cannot be written', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    ledger = {
      record: async () => {
        throw new Error('userData not writable')
      },
      lookup: async () => undefined
    }
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(fs.readdirSync(ws.snapshotDir)).toEqual([])
  })

  it('the ledger is bounded as a whole and drops the oldest row', async () => {
    const rows = new Map<string, unknown>()
    const small = createSnapshotLedger({ get: (k, d) => rows.get(k) ?? d, set: (k, v) => void rows.set(k, v) }, 3)
    for (let i = 1; i <= 4; i++) await small.record('/p', 'r', i, 'h' + i)
    expect(await small.lookup('r', 1)).toBeUndefined()
    expect(await small.lookup('r', 4)).toBe('h4')
    expect(LEDGER_MAX_ROWS).toBeGreaterThan(3)
  })
})

describe('round 2: undo survives a restart and a move, and still trusts only the ledger', () => {
  async function applied(): Promise<string> {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())).kind).toBe('applied')
    return a
  }

  it('undo works after the in-memory registry is gone (restart), given the row and the snapshot', async () => {
    const a = await applied()
    runDirs = createRunDirectoryRegistry()
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out).toEqual({ kind: 'restored', restored: ['a.ts'], skipped: [] })
    expect(read(a)).toBe(ORIGINAL)
  })

  it('accept does NOT work without the registry record (pending proposals die with the process anyway)', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    runDirs = createRunDirectoryRegistry()
    expect((await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
  })

  it('undo works after the project moved to a new path: the row is found by run id and batch', async () => {
    await applied()
    runDirs = createRunDirectoryRegistry()
    const moved = path.join(outside, 'moved-project')
    fs.renameSync(project, moved)
    grants = [grant({ path: moved })]
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out).toEqual({ kind: 'restored', restored: ['a.ts'], skipped: [] })
    expect(fs.readFileSync(path.join(moved, 'a.ts'), 'utf8')).toBe(ORIGINAL)
  })

  it('a moved project still refuses a manifest that does not match its row', async () => {
    await applied()
    const moved = path.join(outside, 'moved-project')
    fs.renameSync(project, moved)
    grants = [grant({ path: moved })]
    const manifest = path.join(moved, '.mingly', 'snapshots', RUN, 'batch-1', 'manifest.json')
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8') + ' ')
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/no record in this app/)
  })

  it('without the registry, a snapshot that is not physically under the grant is not found', async () => {
    await applied()
    runDirs = createRunDirectoryRegistry()
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-else-')))
    try {
      grants = [grant({ path: elsewhere })]
      expect((await undoRunForDirectory(RUN, 'dir-1', deps())).kind).toBe('refused')
      expect(fs.existsSync(path.join(elsewhere, '.mingly'))).toBe(false)
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('without the registry and without a row, a planted snapshot is refused', async () => {
    const a = write('a.ts', ORIGINAL)
    const planted = path.join(ws.snapshotDir, 'batch-1')
    fs.mkdirSync(planted)
    const evil = 'EVIL\n'
    fs.writeFileSync(path.join(planted, '0.bak'), evil)
    fs.writeFileSync(
      path.join(planted, 'manifest.json'),
      JSON.stringify({ version: 1, entries: [{ rel: 'a.ts', file: '0.bak', before: sha(evil), after: sha(ORIGINAL) }] })
    )
    runDirs = createRunDirectoryRegistry()
    expect((await undoRunForDirectory(RUN, 'dir-1', deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
  })

  it('within a session, a directory id that disagrees with the registry is still refused', async () => {
    const a = await applied()
    const after = read(a)
    grants = [grant(), grant({ id: 'dir-2', path: project })]
    expect((await undoRunForDirectory(RUN, 'dir-2', deps())).kind).toBe('refused')
    expect(read(a)).toBe(after)
  })
})

describe('round 3, FIX 1: a save between the verification and the rename is not overwritten', () => {
  it('an in-place save (same inode) after the verification refuses the write and keeps the save', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const inoBefore = fs.statSync(a).ino
    const save = ORIGINAL.replace('footer text', 'footer text, saved by the editor')
    extraDeps = {
      hooks: {
        afterVerify: () => {
          fs.writeFileSync(a, save) // truncates and rewrites: the inode stays
        }
      }
    }
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(fs.statSync(a).ino).toBe(inoBefore)
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(save)
    expect(leftovers(project)).toEqual([])
  })

  it('an in-place save while the temp file is being written (just before the rename) is caught too', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const save = ORIGINAL + '// saved late\n'
    const realLstat = fs.promises.lstat.bind(fs.promises)
    let saved = false
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p, opts) => {
      // The identity check of writeFileAtomic is the last thing before the rename.
      if (String(p) === a && !saved) {
        saved = true
        fs.writeFileSync(a, save)
      }
      return realLstat(p, opts as never) as never
    })
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(saved).toBe(true)
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(save)
    expect(leftovers(project)).toEqual([])
  })

  it('undo does not overwrite a save that lands just before its own rename', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    const save = read(a) + '// saved during undo\n'
    const realLstat = fs.promises.lstat.bind(fs.promises)
    let saved = false
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p, opts) => {
      if (String(p) === a && !saved) {
        saved = true
        fs.writeFileSync(a, save)
      }
      return realLstat(p, opts as never) as never
    })
    const result = await undoRun(RUN, ws, deps())
    expect(saved).toBe(true)
    expect(result.restored).toEqual([])
    expect(result.skipped).toEqual([{ path: 'a.ts', reason: 'changed-since-apply' }])
    expect(read(a)).toBe(save)
  })
})

describe('round 3, FIX 3: grant and mode are checked before EACH write', () => {
  async function twoFiles(): Promise<{ a: string; b: string }> {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    return { a, b }
  }

  it('a grant revoked after file 1 stops file 2, and nothing is written without the grant (not even a rollback)', async () => {
    const { a, b } = await twoFiles()
    extraDeps = { hooks: { afterWrite: (i) => { if (i === 0) grants = [] } } }
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/withdrawn/)
    expect(read(b)).toBe('x = 1\n')
    // File 1 stays applied: restoring it would be a write without permission.
    expect(read(a)).toContain('const a = 2')
    // With the grant back, undo puts it right.
    grants = [grant()]
    const undo = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(undo.kind).toBe('restored')
    expect(read(a)).toBe(ORIGINAL)
  })

  it('edit permission dropped after file 1 behaves the same', async () => {
    const { b } = await twoFiles()
    extraDeps = { hooks: { afterWrite: (i) => { if (i === 0) grants = [grant({ permissions: ['read'] })] } } }
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(b)).toBe('x = 1\n')
  })

  it('the mode set to off after file 1 stops file 2 and rolls file 1 back (rollback needs only the grant)', async () => {
    const { a, b } = await twoFiles()
    extraDeps = { hooks: { afterWrite: (i) => { if (i === 0) modes.set('dir-1', 'off') } } }
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(b)).toBe('x = 1\n')
    expect(read(a)).toBe(ORIGINAL)
  })

  it('a grant revoked between the verification and the write of the SAME file stops that write', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    extraDeps = { hooks: { afterVerify: () => { grants = [] } } }
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    // Nothing was written, so no marker is left claiming a partial state.
    expect(fs.existsSync(path.join(ws.snapshotDir, 'batch-1', 'IN-PROGRESS'))).toBe(false)
  })
})

describe('round 3, FIX 5: debris cannot disable undo', () => {
  async function appliedA(): Promise<string> {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    return a
  }

  it('restores the genuine batch and reports orphan batches as skipped with their reason', async () => {
    const a = await appliedA()
    // What a crash in pass 1 leaves: a directory with a copy, no manifest, no ledger row.
    const orphan = path.join(ws.snapshotDir, 'batch-2')
    fs.mkdirSync(orphan)
    fs.writeFileSync(path.join(orphan, '0.bak'), 'half a snapshot')
    // A planted batch with a manifest but no row.
    const planted = path.join(ws.snapshotDir, 'batch-3')
    fs.mkdirSync(planted)
    fs.writeFileSync(path.join(planted, 'manifest.json'), JSON.stringify({ version: 1, entries: [] }))
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out).toEqual({
      kind: 'restored',
      restored: ['a.ts'],
      skipped: [
        { path: '.mingly/snapshots/run1/batch-3', reason: 'batch-not-recorded' },
        { path: '.mingly/snapshots/run1/batch-2', reason: 'batch-not-recorded' }
      ]
    })
    expect(read(a)).toBe(ORIGINAL)
  })

  it('a recorded batch whose manifest vanished is skipped as missing, the others still restore', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    store.resolve(RUN, true)
    propose('b.ts', 'x = 1', 'x = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    fs.rmSync(path.join(ws.snapshotDir, 'batch-2', 'manifest.json'))
    const result = await undoRun(RUN, ws, deps())
    expect(result.restored).toEqual(['a.ts'])
    expect(result.skipped).toEqual([{ path: '.mingly/snapshots/run1/batch-2', reason: 'batch-manifest-missing' }])
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe('x = 2\n')
  })

  it('when nothing at all can be restored because of unknown batches, the handler refuses and still lists them', async () => {
    const a = write('a.ts', ORIGINAL)
    fs.mkdirSync(path.join(ws.snapshotDir, 'batch-1'))
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') {
      expect(out.reason).toMatch(/no record in this app/)
      expect(out.skipped).toEqual([{ path: '.mingly/snapshots/run1/batch-1', reason: 'batch-not-recorded' }])
    }
    expect(read(a)).toBe(ORIGINAL)
  })
})

describe('round 3, FIX 6: the ledger is written atomically and a failure stops the apply', () => {
  let ledgerDir: string
  let ledgerFile: string
  beforeEach(() => {
    ledgerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-ledger-')))
    ledgerFile = path.join(ledgerDir, 'coding-snapshots.json')
  })
  afterEach(() => {
    fs.rmSync(ledgerDir, { recursive: true, force: true })
  })

  it('a row survives a new ledger instance on the same file (restart)', async () => {
    await createFileSnapshotLedger(ledgerFile).record('/p', 'run1', 1, 'abc')
    expect(await createFileSnapshotLedger(ledgerFile).lookup('run1', 1)).toBe('abc')
    expect(await createFileSnapshotLedger(ledgerFile).lookup('run1', 2)).toBeUndefined()
  })

  it('writes with a temp file and a rename, with private permissions, leaving no temp behind', async () => {
    const realRename = fs.promises.rename.bind(fs.promises)
    const moves: string[] = []
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      moves.push(String(to))
      return realRename(from, to)
    })
    await createFileSnapshotLedger(ledgerFile).record('/p', 'run1', 1, 'abc')
    expect(moves).toEqual([ledgerFile])
    expect(fs.statSync(ledgerFile).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(ledgerDir)).toEqual(['coding-snapshots.json'])
  })

  it('a write failure PROPAGATES instead of being swallowed', async () => {
    const missingDir = path.join(ledgerDir, 'no', 'such', 'dir', 'ledger.json')
    await expect(createFileSnapshotLedger(missingDir).record('/p', 'run1', 1, 'abc')).rejects.toThrow()
  })

  it('an apply whose row cannot be written writes nothing, with the real file ledger', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    ledger = createFileSnapshotLedger(path.join(ledgerDir, 'no', 'such', 'dir', 'ledger.json'))
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(fs.readdirSync(ws.snapshotDir)).toEqual([])
  })

  it('a corrupt file reads as "no rows" (undo refuses) and is quarantined, not silently overwritten, on the next record', async () => {
    fs.writeFileSync(ledgerFile, '{"rows": [')
    const l = createFileSnapshotLedger(ledgerFile)
    expect(await l.lookup('run1', 1)).toBeUndefined()
    await l.record('/p', 'run2', 1, 'def')
    expect(await l.lookup('run2', 1)).toBe('def')
    const quarantined = fs.readdirSync(ledgerDir).filter((n) => n.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(fs.readFileSync(path.join(ledgerDir, quarantined[0]), 'utf8')).toBe('{"rows": [')
  })

  it('concurrent records do not lose rows', async () => {
    const l = createFileSnapshotLedger(ledgerFile)
    await Promise.all(Array.from({ length: 20 }, (_, i) => l.record('/p', 'run1', i + 1, 'h' + i)))
    for (let i = 0; i < 20; i++) expect(await l.lookup('run1', i + 1)).toBe('h' + i)
  })

  it('is bounded as a whole', async () => {
    const l = createFileSnapshotLedger(ledgerFile, 3)
    for (let i = 1; i <= 5; i++) await l.record('/p', 'r', i, 'h' + i)
    expect(await l.lookup('r', 2)).toBeUndefined()
    expect(await l.lookup('r', 5)).toBe('h5')
  })
})

describe('round 3, FIX 7: an interrupted apply is detectable, swept and reported honestly', () => {
  const MARKER = path.join('batch-1', 'IN-PROGRESS')
  const STALE_TEMP = '.mingly-tmp-0123456789abcdef'

  async function twoFilesProposed(): Promise<{ a: string; b: string }> {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    return { a, b }
  }

  it('the marker exists while files are being written and is gone after a complete apply', async () => {
    await twoFilesProposed()
    const seen: boolean[] = []
    extraDeps = { hooks: { afterVerify: (i) => { seen[i] = fs.existsSync(path.join(ws.snapshotDir, MARKER)) } } }
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    expect(seen).toEqual([true, true])
    expect(fs.existsSync(path.join(ws.snapshotDir, MARKER))).toBe(false)
  })

  it('the marker is gone after a refusal that wrote nothing, and after a complete rollback', async () => {
    const { b } = await twoFilesProposed()
    const realRename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === b) throw new Error('EIO simulated')
      return realRename(from, to)
    })
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(fs.existsSync(path.join(ws.snapshotDir, MARKER))).toBe(false)
  })

  it('the marker STAYS when a rollback cannot complete, so the partial state is detectable', async () => {
    const { a, b } = await twoFilesProposed()
    const realRename = fs.promises.rename.bind(fs.promises)
    let toA = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === b) throw new Error('EIO simulated')
      if (String(to) === a && ++toA > 1) throw new Error('EIO on the rollback')
      return realRename(from, to)
    })
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toContain('const a = 2')
    expect(fs.existsSync(path.join(ws.snapshotDir, MARKER))).toBe(true)
  })

  it('the marker STAYS when permission is withdrawn after file 1', async () => {
    await twoFilesProposed()
    extraDeps = { hooks: { afterWrite: (i) => { if (i === 0) grants = [] } } }
    await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(fs.existsSync(path.join(ws.snapshotDir, MARKER))).toBe(true)
  })

  /** What a killed process leaves: a marker, a stale temp, one file written, one not. */
  async function crashedState(): Promise<{ a: string; b: string }> {
    const { a, b } = await twoFilesProposed()
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    fs.writeFileSync(path.join(ws.snapshotDir, MARKER), '{}')
    fs.writeFileSync(b, 'x = 1\n') // as if this rename never happened
    fs.writeFileSync(path.join(project, STALE_TEMP), 'half a write')
    return { a, b }
  }

  it('undo names the interruption, sweeps the stale temp and does not call an unwritten file "changed"', async () => {
    const { a, b } = await crashedState()
    const result = await undoRun(RUN, ws, deps())
    expect(result.interrupted).toBe(true)
    expect(result.restored).toEqual(['a.ts'])
    expect(result.skipped).toEqual([{ path: 'b.ts', reason: 'not-written-interrupted' }])
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe('x = 1\n')
    expect(leftovers(project)).toEqual([])
    expect(fs.existsSync(path.join(ws.snapshotDir, MARKER))).toBe(false)
  })

  it('a new apply for an interrupted run sweeps the temp and refuses, pointing at undo', async () => {
    await crashedState()
    const c = write('c.ts', 'y = 1\n')
    propose('c.ts', 'y = 1', 'y = 2')
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/interrupted/)
    expect(leftovers(project)).toEqual([])
    expect(read(c)).toBe('y = 1\n')
  })

  it('an undo of a clean run does not claim an interruption', async () => {
    await twoFilesProposed()
    await applyPendingEdits(RUN, ws, grants[0], deps())
    expect('interrupted' in (await undoRun(RUN, ws, deps()))).toBe(false)
  })
})

describe('round 3, FIX 2: accept is bound to the package the human saw', () => {
  it('a proposal added after the human looked refuses the accept, writes nothing, releases nothing', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    const shown = pkg(RUN)
    propose('b.ts', 'x = 1', 'x = 2')
    const out = await acceptEditsForRun(RUN, 'dir-1', shown, deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/changed.*reviewed again/)
    expect(read(a)).toBe(ORIGINAL)
    expect(read(b)).toBe('x = 1\n')
    expect(store.pending(RUN)).toHaveLength(2)
  })

  it('the digest of what is pending now applies', async () => {
    write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())).kind).toBe('applied')
  })

  it('a missing or blank digest is refused: there is no accept of "whatever the run holds"', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    for (const bad of [undefined, '', 42, null]) {
      expect((await acceptEditsForRun(RUN, 'dir-1', bad, deps())).kind).toBe('refused')
    }
    expect(read(a)).toBe(ORIGINAL)
  })

  it('a proposal added DURING the apply is neither applied nor released; the applied one is released', async () => {
    const a = write('a.ts', ORIGINAL)
    const c = write('c.ts', 'z = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    const shown = pkg(RUN)
    extraDeps = {
      hooks: {
        afterVerify: () => {
          expect(store.propose(RUN, 2, { path: 'c.ts', oldText: 'z = 1', newText: 'z = 2' }, 'z = 1\n').kind).toBe(
            'proposed'
          )
        }
      }
    }
    const out = await acceptEditsForRun(RUN, 'dir-1', shown, deps())
    expect(out.kind).toBe('applied')
    expect(read(a)).toContain('const a = 2')
    expect(read(c)).toBe('z = 1\n')
    expect(store.pending(RUN).map((e) => e.path)).toEqual(['c.ts'])
    const accepted = store.auditRecords(RUN).records.filter((r) => r.outcome === 'package-accepted')
    expect(accepted.map((r) => r.edits)).toEqual([1])
  })

  it('packageDigest is stable and sensitive to content and order', () => {
    const base = { path: 'a.ts', oldText: 'o', newText: 'n', diff: '', addedLines: 0, removedLines: 0, introducesHiddenCharacters: false, baseSha256: 'h', matchIndex: 0 }
    const one = { ...base, path: 'b.ts' }
    expect(packageDigest([base, one])).toBe(packageDigest([{ ...base }, { ...one }]))
    expect(packageDigest([one, base])).not.toBe(packageDigest([base, one]))
    expect(packageDigest([{ ...base, newText: 'm' }])).not.toBe(packageDigest([base]))
    expect(packageDigest([{ ...base, baseSha256: 'x' }])).not.toBe(packageDigest([base]))
    expect(packageDigest([])).not.toBe(packageDigest([base]))
  })

  it('the outcome carries the exact package that was applied', async () => {
    write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const before = store.pending(RUN)
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('applied')
    if (out.kind === 'applied') expect(packageDigest(out.edits)).toBe(packageDigest(before))
  })
})

describe('round 4', () => {
  const MARKER = path.join('batch-1', 'IN-PROGRESS')
  const baseEdit = {
    path: 'a.ts', oldText: 'o', newText: 'n', diff: '', addedLines: 0, removedLines: 0,
    introducesHiddenCharacters: false, baseSha256: 'h', matchIndex: 0
  }

  it('FIX A: the digest changes when ONLY the old text, ONLY the match index or ONLY the path changes', () => {
    const d = packageDigest([baseEdit])
    expect(packageDigest([{ ...baseEdit, oldText: 'p' }])).not.toBe(d)
    expect(packageDigest([{ ...baseEdit, matchIndex: 1 }])).not.toBe(d)
    expect(packageDigest([{ ...baseEdit, path: 'b.ts' }])).not.toBe(d)
  })

  it.each([
    ['oldText', (e: { oldText: string }) => ({ ...e, oldText: e.oldText + ' ' })],
    ['matchIndex', (e: { matchIndex: number }) => ({ ...e, matchIndex: e.matchIndex + 1 })]
  ])('FIX A: accept refuses a package that differs from the shown one only in %s', async (_name, change) => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const [pending] = store.pending(RUN)
    const shownOther = packageDigest([change(pending as never) as never])
    const out = await acceptEditsForRun(RUN, 'dir-1', shownOther, deps())
    expect(out.kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(store.pending(RUN)).toHaveLength(1)
  })

  it('FIX B: a grant whose path changed under the same id stops the write', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    extraDeps = { hooks: { afterVerify: () => { grants = [grant({ path: outside })] } } }
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
  })

  it('FIX B/C: permission bits survive apply and undo, and writeFileAtomic keeps or overrides them', async () => {
    const a = write('tool.ts', ORIGINAL)
    fs.chmodSync(a, 0o750)
    propose('tool.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(fs.statSync(a).mode & 0o777).toBe(0o750)
    expect((await undoRun(RUN, ws, deps())).restored).toEqual(['tool.ts'])
    expect(read(a)).toBe(ORIGINAL)
    expect(fs.statSync(a).mode & 0o777).toBe(0o750)
    await writeFileAtomic(a, 'x\n')
    expect(fs.statSync(a).mode & 0o777).toBe(0o750)
    await writeFileAtomic(a, 'y\n', { mode: 0o640 })
    expect(fs.statSync(a).mode & 0o777).toBe(0o640)
  })

  it('FIX D: a stale marker next to a COMPLETE apply heals itself and the next apply proceeds', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    expect((await applyPendingEdits(RUN, ws, grants[0], deps())).kind).toBe('applied')
    store.resolve(RUN, true)
    // The marker could not be cleared (or the process died just before).
    fs.writeFileSync(path.join(ws.snapshotDir, MARKER), '{}')
    fs.writeFileSync(path.join(project, '.mingly-tmp-0123456789abcdef'), 'stale')
    const c = write('c.ts', 'y = 1\n')
    propose('c.ts', 'y = 1', 'y = 2')
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('applied')
    expect(read(c)).toBe('y = 2\n')
    expect(read(a)).toContain('const a = 2')
    expect(fs.existsSync(path.join(ws.snapshotDir, MARKER))).toBe(false)
    expect(leftovers(project)).toEqual([])
    // The first batch is still undoable: nothing about the good work was lost.
    expect((await undoRun(RUN, ws, deps())).restored.sort()).toEqual(['a.ts', 'c.ts'])
  })

  it('FIX D: a marker with ONE file not at its recorded result is a genuine partial state and still refuses', async () => {
    const a = write('a.ts', ORIGINAL)
    const b = write('b.ts', 'x = 1\n')
    propose('a.ts', 'const a = 1', 'const a = 2')
    propose('b.ts', 'x = 1', 'x = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    store.resolve(RUN, true)
    fs.writeFileSync(path.join(ws.snapshotDir, MARKER), '{}')
    fs.writeFileSync(b, 'x = 1\n')
    const c = write('c.ts', 'y = 1\n')
    propose('c.ts', 'y = 1', 'y = 2')
    const out = await applyPendingEdits(RUN, ws, grants[0], deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/interrupted/)
    expect(read(c)).toBe('y = 1\n')
    expect(read(a)).toContain('const a = 2')
    expect(fs.existsSync(path.join(ws.snapshotDir, MARKER))).toBe(true)
  })

  it('FIX E: a genuine batch whose files were all changed, next to an orphan, gets its own reason', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    await applyPendingEdits(RUN, ws, grants[0], deps())
    fs.writeFileSync(a, read(a) + '// user work\n')
    fs.mkdirSync(path.join(ws.snapshotDir, 'batch-2'))
    const out = await undoRunForDirectory(RUN, 'dir-1', deps())
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') {
      expect(out.reason).toMatch(/changed after the apply/)
      expect(out.reason).toMatch(/no valid record/)
      expect(out.reason).not.toMatch(/has no record in this app/)
      expect(out.skipped).toEqual([
        { path: '.mingly/snapshots/run1/batch-2', reason: 'batch-not-recorded' },
        { path: 'a.ts', reason: 'changed-since-apply' }
      ])
    }
  })
})

describe('handlers: R56 (the workspace is rebuilt from the grant) and R63 (proposals outlive a finished run)', () => {
  it('accept rebuilds the workspace from the grant, applies, and only then resolves the package', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    const out = await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())
    expect(out.kind).toBe('applied')
    expect(read(a)).toContain('const a = 2')
    expect(store.pending(RUN)).toEqual([])
    expect(store.auditRecords(RUN).records.map((r) => r.outcome)).toContain('package-accepted')
  })

  it('a refused apply leaves the proposal standing', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    fs.writeFileSync(a, ORIGINAL + 'user line\n')
    const out = await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())
    expect(out.kind).toBe('refused')
    expect(store.pending(RUN)).toHaveLength(1)
  })

  it('accept still works AFTER a completed or max-steps run ended (R63)', async () => {
    for (const run of ['done1', 'maxed']) {
      write(`${run}.ts`, ORIGINAL)
      propose(`${run}.ts`, 'const a = 1', 'const a = 2', run)
      store.endRun(run, 'finished')
      const out = await acceptEditsForRun(run, 'dir-1', pkg(run), deps())
      expect(out.kind, run).toBe('applied')
      expect(read(path.join(project, `${run}.ts`))).toContain('const a = 2')
    }
  })

  it('nothing is left to accept after a cancelled or failed run (R63)', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    store.endRun(RUN, 'abandoned')
    const out = await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())
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
      const out = await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())
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
    expect((await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())).kind).toBe('applied')
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
      expect(back).toEqual({ kind: 'restored', restored: ['a.ts'], skipped: [] })
      expect(read(a)).toBe(ORIGINAL)
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('FIX A: a mismatched directory id is refused even though the grant for that other directory is valid', async () => {
    const otherProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-apply-other-')))
    try {
      fs.writeFileSync(path.join(otherProject, 'a.ts'), ORIGINAL)
      grants = [grant(), grant({ id: 'dir-2', path: otherProject })]
      modes.set('dir-2', 'propose')
      const a = write('a.ts', ORIGINAL)
      propose('a.ts', 'const a = 1', 'const a = 2')
      expect((await acceptEditsForRun(RUN, 'dir-2', pkg(RUN), deps())).kind).toBe('refused')
      expect(read(a)).toBe(ORIGINAL)
      expect(fs.readFileSync(path.join(otherProject, 'a.ts'), 'utf8')).toBe(ORIGINAL)
      expect(fs.existsSync(path.join(otherProject, '.mingly'))).toBe(false)
      expect(store.pending(RUN)).toHaveLength(1)
      // The recorded one proceeds.
      expect((await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())).kind).toBe('applied')
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true })
    }
  })

  it('FIX A: undo with a mismatched directory id is refused and restores nothing', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2')
    await acceptEditsForRun(RUN, 'dir-1', pkg(RUN), deps())
    const applied = read(a)
    grants = [grant(), grant({ id: 'dir-2', path: project })]
    expect((await undoRunForDirectory(RUN, 'dir-2', deps())).kind).toBe('refused')
    expect(read(a)).toBe(applied)
  })

  it('FIX A: accept for a run with no recorded directory is refused, not answered from the parameter', async () => {
    const a = write('a.ts', ORIGINAL)
    propose('a.ts', 'const a = 1', 'const a = 2', 'unrecorded')
    expect((await acceptEditsForRun('unrecorded', 'dir-1', pkg('unrecorded'), deps())).kind).toBe('refused')
    // Undo does not need the registry (see FIX B round 2), but it needs a snapshot for the run in
    // this very directory; none exists, so it refuses and creates nothing.
    expect((await undoRunForDirectory('unrecorded', 'dir-1', deps())).kind).toBe('refused')
    expect(read(a)).toBe(ORIGINAL)
    expect(fs.existsSync(path.join(project, '.mingly', 'snapshots', 'unrecorded'))).toBe(false)
  })

  it('FIX A: the registry keeps the first record of a run and is bounded as a whole', () => {
    const reg = createRunDirectoryRegistry(3)
    reg.record('r1', 'd1')
    reg.record('r1', 'd2')
    expect(reg.get('r1')).toBe('d1')
    reg.record('r2', 'd')
    reg.record('r3', 'd')
    reg.record('r4', 'd')
    expect(reg.get('r1')).toBeUndefined()
    expect(reg.get('r4')).toBe('d')
  })

  it('takes nothing but a run id and a directory id: bad input is refused', async () => {
    expect((await acceptEditsForRun(undefined, 'dir-1', pkg(undefined), deps())).kind).toBe('refused')
    expect((await acceptEditsForRun(RUN, 42, pkg(RUN), deps())).kind).toBe('refused')
    expect((await acceptEditsForRun('../escape', 'dir-1', pkg('../escape'), deps())).kind).toBe('refused')
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
