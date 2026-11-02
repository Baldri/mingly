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

import { FileAccessManager, MOUNT_POINT_REFUSED_MESSAGE } from '../../src/main/file-access/file-access-manager'
import type { FileAccessPermission } from '../../src/shared/file-access-types'
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
    // Containment is checked against the RESOLVED path since the symlink fix,
    // so the fs double has to answer realpath at all. Identity models a path
    // that contains no symlinks; mockMountPointProbe and the escape tests
    // override it where the resolution itself is what is under test.
    vi.mocked(fsPromises.realpath).mockImplementation((async (target: unknown) => String(target)) as never)
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
        .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'contains-home' })

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses the home directory and its parents', async () => {
      for (const mountPoint of [TEST_HOME, path.dirname(TEST_HOME)]) {
        await expect(manager.addNetworkShare({ ...SHARE, mountPoint }))
          .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'contains-home' })
      }

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a relative mount point', async () => {
      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: 'Volumes/NAS' }))
        .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'not-absolute' })

      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a mount point that does not exist', async () => {
      mockMountPointProbe('/Volumes/Other')

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/NAS' }))
        .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'missing' })

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a plain directory that is not a mounted volume', async () => {
      // Separate from the home volume, but the same st_dev as its parent: an
      // ordinary folder on some other disk, not a mount.
      mockMountPointProbe('/srv/data', { sameDeviceAsParent: true })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/srv/data' }))
        .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'not-a-mount' })

      expect(mockShowMessageBox).not.toHaveBeenCalled()
      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a mount point that is a file', async () => {
      mockMountPointProbe('/Volumes/NAS', { isDirectory: false })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/Volumes/NAS' }))
        .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'not-a-directory' })

      expect(manager.getAllowedDirectories()).toEqual([])
    })

    it('refuses a real mount that sits on the volume holding the user\'s files', async () => {
      // The case a path-prefix test cannot see: a bind mount of $HOME under
      // another name has a different device than its parent, and the home
      // path does not start with it, yet granting it grants the home.
      mockMountPointProbe('/mnt/backup', { sameDeviceAsHome: true })

      await expect(manager.addNetworkShare({ ...SHARE, mountPoint: '/mnt/backup' }))
        .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'not-separate-volume' })

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
        .rejects.toMatchObject({ message: MOUNT_POINT_REFUSED_MESSAGE, reason: 'not-separate-volume' })

      expect(manager.getAllowedDirectories()).toEqual([])
    })

    // The refusal crosses the IPC boundary verbatim via wrapHandler, so the
    // message must not tell the renderer anything it did not already know.
    it('says the same thing for every refusal reason', async () => {
      const attempts: Array<[string, () => void]> = [
        ['/', () => undefined],
        ['/Volumes/Ghost', () => mockMountPointProbe('/Volumes/Elsewhere')],
        ['/Volumes/File', () => mockMountPointProbe('/Volumes/File', { isDirectory: false })],
        ['/mnt/backup', () => mockMountPointProbe('/mnt/backup', { sameDeviceAsHome: true })],
        ['/srv/data', () => mockMountPointProbe('/srv/data', { sameDeviceAsParent: true })]
      ]

      const messages = new Set<string>()
      let refusals = 0
      for (const [mountPoint, arrange] of attempts) {
        arrange()
        await manager.addNetworkShare({ ...SHARE, mountPoint }).catch((error: Error) => {
          refusals++
          messages.add(error.message)
          // No path, no realpath, no reason in the text.
          expect(error.message).not.toContain(mountPoint)
          expect(error.message).not.toContain('volume')
          expect(error.message).not.toContain('exist')
        })
      }

      // Every attempt must actually have been refused, otherwise the set below
      // could hold the right message while one path was silently granted.
      expect(refusals).toBe(attempts.length)
      expect(messages).toEqual(new Set([MOUNT_POINT_REFUSED_MESSAGE]))
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

  /**
   * Security regression (audit 2026-11-02): PR #34 closed the door but did
   * not clear out who was already inside. loadAllowedDirectories() took
   * file-access.json back unchecked, and AllowedDirectory carried no evidence
   * of a user confirmation — confirmNetworkShareGrant only ever ran INSIDE
   * addNetworkShare, at granting time. So a network grant that an injected
   * renderer had written before #34 was, after the update, indistinguishable
   * from one the user had confirmed in a dialog, and the next start trusted
   * it again.
   *
   * The invariant under test: a persisted NETWORK grant is only trusted if it
   * carries the marker that is written where the confirmation actually fell.
   */
  describe('loadAllowedDirectories', () => {
    /** Exactly what addNetworkShare persisted before #34 existed. */
    const LEGACY_NETWORK_GRANT = {
      id: 'smb://192.168.1.100/share',
      path: '/Volumes/NAS',
      name: 'NAS',
      location: 'network-smb' as const,
      permissions: ['read', 'create'] as FileAccessPermission[],
      recursive: true,
      networkHost: '192.168.1.100',
      shareName: 'share',
      grantedAt: 1_700_000_000_000,
      accessCount: 0
    }

    const LOCAL_GRANT = {
      id: 'local-docs',
      path: '/home/testuser/documents',
      name: 'documents',
      location: 'local' as const,
      permissions: ['read'] as FileAccessPermission[],
      recursive: true,
      grantedAt: 1_700_000_000_000,
      accessCount: 0
    }

    /** Seed the persisted store, then load it the way a restart would. */
    function restartWith(...dirs: unknown[]): FileAccessManager {
      mockStoreData.set('allowedDirectories', dirs)
      return new FileAccessManager()
    }

    it('does not trust a network grant persisted without a confirmation marker', async () => {
      // Resolves rather than throws, so a read that gets through is visible as
      // a read and not as some unrelated fs error.
      vi.mocked(fsPromises.readFile).mockResolvedValue('secret' as never)

      const reloaded = restartWith(LEGACY_NETWORK_GRANT)

      expect(reloaded.getAllowedDirectories()).toEqual([])
      await expect(
        reloaded.readFile({ directoryId: LEGACY_NETWORK_GRANT.id, filePath: 'notes.txt', operation: 'read' })
      ).rejects.toThrow('Directory access not granted')
    })

    it('rejects a marker that is not a usable timestamp', () => {
      // The marker's job is to be absent on a legacy entry, so anything that
      // is not a real timestamp has to count as absent too.
      for (const confirmedAt of [0, -1, NaN, 'yes', null, {}]) {
        const reloaded = restartWith({ ...LEGACY_NETWORK_GRANT, confirmedAt })
        expect(reloaded.getAllowedDirectories()).toEqual([])
      }
    })

    it('keeps the dropped grant on record instead of destroying it', () => {
      // networkShares is in-memory only, so this entry is the sole surviving
      // record of the host, share and username the user typed. Deleting it
      // outright would cost them that, with nothing to re-grant from.
      const reloaded = restartWith(LEGACY_NETWORK_GRANT)

      expect(reloaded.getUnconfirmedDirectories()).toEqual([LEGACY_NETWORK_GRANT])
    })

    it('does not re-trust a dropped grant on the next start', () => {
      restartWith(LEGACY_NETWORK_GRANT)

      // The pruned list is written back, so the second start sees a clean
      // allowlist and the record is not duplicated.
      const second = new FileAccessManager()
      expect(second.getAllowedDirectories()).toEqual([])
      expect(second.getUnconfirmedDirectories()).toEqual([LEGACY_NETWORK_GRANT])
    })

    // Positive control: without these, every assertion above would also pass
    // on a load that simply dropped everything.
    it('keeps a network grant that carries the confirmation marker', async () => {
      const confirmed = { ...LEGACY_NETWORK_GRANT, confirmedAt: 1_700_000_001_000 }
      vi.mocked(fsPromises.readFile).mockResolvedValue('payload' as never)

      const reloaded = restartWith(confirmed)

      expect(reloaded.getAllowedDirectories()).toEqual([confirmed])
      expect(reloaded.getUnconfirmedDirectories()).toEqual([])
      await expect(
        reloaded.readFile({ directoryId: confirmed.id, filePath: 'notes.txt', operation: 'read' })
      ).resolves.toBe('payload')
    })

    // Positive control: local grants come from the OS directory picker, which
    // is itself the user's gesture. Their behaviour must not change.
    it('keeps a local grant that predates the marker', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('local payload' as never)

      const reloaded = restartWith(LOCAL_GRANT)

      expect(reloaded.getAllowedDirectories()).toEqual([LOCAL_GRANT])
      await expect(
        reloaded.readFile({ directoryId: LOCAL_GRANT.id, filePath: 'notes.txt', operation: 'read' })
      ).resolves.toBe('local payload')
    })

    it('drops only the unconfirmed entry out of a mixed store', () => {
      const confirmed = {
        ...LEGACY_NETWORK_GRANT,
        id: 'smb://10.0.0.5/confirmed',
        path: '/Volumes/Confirmed',
        confirmedAt: 1_700_000_002_000
      }

      const reloaded = restartWith(LEGACY_NETWORK_GRANT, confirmed, LOCAL_GRANT)

      expect(reloaded.getAllowedDirectories().map((d) => d.id)).toEqual([confirmed.id, LOCAL_GRANT.id])
      expect(reloaded.getUnconfirmedDirectories().map((d) => d.id)).toEqual([LEGACY_NETWORK_GRANT.id])
    })
  })

  /**
   * The marker is only worth something if it is written exactly where the
   * user's confirmation actually fell, so these pin both routes.
   */
  describe('confirmation marker at granting time', () => {
    it('marks a directory the user picked in the OS dialog', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/testuser/documents']
      })

      const granted = await manager.requestDirectoryAccess(['read'])

      expect(granted!.confirmedAt).toBeGreaterThan(0)
    })

    it('marks a network share the user confirmed in the dialog', async () => {
      mockMountPointProbe('/Volumes/NAS')
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })

      await manager.addNetworkShare({
        name: 'NAS',
        protocol: 'smb',
        host: '192.168.1.100',
        shareName: 'share',
        mountPoint: '/Volumes/NAS'
      })

      expect(manager.getAllowedDirectories()[0].confirmedAt).toBeGreaterThan(0)
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
