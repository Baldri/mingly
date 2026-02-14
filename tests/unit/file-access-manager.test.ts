/**
 * File Access Manager Tests
 * Tests directory access control, file read/create with security checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockShowOpenDialog = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-file-access-test'
  },
  dialog: {
    showOpenDialog: (...args: any[]) => mockShowOpenDialog(...args)
  }
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

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
    stat: vi.fn()
  },
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn()
}))

import { FileAccessManager } from '../../src/main/file-access/file-access-manager'
import fsPromises from 'fs/promises'

describe('FileAccessManager', () => {
  let manager: FileAccessManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreData.clear()
    mockShowOpenDialog.mockReset()
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

  describe('addNetworkShare', () => {
    it('should add network share without mount point', async () => {
      const share = await manager.addNetworkShare({
        name: 'NAS Share',
        protocol: 'smb',
        host: '192.168.1.100',
        shareName: 'data'
      })
      expect(share.id).toContain('smb')
      expect(share.name).toBe('NAS Share')
    })

    it('should add network share with mount point as allowed directory', async () => {
      await manager.addNetworkShare({
        name: 'NAS',
        protocol: 'smb',
        host: '192.168.1.100',
        shareName: 'share',
        mountPoint: '/Volumes/NAS'
      })
      const dirs = manager.getAllowedDirectories()
      expect(dirs.length).toBe(1)
      expect(dirs[0].path).toBe('/Volumes/NAS')
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
