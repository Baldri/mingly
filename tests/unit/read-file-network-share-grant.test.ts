/**
 * READ_FILE x network-share grant — security regression test
 *
 * Audit 2026-10-26: FILE_ACCESS_ADD_NETWORK_SHARE took `config: any` from the
 * renderer and turned config.mountPoint straight into an AllowedDirectory with
 * read and create rights — no dialog, no validation. READ_FILE constrains raw
 * reads to getFileAccessManager().getAllowedDirectories() (the fix from the
 * 2026-08-21 audit), so a renderer that posted { mountPoint: '/' } first and
 * then called READ_FILE read any file on the machine through a check that
 * looked like it was holding.
 *
 * These tests run the two channels against ONE FileAccessManager, because the
 * defect only showed up in the join: each side was self-consistent.
 *
 * ipc-utils is stubbed rather than mocked faithfully — READ_FILE registers
 * itself through ipcMain.handle directly, not through wrapHandler, so its own
 * code path here is the real one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const harness = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn()
}))

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn()
}))

const storeMock = vi.hoisted(() => {
  const data: Record<string, any> = {}
  return {
    get: vi.fn((key: string, defaultVal: any) => data[key] ?? defaultVal),
    set: vi.fn((key: string, value: any) => { data[key] = value }),
    clear: () => { Object.keys(data).forEach((k) => delete data[k]) }
  }
})

const TEST_HOME = '/home/testuser'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mingly-read-file-test' },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      harness.ipcHandlers.set(channel, handler)
    }
  },
  dialog: {
    showOpenDialog: (...args: any[]) => harness.showOpenDialog(...args),
    showSaveDialog: vi.fn(),
    showMessageBox: (...args: any[]) => harness.showMessageBox(...args)
  }
}))

vi.mock('os', () => ({
  default: { homedir: () => TEST_HOME },
  homedir: () => TEST_HOME
}))

vi.mock('fs/promises', () => ({ default: fsMock, ...fsMock }))

vi.mock('../../src/main/utils/simple-store', () => ({
  SimpleStore: {
    create: vi.fn(() => ({ get: storeMock.get, set: storeMock.set }))
  }
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

import path from 'path'
import { IPC_CHANNELS } from '../../src/shared/types'
import { registerContentHandlers } from '../../src/main/ipc/content-handlers'
import { getFileAccessManager } from '../../src/main/file-access/file-access-manager'

/**
 * Make the fs mock answer a mount-point probe for `mountPath`: a real mount
 * on device 42, with $HOME, the filesystem root and the parent directory all
 * on device 1.
 */
function mockMountPointProbe(mountPath: string): void {
  const parent = path.dirname(mountPath)
  fsMock.realpath.mockImplementation(async (target: unknown) => String(target))
  fsMock.stat.mockImplementation(async (target: unknown) => {
    const probed = String(target)
    if (probed === mountPath) return { isDirectory: () => true, dev: 42 }
    if (probed === TEST_HOME || probed === path.parse(TEST_HOME).root || probed === parent) {
      return { isDirectory: () => true, dev: 1 }
    }
    throw Object.assign(new Error(`ENOENT: ${probed}`), { code: 'ENOENT' })
  })
}

function readFileChannel(): (event: unknown, filePath: string) => Promise<any> {
  const handler = harness.ipcHandlers.get(IPC_CHANNELS.READ_FILE)
  if (!handler) throw new Error('READ_FILE handler was never registered')
  return handler as (event: unknown, filePath: string) => Promise<any>
}

describe('READ_FILE after an attempted network-share grant', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Same reason as in file-access-manager.test.ts: the fs double must answer
    // realpath now that containment compares resolved paths. mockMountPointProbe
    // narrows it per test where the probe is the point.
    fsMock.realpath.mockImplementation(async (target: unknown) => String(target))
    harness.ipcHandlers.clear()
    storeMock.clear()

    // getFileAccessManager is a module-level singleton, so the allowlist has
    // to be emptied explicitly between tests.
    const manager = getFileAccessManager()
    manager.getAllowedDirectories().forEach((dir) => manager.revokeDirectoryAccess(dir.id))

    await registerContentHandlers()
  })

  it('refuses a file outside the granted directories after the renderer tried to grant itself /', async () => {
    const manager = getFileAccessManager()

    await expect(
      manager.addNetworkShare({
        name: 'anything',
        protocol: 'smb',
        host: 'attacker.local',
        shareName: 'all',
        mountPoint: '/'
      })
    ).rejects.toMatchObject({ reason: 'contains-home' })

    expect(manager.getAllowedDirectories()).toEqual([])
    expect(harness.showMessageBox).not.toHaveBeenCalled()

    const result = await readFileChannel()({}, '/etc/passwd')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Access denied')
    // The read must be refused before it reaches the filesystem at all.
    expect(fsMock.readFile).not.toHaveBeenCalled()
  })

  // Positive control: without this, the refusal above would also pass on a
  // READ_FILE that never returns a file to anyone.
  it('still hands out a file inside a directory the user granted', async () => {
    const manager = getFileAccessManager()
    harness.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Volumes/Share/docs']
    })
    const dir = await manager.requestDirectoryAccess(['read'])
    expect(dir).not.toBeNull()

    fsMock.readFile.mockResolvedValueOnce('content of a granted file')

    const result = await readFileChannel()({}, '/Volumes/Share/docs/notes.md')

    expect(result).toEqual({ success: true, content: 'content of a granted file' })
  })

  it('reads inside a share the user confirmed, and nowhere else', async () => {
    const manager = getFileAccessManager()
    mockMountPointProbe('/Volumes/NAS')
    harness.showMessageBox.mockResolvedValueOnce({ response: 0 })

    await manager.addNetworkShare({
      name: 'NAS',
      protocol: 'smb',
      host: '192.168.1.100',
      shareName: 'share',
      mountPoint: '/Volumes/NAS'
    })

    fsMock.readFile.mockResolvedValueOnce('inside the confirmed share')
    expect(await readFileChannel()({}, '/Volumes/NAS/report.md'))
      .toEqual({ success: true, content: 'inside the confirmed share' })

    // The grant covers the volume it named, not its siblings.
    const outside = await readFileChannel()({}, '/Volumes/Other/report.md')
    expect(outside.success).toBe(false)
    expect(outside.error).toContain('Access denied')
    expect(fsMock.readFile).toHaveBeenCalledTimes(1)
  })
})
