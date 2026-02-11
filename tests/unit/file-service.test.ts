/**
 * File Service Tests
 * Tests file read/write/list operations with permission checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockShowMessageBox = vi.fn()

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: (...args: any[]) => mockShowMessageBox(...args)
  }
}))

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn()
  },
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({
    isDirectory: () => false,
    isFile: () => true,
    size: 1024,
    birthtime: new Date('2024-01-01'),
    mtime: new Date('2024-06-01')
  })
}))

import { FileService } from '../../src/main/services/file-service'
import { existsSync, statSync } from 'fs'
import fsPromises from 'fs/promises'

describe('FileService', () => {
  let service: FileService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new FileService()
  })

  describe('requestAccess', () => {
    it('should grant access when user approves', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      const result = await service.requestAccess('/home/user/docs')
      expect(result).toBe(true)
    })

    it('should deny access when user rejects', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 1 })
      const result = await service.requestAccess('/home/user/docs')
      expect(result).toBe(false)
    })

    it('should return true if path already allowed', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      // Second call should return true without dialog
      const result = await service.requestAccess('/home/user/docs')
      expect(result).toBe(true)
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1)
    })
  })

  describe('readFile', () => {
    it('should throw when path not allowed', async () => {
      await expect(service.readFile('/unauthorized/file.txt'))
        .rejects.toThrow('Access denied')
    })

    it('should read file when path is allowed', async () => {
      // Grant access first
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(statSync).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-06-01')
      } as any)
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce('file content')

      const result = await service.readFile('/home/user/docs/test.txt')
      expect(result.content).toBe('file content')
      expect(result.metadata.size).toBe(100)
    })

    it('should throw when file not found', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(false)

      await expect(service.readFile('/home/user/docs/missing.txt'))
        .rejects.toThrow('File not found')
    })

    it('should throw when path is a directory', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(statSync).mockReturnValue({
        isDirectory: () => true,
        isFile: () => false,
        size: 0,
        birthtime: new Date(),
        mtime: new Date()
      } as any)

      await expect(service.readFile('/home/user/docs/subdir'))
        .rejects.toThrow('directory')
    })

    it('should throw when file too large', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(statSync).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100 * 1024 * 1024, // 100 MB
        birthtime: new Date(),
        mtime: new Date()
      } as any)

      await expect(service.readFile('/home/user/docs/huge.txt'))
        .rejects.toThrow('File too large')
    })
  })

  describe('listFiles', () => {
    it('should throw when path not allowed', async () => {
      await expect(service.listFiles('/unauthorized'))
        .rejects.toThrow('Access denied')
    })

    it('should list files in allowed directory', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(statSync).mockImplementation((p: any) => ({
        isDirectory: () => String(p).endsWith('docs'),
        isFile: () => !String(p).endsWith('docs'),
        size: 1024,
        birthtime: new Date(),
        mtime: new Date()
      } as any))

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        { name: 'file.txt', isFile: () => true, isDirectory: () => false },
        { name: 'subdir', isFile: () => false, isDirectory: () => true }
      ] as any)

      const files = await service.listFiles('/home/user/docs')
      expect(files).toHaveLength(2)
      expect(files[0].name).toBe('file.txt')
      expect(files[0].type).toBe('file')
      expect(files[1].name).toBe('subdir')
      expect(files[1].type).toBe('directory')
    })

    it('should skip hidden files by default', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(statSync).mockReturnValue({
        isDirectory: () => true,
        isFile: () => false,
        size: 0,
        birthtime: new Date(),
        mtime: new Date()
      } as any)

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        { name: '.hidden', isFile: () => true, isDirectory: () => false },
        { name: 'visible.txt', isFile: () => true, isDirectory: () => false }
      ] as any)

      const files = await service.listFiles('/home/user/docs')
      expect(files).toHaveLength(1)
      expect(files[0].name).toBe('visible.txt')
    })

    it('should filter by extensions', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(statSync).mockImplementation((p: any) => ({
        isDirectory: () => String(p).endsWith('docs'),
        isFile: () => !String(p).endsWith('docs'),
        size: 100,
        birthtime: new Date(),
        mtime: new Date()
      } as any))

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        { name: 'readme.md', isFile: () => true, isDirectory: () => false },
        { name: 'data.json', isFile: () => true, isDirectory: () => false },
        { name: 'script.py', isFile: () => true, isDirectory: () => false }
      ] as any)

      const files = await service.listFiles('/home/user/docs', { extensions: ['.md'] })
      expect(files).toHaveLength(1)
      expect(files[0].name).toBe('readme.md')
    })

    it('should throw when path does not exist', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(false)

      await expect(service.listFiles('/home/user/docs'))
        .rejects.toThrow('Directory not found')
    })
  })

  describe('writeFile', () => {
    it('should throw when path not allowed', async () => {
      await expect(service.writeFile('/unauthorized/file.txt', 'content'))
        .rejects.toThrow('Access denied')
    })

    it('should write new file', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(false) // File doesn't exist yet
      vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined)
      vi.mocked(fsPromises.writeFile).mockResolvedValueOnce(undefined)

      await service.writeFile('/home/user/docs/new.txt', 'content')
      expect(fsPromises.writeFile).toHaveBeenCalled()
    })

    it('should prompt to overwrite existing file', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 }) // Grant access
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true) // File exists
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 }) // Confirm overwrite
      vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined)
      vi.mocked(fsPromises.writeFile).mockResolvedValueOnce(undefined)

      await service.writeFile('/home/user/docs/existing.txt', 'new content')
      expect(fsPromises.writeFile).toHaveBeenCalled()
    })

    it('should cancel when user declines overwrite', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 }) // Grant access
      await service.requestAccess('/home/user/docs')

      vi.mocked(existsSync).mockReturnValue(true) // File exists
      mockShowMessageBox.mockResolvedValueOnce({ response: 1 }) // Cancel overwrite

      await expect(service.writeFile('/home/user/docs/existing.txt', 'new content'))
        .rejects.toThrow('User cancelled')
    })
  })

  describe('clearPermissions', () => {
    it('should clear all allowed paths', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')
      expect(service.getAllowedPaths().length).toBe(1)

      service.clearPermissions()
      expect(service.getAllowedPaths().length).toBe(0)
    })
  })

  describe('getAllowedPaths', () => {
    it('should return empty array by default', () => {
      expect(service.getAllowedPaths()).toEqual([])
    })

    it('should return granted paths', async () => {
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 })
      await service.requestAccess('/home/user/docs')
      expect(service.getAllowedPaths().length).toBe(1)
    })
  })
})
