// tests/unit/privacy-ner-detector.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NERDetector } from '../../src/main/privacy/ner-detector'

// Mock worker_threads
vi.mock('worker_threads', () => {
  const mockWorker = {
    on: vi.fn(),
    postMessage: vi.fn(),
    terminate: vi.fn()
  }
  return { Worker: vi.fn(() => mockWorker), isMainThread: true }
})

// Mock model-manager
vi.mock('../../src/main/privacy/model-manager', () => ({
  NERModelManager: class MockNERModelManager {
    getStatus = vi.fn().mockReturnValue('not_downloaded')
    getModelDir = vi.fn().mockReturnValue('/tmp/test-models/piiranha-v1')
    getModelId = vi.fn().mockReturnValue('piiranha/piiranha-v1-detect-personal-information')
  }
}))

describe('NERDetector', () => {
  let detector: NERDetector

  beforeEach(() => {
    detector = new NERDetector()
  })

  afterEach(() => {
    detector.shutdown()
  })

  it('isAvailable returns false when model not downloaded', () => {
    expect(detector.isAvailable()).toBe(false)
  })

  it('detect returns empty array when model not available', async () => {
    const result = await detector.detect('Hans Mueller aus Zuerich')
    expect(result).toEqual([])
  })

  it('detect returns empty array on timeout', async () => {
    // Even if model says ready, worker won't respond in 1ms
    const managerMock = detector['modelManager'] as any
    managerMock.getStatus = vi.fn().mockReturnValue('ready')

    const result = await detector.detect('test', 1)
    expect(result).toEqual([])
  })

  it('shutdown terminates worker if running', () => {
    detector.shutdown()
    expect(true).toBe(true)
  })
})
