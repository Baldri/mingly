import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('fs', () => {
  const existsSync = vi.fn().mockReturnValue(false)
  const mkdirSync = vi.fn()
  const rmSync = vi.fn()
  const readdirSync = vi.fn().mockReturnValue([])
  return {
    default: { existsSync, mkdirSync, rmSync, readdirSync },
    existsSync,
    mkdirSync,
    rmSync,
    readdirSync
  }
})

import { NERModelManager } from '../../src/main/privacy/model-manager'

describe('NERModelManager', () => {
  let manager: NERModelManager

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: directory does not exist (for constructor's checkLocalStatus)
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
    manager = new NERModelManager()
  })

  it('returns not_downloaded when model directory does not exist', () => {
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
    expect(manager.getStatus()).toBe('not_downloaded')
  })

  it('returns ready when model files exist', () => {
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['onnx'])
    expect(manager.getStatus()).toBe('ready')
  })

  it('returns correct model directory path', () => {
    const expected = path.join(os.homedir(), '.mingly', 'models', 'piiranha-v1')
    expect(manager.getModelDir()).toBe(expected)
  })

  it('getModelId returns piiranha model identifier', () => {
    expect(manager.getModelId()).toBe('piiranha/piiranha-v1-detect-personal-information')
  })

  it('delete removes model directory', () => {
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    manager.deleteModel()
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('piiranha-v1'),
      { recursive: true, force: true }
    )
  })

  it('delete is no-op when model not downloaded', () => {
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
    manager.deleteModel()
    expect(fs.rmSync).not.toHaveBeenCalled()
  })
})
