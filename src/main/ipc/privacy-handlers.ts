/**
 * IPC Handlers — Privacy (Swiss AI Privacy)
 * Exposes PII detection, anonymization, and rehydration to the renderer.
 */

import { IPC_CHANNELS } from '../../shared/types'
import { wrapHandler } from './ipc-utils'
import { PIIAnonymizer } from '../privacy/anonymizer'
import { NERDetector } from '../privacy/ner-detector'
import { PrivacySessionMap } from '../privacy/session-map'
import { rehydrate } from '../privacy/rehydrator'
import { detectPII } from '../privacy/detector-pipeline'
import type { PrivacyMode, PIICategory } from '../privacy/pii-types'

/** Active anonymizer instances per conversation session */
const anonymizers = new Map<string, PIIAnonymizer>()
/** Active session maps per conversation session */
const sessionMaps = new Map<string, PrivacySessionMap>()

function getOrCreateAnonymizer(sessionId: string, mode: PrivacyMode = 'shield'): PIIAnonymizer {
  let anon = anonymizers.get(sessionId)
  if (!anon) {
    anon = new PIIAnonymizer(sessionId, mode)
    anonymizers.set(sessionId, anon)
  }
  return anon
}

let nerDetector: NERDetector | null = null
function getNERDetector(): NERDetector {
  if (!nerDetector) nerDetector = new NERDetector()
  return nerDetector
}

function getOrCreateSessionMap(sessionId: string): PrivacySessionMap {
  let map = sessionMaps.get(sessionId)
  if (!map) {
    map = new PrivacySessionMap(sessionId)
    sessionMaps.set(sessionId, map)
  }
  return map
}

export function registerPrivacyHandlers(): void {
  // Anonymize text (detect PII + replace with fake data or markers)
  wrapHandler(IPC_CHANNELS.PRIVACY_ANONYMIZE, async (sessionId: string, text: string) => {
    const anon = getOrCreateAnonymizer(sessionId)
    const result = await anon.anonymize(text)

    // Sync replacements into session map
    const map = getOrCreateSessionMap(sessionId)
    const categoryMap = new Map<string, PIICategory>()
    for (const r of result.replacements) {
      categoryMap.set(r.entity.original, r.entity.category)
    }
    map.importFromAnonymizer(anon.getReplacementMap(), categoryMap)

    return result
  })

  // Rehydrate LLM response (replace fake data back with originals)
  wrapHandler(IPC_CHANNELS.PRIVACY_REHYDRATE, (sessionId: string, text: string) => {
    const map = getOrCreateSessionMap(sessionId)
    const anon = anonymizers.get(sessionId)
    const mode = anon?.getMode() ?? 'shield'
    return rehydrate(text, map, mode)
  })

  // Get current privacy mode for a session
  wrapHandler(IPC_CHANNELS.PRIVACY_GET_MODE, (sessionId: string) => {
    const anon = anonymizers.get(sessionId)
    return { mode: anon?.getMode() ?? 'shield' }
  })

  // Set privacy mode for a session
  wrapHandler(IPC_CHANNELS.PRIVACY_SET_MODE, (sessionId: string, mode: PrivacyMode) => {
    const anon = getOrCreateAnonymizer(sessionId, mode)
    anon.setMode(mode)
    return { success: true, mode }
  })

  // Get all PII mappings for a session (for UI display)
  wrapHandler(IPC_CHANNELS.PRIVACY_GET_SESSION_MAPPINGS, (sessionId: string) => {
    const map = sessionMaps.get(sessionId)
    return { mappings: map?.getAllMappings() ?? [] }
  })

  // Clear session data (on conversation end)
  wrapHandler(IPC_CHANNELS.PRIVACY_CLEAR_SESSION, (sessionId: string) => {
    anonymizers.get(sessionId)?.clear()
    anonymizers.delete(sessionId)
    sessionMaps.get(sessionId)?.clear()
    sessionMaps.delete(sessionId)
    return { success: true }
  })

  // Detect PII without anonymizing (for preview/UI)
  wrapHandler(IPC_CHANNELS.PRIVACY_DETECT_PII, async (text: string) => {
    return await detectPII(text)
  })

  // NER Model Status
  wrapHandler(IPC_CHANNELS.PRIVACY_NER_STATUS, () => {
    const ner = getNERDetector()
    const manager = ner.getModelManager()
    return {
      status: manager.getStatus(),
      progress: manager.getDownloadProgress()
    }
  })

  // NER Model Download
  wrapHandler(IPC_CHANNELS.PRIVACY_NER_DOWNLOAD, async () => {
    const ner = getNERDetector()
    const manager = ner.getModelManager()
    try {
      await manager.download((percent) => {
        const { BrowserWindow } = require('electron')
        BrowserWindow.getAllWindows().forEach((win: any) => {
          win.webContents.send('privacy:ner-progress', percent)
        })
      })
      return { success: true }
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // NER Model Delete
  wrapHandler(IPC_CHANNELS.PRIVACY_NER_DELETE, () => {
    const ner = getNERDetector()
    ner.getModelManager().deleteModel()
    ner.shutdown()
    return { success: true }
  })
}

/** Exported for testing */
export { anonymizers, sessionMaps }
