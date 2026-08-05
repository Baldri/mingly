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

  // The model id is asserted as a LITERAL on purpose, not read back from the
  // manager — that would assert nothing. Swapping the model is a deliberate
  // decision (see the rationale block in model-manager.ts), so it should
  // require a deliberate edit here. Changed 2026-08-05 from
  // 'onnx-community/piiranha-v1-detect-personal-information-ONNX' because
  // that model detected 2 of 20 person spans while the settings panel
  // promised name detection.
  const MODEL_ID = 'Xenova/bert-base-multilingual-cased-ner-hrl'

  it('returns correct model directory path', () => {
    const expected = path.join(os.homedir(), '.mingly', 'models', ...MODEL_ID.split('/'))
    expect(manager.getModelDir()).toBe(expected)
  })

  it('returns correct cache directory path', () => {
    const expected = path.join(os.homedir(), '.mingly', 'models')
    expect(manager.getCacheDir()).toBe(expected)
  })

  it('getModelId returns the configured model identifier', () => {
    expect(manager.getModelId()).toBe(MODEL_ID)
  })

  it('delete removes model directory', () => {
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    manager.deleteModel()
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(MODEL_ID.split('/')[1]),
      { recursive: true, force: true }
    )
  })

  it('delete is no-op when model not downloaded', () => {
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
    manager.deleteModel()
    expect(fs.rmSync).not.toHaveBeenCalled()
  })
})
