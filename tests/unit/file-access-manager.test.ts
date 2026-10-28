/**
 * File Access Manager Tests
 * Tests directory access control, file read/create with security checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockShowOpenDialog = vi.fn()
const mockShowMessageBox = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-file-access-test'
  },
  dialog: {
    showOpenDialog: (...args: any[]) => mockShowOpenDialog(...args),
    showMessageBox: (...args: any[]) => mockShowMessageBox(...args)
  }
}))

// Pinned so the home-directory guard is tested against a known home rather
// than whichever machine runs the suite.
const TEST_HOME = '/home/testuser'
vi.mock('os', () => ({
  default: { homedir: () => TEST_HOME },
  homedir: () => TEST_HOME
}))

const mockStoreData = vi.hoisted(() => {
  const data: Record<string, any> = {}
  return {
    get: vi.fn((key: string, defaultVal: any) => data[key] ?? defaultVal),
    set: vi.fn((key: string, value: any) => { data[key] = value }),
    clear: () => { Object.keys(data).forEach(k => delete data[k]) }
  }
})

vi.mock('../../src/main/utils/simple-store', () => ({
  SimpleStore: {
    create: vi.fn(() => ({
      get: mockStoreData.get,
      set: mockStoreData.set
    }))
  }
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

vi.mock('fs/promises', () => ({ default: fsMock, ...fsMock }))

import { FileAccessManager } from '../../src/main/file-access/file-access-manager'
import fsPromises from 'fs/promises'
import path from 'path'

/**
 * Teach the fs mock what a mount-point probe should see.
 *
 * assertGrantableMountPoint realpaths the candidate, then compares its st_dev
 * against the volume holding $HOME, against the filesystem root and against
 * its own parent directory. Device 1 is "the volume the user's files live on"
 * throughout these tests; device 42 is a separate volume.
 */
const HOME_DEVICE = 1
const SEPARATE_DEVICE = 42

function mockMountPointProbe(
  mountPath: string,
  opts: {
    sameDeviceAsParent?: boolean
    isDirectory?: boolean
    sameDeviceAsHome?: boolean
    realpathTo?: string
  } = {}
): void {
  const realPath = opts.realpathTo ?? mountPath
  const parent = path.dirname(realPath)
  const mountDevice = opts.sameDeviceAsHome ? HOME_DEVICE : SEPARATE_DEVICE

  vi.mocked(fsPromises.realpath).mockImplementation((async (target: unknown) => {
    const probed = String(target)
    if (probed === mountPath) return realPath
    if (probed === TEST_HOME) return TEST_HOME
    throw Object.assign(new Error(`ENOENT: ${probed}`), { code: 'ENOENT' })
  }) as never)

  vi.mocked(fsPromises.stat).mockImplementation((async (target: unknown) => {
    const probed = String(target)
    if (probed === realPath) {
      return { isDirectory: () => opts.isDirectory !== false, dev: mountDevice }
    }
    if (probed === TEST_HOME || probed === path.parse(TEST_HOME).root) {
      return { isDirectory: () => true, dev: HOME_DEVICE }
    }
    if (probed === parent) {
      return { isDirectory: () => true, dev: opts.sameDeviceAsParent ? mountDevice : HOME_DEVICE }
    }
    throw Object.assign(new Error(`ENOENT: ${probed}`), { code: 'ENOENT' })
  }) as never)
}

