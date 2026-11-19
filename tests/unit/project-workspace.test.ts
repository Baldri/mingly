import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ensureProjectWorkspace,
  ProjectWorkspaceError
} from '../../src/main/coding/project-workspace'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('ensureProjectWorkspace', () => {
  let p: string
  let outside: string

  beforeEach(() => {
    p = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-ws-project-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-ws-outside-'))
  })

  afterEach(() => {
    for (const d of [p, outside]) {
      try {
        fs.chmodSync(d, 0o700)
      } catch {
        // already gone
      }
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  it('creates snapshot and context directories under the project', async () => {
    const ws = await ensureProjectWorkspace(p, 'r1')
    expect(ws.root).toBe(path.join(p, '.mingly'))
    expect(ws.snapshotDir).toBe(path.join(p, '.mingly', 'snapshots', 'r1'))
    expect(ws.contextDir).toBe(path.join(p, '.mingly', 'context', 'r1'))
    expect(fs.statSync(ws.snapshotDir).isDirectory()).toBe(true)
    expect(fs.statSync(ws.contextDir).isDirectory()).toBe(true)
  })

  it('throws before writing when .mingly exists as a file', async () => {
    fs.writeFileSync(path.join(p, '.mingly'), 'not a directory')
    await expect(ensureProjectWorkspace(p, 'r1')).rejects.toThrow(ProjectWorkspaceError)
    expect(fs.readFileSync(path.join(p, '.mingly'), 'utf-8')).toBe('not a directory')
    expect(fs.readdirSync(p)).toEqual(['.mingly'])
  })

  it('throws when .mingly is a symlink, even to a directory outside the project', async () => {
    fs.symlinkSync(outside, path.join(p, '.mingly'))
    await expect(ensureProjectWorkspace(p, 'r1')).rejects.toThrow(ProjectWorkspaceError)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('throws when a nested component is a symlink out of the project', async () => {
    fs.mkdirSync(path.join(p, '.mingly'))
    fs.symlinkSync(outside, path.join(p, '.mingly', 'snapshots'))
    await expect(ensureProjectWorkspace(p, 'r1')).rejects.toThrow(ProjectWorkspaceError)
    expect(fs.readdirSync(outside)).toEqual([])
    // nothing half-created on the other branch either
    expect(fs.existsSync(path.join(p, '.mingly', 'context'))).toBe(false)
  })

  it.skipIf(isRoot)('throws when the project directory is not writable', async () => {
    fs.chmodSync(p, 0o500)
    await expect(ensureProjectWorkspace(p, 'r1')).rejects.toThrow(ProjectWorkspaceError)
    expect(fs.existsSync(path.join(p, '.mingly'))).toBe(false)
  })

  it('throws when the project path does not exist', async () => {
    await expect(ensureProjectWorkspace(path.join(p, 'missing'), 'r1')).rejects.toThrow(
      ProjectWorkspaceError
    )
  })

  it('throws when the project path is a file', async () => {
    const f = path.join(p, 'f.txt')
    fs.writeFileSync(f, 'x')
    await expect(ensureProjectWorkspace(f, 'r1')).rejects.toThrow(ProjectWorkspaceError)
  })

  it('throws for a relative project path', async () => {
    await expect(ensureProjectWorkspace('relative/dir', 'r1')).rejects.toThrow(
      ProjectWorkspaceError
    )
  })

  it.each(['', '..', '.', 'a/b', 'a\\b', '../x', 'a\0b', ' '])(
    'rejects the unsafe runId %j without writing',
    async (runId) => {
      await expect(ensureProjectWorkspace(p, runId)).rejects.toThrow(ProjectWorkspaceError)
      expect(fs.readdirSync(p)).toEqual([])
    }
  )

  it('adds .mingly/ to an existing .gitignore exactly once', async () => {
    fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules\n')
    await ensureProjectWorkspace(p, 'r1')
    await ensureProjectWorkspace(p, 'r2')
    const lines = fs.readFileSync(path.join(p, '.gitignore'), 'utf-8').split('\n')
    expect(lines.filter((l) => l.trim() === '.mingly/')).toHaveLength(1)
    expect(lines).toContain('node_modules')
  })

  it('appends on its own line when the .gitignore has no trailing newline', async () => {
    fs.writeFileSync(path.join(p, '.gitignore'), 'dist')
    await ensureProjectWorkspace(p, 'r1')
    expect(fs.readFileSync(path.join(p, '.gitignore'), 'utf-8')).toBe('dist\n.mingly/\n')
  })

  it.each(['.mingly', '.mingly/', '/.mingly', '/.mingly/'])(
    'leaves a .gitignore alone that already ignores %s',
    async (entry) => {
      const content = `a\n${entry}\nb\n`
      fs.writeFileSync(path.join(p, '.gitignore'), content)
      await ensureProjectWorkspace(p, 'r1')
      expect(fs.readFileSync(path.join(p, '.gitignore'), 'utf-8')).toBe(content)
    }
  )

  it('never creates a .gitignore', async () => {
    await ensureProjectWorkspace(p, 'r1')
    expect(fs.existsSync(path.join(p, '.gitignore'))).toBe(false)
  })

  it.skipIf(isRoot)('throws before writing when the .gitignore is not writable', async () => {
    const gi = path.join(p, '.gitignore')
    fs.writeFileSync(gi, 'dist\n')
    fs.chmodSync(gi, 0o400)
    await expect(ensureProjectWorkspace(p, 'r1')).rejects.toThrow(ProjectWorkspaceError)
    expect(fs.existsSync(path.join(p, '.mingly'))).toBe(false)
  })

  it.skipIf(isRoot)('succeeds with a read-only .gitignore that already has the entry', async () => {
    const gi = path.join(p, '.gitignore')
    fs.writeFileSync(gi, 'dist\n.mingly/\n')
    fs.chmodSync(gi, 0o400)
    const ws = await ensureProjectWorkspace(p, 'r1')
    expect(fs.statSync(ws.contextDir).isDirectory()).toBe(true)
    expect(fs.readFileSync(gi, 'utf-8')).toBe('dist\n.mingly/\n')
  })

  it.skipIf(isRoot)('still throws for a read-only .gitignore that lacks the entry', async () => {
    const gi = path.join(p, '.gitignore')
    fs.writeFileSync(gi, 'dist\n')
    fs.chmodSync(gi, 0o400)
    await expect(ensureProjectWorkspace(p, 'r1')).rejects.toThrow(ProjectWorkspaceError)
    expect(fs.existsSync(path.join(p, '.mingly'))).toBe(false)
    expect(fs.readFileSync(gi, 'utf-8')).toBe('dist\n')
  })

  it('tightens permissions of an already existing .mingly to 0700', async () => {
    // existing directory: mkdir({ recursive, mode }) would be a no-op here
    fs.mkdirSync(path.join(p, '.mingly'), { mode: 0o755 })
    fs.chmodSync(path.join(p, '.mingly'), 0o755)
    const ws = await ensureProjectWorkspace(p, 'r1')
    for (const d of [ws.root, path.join(ws.root, 'snapshots'), ws.snapshotDir, ws.contextDir]) {
      expect(fs.statSync(d).mode & 0o777).toBe(0o700)
    }
  })

  it('is idempotent for the same runId', async () => {
    const a = await ensureProjectWorkspace(p, 'r1')
    fs.writeFileSync(path.join(a.contextDir, 'keep.txt'), 'x')
    const b = await ensureProjectWorkspace(p, 'r1')
    expect(b).toEqual(a)
    expect(fs.existsSync(path.join(b.contextDir, 'keep.txt'))).toBe(true)
  })
})
