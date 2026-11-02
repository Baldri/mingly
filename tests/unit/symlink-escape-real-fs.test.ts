/**
 * Symlink escape from the granted-directory model — real filesystem.
 *
 * Audit 2026-10-28. Every path check in the granted-directory model compared
 * spellings: isPathSafe resolves '..' but follows no symlink, and the caller
 * then handed the SAME path to the filesystem. A symlink inside a granted
 * directory was therefore inside the grant by its name and outside it in fact.
 * Measured before the fix: a grant holding `harmless.txt -> ../outside/secret.txt`
 * returned the outside file's content, and so did a symlinked subdirectory.
 *
 * fs is deliberately NOT mocked here. A mocked fs cannot have symlinks, so a
 * test written against one would assert against a model of the filesystem
 * rather than the filesystem — and the defect lives precisely in the gap
 * between the two. Everything runs in a fresh mkdtemp directory.
 *
 * That choice also buys the other half of the behaviour matrix for free: on
 * macOS os.tmpdir() sits under /var, which is a symlink to /private/var, so
 * these tests would fail if the fix resolved only the requested path and
 * compared it against the stored grant string.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const harness = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  showOpenDialog: vi.fn()
}))

const storeMock = vi.hoisted(() => {
  const data: Record<string, any> = {}
  return {
    get: vi.fn((key: string, defaultVal: any) => data[key] ?? defaultVal),
    set: vi.fn((key: string, value: any) => { data[key] = value }),
    clear: () => { Object.keys(data).forEach((k) => delete data[k]) }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      harness.ipcHandlers.set(channel, handler)
    }
  },
  dialog: {
    showOpenDialog: (...args: any[]) => harness.showOpenDialog(...args),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn()
  }
}))

vi.mock('../../src/main/utils/simple-store', () => ({
  SimpleStore: { create: vi.fn(() => ({ get: storeMock.get, set: storeMock.set })) }
}))

vi.mock('../../src/main/ipc/ipc-utils', () => ({
  wrapHandler: vi.fn(),
  requireFeature: vi.fn(),
  requirePermission: vi.fn()
}))

vi.mock('../../src/main/database/models/conversation', () => ({ ConversationModel: {} }))
vi.mock('../../src/main/database/models/message', () => ({ MessageModel: {} }))
vi.mock('../../src/main/database/models/prompt-template', () => ({
  PromptTemplateModel: { create: vi.fn(), countBuiltins: vi.fn(() => 0), findAll: vi.fn(() => []) }
}))
vi.mock('../../src/main/prompts/builtin-templates', () => ({ seedBuiltinTemplates: vi.fn() }))
vi.mock('../../src/main/services/comparison-service', () => ({
  getComparisonService: vi.fn(() => ({ runComparison: vi.fn(), getHistory: vi.fn(() => []) }))
}))

import { FileAccessManager, getFileAccessManager } from '../../src/main/file-access/file-access-manager'
import { resolveRealPath } from '../../src/main/file-access/real-path-guard'
import { registerContentHandlers } from '../../src/main/ipc/content-handlers'
import { IPC_CHANNELS } from '../../src/shared/types'

const SECRET = 'GEHEIM: ausserhalb jedes Grants'
const INSIDE = 'drinnen, legitim'

let root: string
let granted: string
let outside: string

/** A grant whose own path is a symlink, to test the false-alarm direction. */
let grantedViaSymlink: string

beforeEach(async () => {
  vi.clearAllMocks()
  storeMock.clear()
  harness.ipcHandlers.clear()

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mingly-symlink-'))
  granted = path.join(root, 'granted')
  outside = path.join(root, 'outside')
  grantedViaSymlink = path.join(root, 'granted-link')

  await fs.mkdir(granted)
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), SECRET, 'utf-8')
  await fs.writeFile(path.join(granted, 'echt.txt'), INSIDE, 'utf-8')

  // The two escape shapes: a symlinked file and a symlinked directory.
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(granted, 'harmless.txt'))
  await fs.symlink(outside, path.join(granted, 'sub'))
  await fs.symlink(granted, grantedViaSymlink)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Grant `dirPath` through the real requestDirectoryAccess dialog path. */
async function grant(manager: FileAccessManager, dirPath: string) {
  harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [dirPath] })
  const dir = await manager.requestDirectoryAccess(['read', 'create'])
  if (!dir) throw new Error('grant failed')
  return dir
}