describe('FileAccessManager', () => {
  let manager: FileAccessManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreData.clear()
    mockShowOpenDialog.mockReset()
    mockShowMessageBox.mockReset()
    manager = new FileAccessManager()
  })

  describe('getAllowedDirectories', () => {
    it('should return empty array by default', () => {
      expect(manager.getAllowedDirectories()).toEqual([])
    })
  })

  describe('requestDirectoryAccess', () => {
    it('should return null when user cancels dialog', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
      const result = await manager.requestDirectoryAccess()
      expect(result).toBeNull()
    })

    it('should return null when no paths selected', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
      const result = await manager.requestDirectoryAccess()
      expect(result).toBeNull()
    })

    it('should grant access and return directory info', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/documents']
      })

      const result = await manager.requestDirectoryAccess(['read'])
      expect(result).not.toBeNull()
      expect(result!.path).toBe('/home/user/documents')
      expect(result!.name).toBe('documents')
      expect(result!.permissions).toEqual(['read'])
    })

    it('should add directory to allowed list', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/documents']
      })

      await manager.requestDirectoryAccess()
      const dirs = manager.getAllowedDirectories()
      expect(dirs.length).toBe(1)
    })

    it('should handle dialog error', async () => {
      mockShowOpenDialog.mockRejectedValueOnce(new Error('Dialog error'))
      const result = await manager.requestDirectoryAccess()
      expect(result).toBeNull()
    })
  })

  describe('revokeDirectoryAccess', () => {
    it('should return false when directory not found', () => {
      const result = manager.revokeDirectoryAccess('nonexistent')
      expect(result).toBe(false)
    })

    it('should revoke and return true', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/documents']
      })
      const dir = await manager.requestDirectoryAccess()

      const result = manager.revokeDirectoryAccess(dir!.id)
      expect(result).toBe(true)
      expect(manager.getAllowedDirectories().length).toBe(0)
    })
  })

  describe('readFile', () => {
    it('should throw when directory not granted', async () => {
      await expect(manager.readFile({ directoryId: 'unknown', filePath: 'file.txt' }))
        .rejects.toThrow('Directory access not granted')
    })

    it('should throw when read permission not granted', async () => {
      // Grant directory with 'create' only permission
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['create'])

      await expect(manager.readFile({ directoryId: dir!.id, filePath: 'file.txt' }))
        .rejects.toThrow('Read permission not granted')
    })

    it('should throw on path traversal', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['read'])

      await expect(manager.readFile({ directoryId: dir!.id, filePath: '../../etc/passwd' }))
        .rejects.toThrow('Path traversal')
    })

    it('should throw on disallowed file extension', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['read'])

      await expect(manager.readFile({ directoryId: dir!.id, filePath: 'file.exe' }))
        .rejects.toThrow('not allowed')
    })

    it('should read file successfully', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['read'])

      vi.mocked(fsPromises.readFile).mockResolvedValueOnce('file content')

      const content = await manager.readFile({ directoryId: dir!.id, filePath: 'readme.md' })
      expect(content).toBe('file content')
    })
  })

  describe('createFile', () => {
    it('should throw when directory not granted', async () => {
      await expect(manager.createFile({ directoryId: 'unknown', filePath: 'new.txt' }, 'content'))
        .rejects.toThrow('Directory access not granted')
    })

    it('should throw when create permission not granted', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['read'])

      await expect(manager.createFile({ directoryId: dir!.id, filePath: 'new.txt' }, 'content'))
        .rejects.toThrow('Create permission not granted')
    })

    it('should throw on path traversal', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['create'])

      await expect(manager.createFile({ directoryId: dir!.id, filePath: '../../etc/hack.txt' }, 'x'))
        .rejects.toThrow('Path traversal')
    })

    it('should throw when file already exists', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['create'])

      // fs.access resolves = file exists
      vi.mocked(fsPromises.access).mockResolvedValueOnce(undefined)

      await expect(manager.createFile({ directoryId: dir!.id, filePath: 'existing.txt' }, 'content'))
        .rejects.toThrow('already exists')
    })

    it('should create file successfully', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['create'])

      // fs.access rejects with ENOENT = file does not exist
      vi.mocked(fsPromises.access).mockRejectedValueOnce({ code: 'ENOENT' })
      vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined)
      vi.mocked(fsPromises.writeFile).mockResolvedValueOnce(undefined)

      const result = await manager.createFile({ directoryId: dir!.id, filePath: 'new.md' }, 'content')
      expect(result.success).toBe(true)
    })
  })

  describe('listFiles', () => {
    it('should throw when directory not granted', async () => {
      await expect(manager.listFiles('unknown'))
        .rejects.toThrow('Directory access not granted')
    })

    it('should list files in allowed directory', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['read'])

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        { name: 'readme.md', isFile: () => true, isDirectory: () => false },
        { name: 'sub', isFile: () => false, isDirectory: () => true }
      ] as any)

      vi.mocked(fsPromises.stat).mockResolvedValue({
        size: 512,
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-06-01')
      } as any)

      const files = await manager.listFiles(dir!.id)
      expect(files.length).toBe(2)
    })

    it('should throw on path traversal in relative path', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess(['read'])

      await expect(manager.listFiles(dir!.id, '../../etc'))
        .rejects.toThrow('Path traversal')
    })
  })

  /**
   * Security regression (audit 2026-10-26): addNetworkShare turned a
   * caller-supplied mountPoint straight into an AllowedDirectory with read
   * and create rights, no dialog and no checks. The channel in front of it is
   * reachable from the renderer, which in Mingly renders LLM answers, RAG
   * documents and MCP content — so { mountPoint: '/' } from an injected
   * renderer granted the whole filesystem, and every check that reads
   * getAllowedDirectories() back (READ_FILE among them) then passed.
   *
   * The invariant under test: a mountPoint the CALLER chose never produces a
   * grant on its own. Only the user's confirmation does.
   */
  describe('addNetworkShare', () => {
    const SHARE = {
      name: 'NAS',
      protocol: 'smb' as const,
      host: '192.168.1.100',
      shareName: 'share'
    }

    it('should add network share without mount point, granting no directory', async () => {
      const share = await manager.addNetworkShare({ ...SHARE, name: 'NAS Share', shareName: 'data' })

      expect(share.id).toContain('smb')
      expect(share.name).toBe('NAS Share')
      // Nothing to grant, so nothing to confirm.
      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses the filesystem root without even asking the user', async () => {
      // The exact payload from the finding.
      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/' }))
        .rejects.toThrow('must not be the home directory or one of its parents')

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses the home directory and its parents', async () => {
      for (const mountPoint of [TEST_HOME, path.dirname(TEST_HOME)]) {
        await expect(manager.addNetworkShare({ ...SHARE, mountPoint }))
          .rejects.toThrow('must not be the home directory or one of its parents')
      }

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a relative mount point', async () => {
      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: 'Volumes/NAS' }))
        .rejects.toThrow('must be an absolute path')

      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a mount point that does not exist', async () => {
      mockMountPointProbe('/Volumes/Other')

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/NAS' }))
        .rejects.toThrow('Mount point does not exist')

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a plain directory that is not a mounted volume', async () => {
      // Separate from the home volume, but the same st_dev as its parent: an
      // ordinary folder on some other disk, not a mount.
      mockMountPointProbe('/srv/data', { sameDeviceAsParent: true })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/srv/data' }))
        .rejects.toThrow('is not a mounted volume')

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a mount point that is a file', async () => {
      mockMountPointProbe('/Volumes/NAS', { isDirectory: false })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/NAS' }))
        .rejects.toThrow('is not a directory')

      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a real mount that sits on the volume holding the user\'s files', async () => {
      // The case a path-prefix test cannot see: a bind mount of $HOME under
      // another name has a different device than its parent, and the home
      // path does not start with it, yet granting it grants the home.
      mockMountPointProbe('/mnt/backup', { sameDeviceAsHome: true })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/mnt/backup' }))
        .rejects.toThrow('not a separate volume')

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('grants the realpath, not the symlink the caller named', async () => {
      // Otherwise the path that was validated is not the path that gets read.
      mockMountPointProbe('/Volumes/link', { realpathTo: '/Volumes/NAS' })
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })

      await manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/link' })

      expect(manager.getAllowedDirectories()[0].path).toBe('/Volumes/NAS')
      expect(mockShowMessageBox.mock.calls[0][0].message).toContain('/Volumes/NAS')
    })

    it('refuses a symlink that resolves onto the home volume', async () => {
      mockMountPointProbe('/Volumes/link', {
        realpathTo: '/mnt/backup',
        sameDeviceAsHome: true
      })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/link' }))
        .rejects.toThrow('not a separate volume')

      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('grants nothing when the user declines the confirmation', async () => {
      // A mount point that passes every plausibility check still needs a human.
      mockMountPointProbe('/Volumes/NAS')
      mockShowMessageBox.mockResolvedValueOnce({ response: 1 })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/NAS' }))
        .rejects.toThrow('denied by user')

      expect(mockShowMessageBox).toHaveBeenCalledTimes(1)
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    // Positive control: the intended route must still work, otherwise the
    // refusals above would also pass on a method that simply never grants.
    it('grants the mount point when it is a real volume and the user confirms', async () => {
      mockMountPointProbe('/Volumes/NAS')
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })

      const share = await manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/NAS' })

      expect(share.mountPoint).toBe('/Volumes/NAS')
      const dirs = manager.getAllowedDirectories()
      expect(dirs.length).toBe(1)
      expect(dirs[0].path).toBe('/Volumes/NAS')
      expect(dirs[0].location).toBe('network-smb')
      expect(dirs[0].permissions).toEqual(['read', 'create'])

      // The dialog must name the path it is about to grant, ahead of any
      // caller-supplied text.
      expect(mockShowMessageBox.mock.calls[0][0].message).toContain('/Volumes/NAS')
    })
  })

  describe('createAIOutputDirectory', () => {
    it('should throw when directory not granted', async () => {
      await expect(manager.createAIOutputDirectory('unknown'))
        .rejects.toThrow('Directory access not granted')
    })

    it('should create AI output directory', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/docs']
      })
      const dir = await manager.requestDirectoryAccess()

      vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined)

      const outputPath = await manager.createAIOutputDirectory(dir!.id)
      expect(outputPath).toContain('Mingly-AI-Output')
    })
  })
})