describe('FileAccessManager against symlinks in a granted directory', () => {
  let manager: FileAccessManager

  beforeEach(() => {
    manager = new FileAccessManager()
  })

  it('refuses a symlinked file inside the grant', async () => {
    const dir = await grant(manager, granted)

    await expect(manager.readFile({ directoryId: dir.id, filePath: 'harmless.txt', operation: 'read' }))
      .rejects.toThrow('Path traversal attempt detected')
  })

  it('refuses a file reached through a symlinked subdirectory', async () => {
    const dir = await grant(manager, granted)

    await expect(manager.readFile({ directoryId: dir.id, filePath: 'sub/secret.txt', operation: 'read' }))
      .rejects.toThrow('Path traversal attempt detected')
  })

  // Positive control: without it, every refusal above would also pass on a
  // readFile that never returns anything.
  it('still reads a genuine file inside the grant', async () => {
    const dir = await grant(manager, granted)

    const content = await manager.readFile({
      directoryId: dir.id, filePath: 'echt.txt', operation: 'read'
    })
    expect(content).toBe(INSIDE)
  })

  // The false-alarm direction: resolving only the requested path would refuse
  // this, because the realpath of the file is not inside the stored grant.
  it('still reads a genuine file when the grant path is itself a symlink', async () => {
    const dir = await grant(manager, grantedViaSymlink)
    expect(await resolveRealPath(dir.path)).not.toBe(dir.path)

    const content = await manager.readFile({
      directoryId: dir.id, filePath: 'echt.txt', operation: 'read'
    })
    expect(content).toBe(INSIDE)
  })

  it('refuses listing a symlinked subdirectory', async () => {
    const dir = await grant(manager, granted)

    await expect(manager.listFiles(dir.id, 'sub'))
      .rejects.toThrow('Path traversal attempt detected')
  })

  it('still lists the granted directory itself', async () => {
    const dir = await grant(manager, granted)

    const names = (await manager.listFiles(dir.id)).map((f) => f.name).sort()
    expect(names).toContain('echt.txt')
  })

  it('refuses creating a file through a symlinked subdirectory', async () => {
    const dir = await grant(manager, granted)

    await expect(manager.createFile(
      { directoryId: dir.id, filePath: 'sub/planted.md', operation: 'create' },
      'written outside the grant'
    )).rejects.toThrow('Path traversal attempt detected')

    // And nothing was written.
    await expect(fs.access(path.join(outside, 'planted.md'))).rejects.toThrow()
  })

  it('still creates a file inside the grant, including in a new subdirectory', async () => {
    const dir = await grant(manager, granted)

    const result = await manager.createFile(
      { directoryId: dir.id, filePath: 'neu/notiz.md', operation: 'create' },
      INSIDE
    )
    expect(result.success).toBe(true)
    expect(await fs.readFile(path.join(granted, 'neu', 'notiz.md'), 'utf-8')).toBe(INSIDE)
  })
})

describe('resolveRealPath', () => {
  it('resolves a path whose tail does not exist yet', async () => {
    const real = await resolveRealPath(path.join(granted, 'sub', 'nicht', 'da.md'))

    // 'sub' is the symlink, so the answer must sit under its target.
    expect(real).toBe(path.join(await fs.realpath(outside), 'nicht', 'da.md'))
  })

  // What createFile relies on: the part that exists is resolved, the part that
  // cannot carry a symlink yet is appended verbatim.
  it('resolves the deepest existing ancestor and appends the missing tail', async () => {
    const target = path.join(root, 'gibt', 'es', 'nicht.md')

    expect(await resolveRealPath(target))
      .toBe(path.join(await fs.realpath(root), 'gibt', 'es', 'nicht.md'))
  })
})

describe('READ_FILE against symlinks in a granted directory', () => {
  beforeEach(async () => {
    const manager = getFileAccessManager()
    manager.getAllowedDirectories().forEach((dir) => manager.revokeDirectoryAccess(dir.id))
    await registerContentHandlers()
  })

  function readFileChannel() {
    const handler = harness.ipcHandlers.get(IPC_CHANNELS.READ_FILE)
    if (!handler) throw new Error('READ_FILE handler was never registered')
    return handler as (event: unknown, filePath: string) => Promise<any>
  }

  it('refuses a symlink inside the granted directory', async () => {
    await grant(getFileAccessManager(), granted)

    const result = await readFileChannel()({}, path.join(granted, 'harmless.txt'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('not within a granted directory')
    expect(result.error).not.toContain('symlink')
  })

  it('refuses a file behind a symlinked subdirectory', async () => {
    await grant(getFileAccessManager(), granted)

    const result = await readFileChannel()({}, path.join(granted, 'sub', 'secret.txt'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('not within a granted directory')
  })

  it('still reads a genuine file inside the granted directory', async () => {
    await grant(getFileAccessManager(), granted)

    expect(await readFileChannel()({}, path.join(granted, 'echt.txt')))
      .toEqual({ success: true, content: INSIDE })
  })
})
