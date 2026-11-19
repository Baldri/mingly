/**
 * Coding store: the trigger and the approval surface of ONE coding run.
 * The store decides what may start, what the human may answer, and what is sent
 * to the main process; the main process re-checks all of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CodingConsentRequest } from '../../src/shared/coding-types'

const h = vi.hoisted(() => ({
  consentCallback: null as null | ((r: unknown) => void),
  api: {
    agent: {
      execute: vi.fn(),
      cancel: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      onStep: vi.fn(() => () => undefined)
    },
    fileAccess: { listDirectories: vi.fn(), requestDirectory: vi.fn() },
    codingMode: { get: vi.fn(), set: vi.fn() },
    codingEdits: {
      pending: vi.fn(),
      accept: vi.fn(),
      reject: vi.fn(),
      undo: vi.fn(),
      exportAudit: vi.fn()
    },
    codingConsent: {
      onRequest: vi.fn(),
      respond: vi.fn()
    }
  }
}))

h.api.codingConsent.onRequest.mockImplementation((cb: (r: unknown) => void) => {
  h.consentCallback = cb
  return () => undefined
})
vi.stubGlobal('window', { electronAPI: h.api })

const { useCodingStore, consentOptions, isCodingRunStartable } = await import(
  '../../src/renderer/stores/coding-store'
)
const initialState = useCodingStore.getState()

const GRANT = {
  id: 'd1',
  path: '/Users/x/proj',
  name: 'proj',
  location: 'local',
  permissions: ['read', 'create', 'edit'],
  recursive: true,
  grantedAt: 1,
  confirmedAt: 1,
  accessCount: 0
}

const RUN = { id: 'run_1', status: 'completed', steps: [], task: 't' }

const EDIT = {
  path: 'src/a.ts',
  diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y',
  addedLines: 1,
  removedLines: 1,
  introducesHiddenCharacters: false
}

function request(offers: CodingConsentRequest['offers']): CodingConsentRequest {
  return {
    requestId: 'q1',
    runId: 'run_1',
    stepNumber: 2,
    toolName: 'read_file',
    filePath: 'config/.env',
    matches: [{ type: 'api_key', riskLevel: 'critical' }],
    offers
  }
}

async function ready(mode: string): Promise<void> {
  h.api.fileAccess.listDirectories.mockResolvedValue({ success: true, directories: [GRANT] })
  h.api.codingMode.get.mockResolvedValue({ success: true, mode })
  await useCodingStore.getState().loadProjects()
  useCodingStore.getState().selectProject('d1')
}

const START = { viewMode: 'chat', task: 'fix it', provider: 'anthropic', model: 'm', conversationId: 'c1' }

describe('coding store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.api.codingConsent.onRequest.mockImplementation((cb: (r: unknown) => void) => {
      h.consentCallback = cb
      return () => undefined
    })
    useCodingStore.setState(initialState, true)
    h.api.agent.execute.mockResolvedValue({ success: true, run: RUN })
    h.api.codingEdits.pending.mockResolvedValue({
      success: true,
      kind: 'pending',
      directoryId: 'd1',
      digest: 'dig1',
      edits: [EDIT]
    })
  })

  describe('starting a run', () => {
    it('a coding run is only startable in the chat view', async () => {
      await ready('propose')
      for (const viewMode of ['comparison', 'agent_comparison', 'subagent', '']) {
        const out = await useCodingStore.getState().startRun({ ...START, viewMode })
        expect(out.started).toBe(false)
      }
      expect(h.api.agent.execute).not.toHaveBeenCalled()
      // Positive control: the same state in the chat view does start.
      const ok = await useCodingStore.getState().startRun(START)
      expect(ok.started).toBe(true)
      expect(h.api.agent.execute).toHaveBeenCalledTimes(1)
    })

    it('does not start while the mode is off', async () => {
      await ready('off')
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
      expect(h.api.agent.execute).not.toHaveBeenCalled()
    })

    it('reads an unknown stored mode (even "auto") as off', async () => {
      await ready('auto')
      expect(useCodingStore.getState().modes.d1).toBe('off')
      expect(isCodingRunStartable('chat', 'auto' as never)).toBe(false)
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
    })

    it('does not start without a selected project', async () => {
      h.api.fileAccess.listDirectories.mockResolvedValue({ success: true, directories: [GRANT] })
      h.api.codingMode.get.mockResolvedValue({ success: true, mode: 'propose' })
      await useCodingStore.getState().loadProjects()
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
    })

    it('sends only the directory id: no path, no mode (R35)', async () => {
      await ready('propose')
      await useCodingStore.getState().startRun(START)
      const args = h.api.agent.execute.mock.calls[0]
      expect(args[6]).toEqual({ directoryId: 'd1' })
      expect(JSON.stringify(args)).not.toContain('/Users/x/proj')
    })

    it('loads the pending package after a run that may propose', async () => {
      await ready('propose')
      await useCodingStore.getState().startRun(START)
      expect(h.api.codingEdits.pending).toHaveBeenCalledWith('run_1')
      expect(useCodingStore.getState().pending).toMatchObject({ runId: 'run_1', digest: 'dig1' })
      expect(useCodingStore.getState().lastRun).toEqual({ runId: 'run_1', directoryId: 'd1' })
    })

    it('does not ask for a package after a read-only run', async () => {
      await ready('read-only')
      await useCodingStore.getState().startRun(START)
      expect(h.api.codingEdits.pending).not.toHaveBeenCalled()
      expect(useCodingStore.getState().pending).toBeNull()
    })

    it('a refused start (main process said no) is surfaced, not swallowed', async () => {
      await ready('propose')
      h.api.agent.execute.mockResolvedValue({ success: false, error: 'coding run refused: path does not match the grant' })
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
      expect(useCodingStore.getState().error).toContain('refused')
    })
  })

  describe('mode picker', () => {
    it('the mode picker never offers auto', async () => {
      const { CODING_MODE_CHOICES } = await import('../../src/shared/coding-types')
      const options: string[] = CODING_MODE_CHOICES.map((c) => c.mode)
      expect(options).not.toContain('auto')
      expect(options).toEqual(['off', 'read-only', 'propose', 'propose-run'])
    })

    it('does not send a mode the picker does not offer', async () => {
      await ready('off')
      await useCodingStore.getState().setMode('d1', 'auto' as never)
      expect(h.api.codingMode.set).not.toHaveBeenCalled()
      expect(useCodingStore.getState().modes.d1).toBe('off')
    })

    it('stores an offered mode only after the main process confirmed it', async () => {
      await ready('off')
      h.api.codingMode.set.mockResolvedValue({ success: false, error: 'grant cannot be edited' })
      await useCodingStore.getState().setMode('d1', 'propose')
      expect(useCodingStore.getState().modes.d1).toBe('off')
      expect(useCodingStore.getState().error).toContain('grant cannot be edited')

      h.api.codingMode.set.mockResolvedValue({ success: true, mode: 'propose' })
      await useCodingStore.getState().setMode('d1', 'propose')
      expect(h.api.codingMode.set).toHaveBeenLastCalledWith('d1', 'propose')
      expect(useCodingStore.getState().modes.d1).toBe('propose')
    })

    it('adds a project through the OS picker with read, create and edit', async () => {
      h.api.fileAccess.requestDirectory.mockResolvedValue({ success: true, directory: GRANT })
      h.api.codingMode.get.mockResolvedValue({ success: true, mode: 'off' })
      await useCodingStore.getState().addProject()
      expect(h.api.fileAccess.requestDirectory).toHaveBeenCalledWith(['read', 'create', 'edit'])
      expect(useCodingStore.getState().selectedDirectoryId).toBe('d1')
      expect(useCodingStore.getState().modes.d1).toBe('off')
    })
  })

  describe('consent', () => {
    it('shows only the consent options the request offers', () => {
      expect(consentOptions(request(['send', 'drop-file']))).toEqual(['send', 'drop-file'])
      expect(consentOptions(request(['drop-file']))).toEqual(['drop-file'])
      expect(consentOptions(request(['send', 'anonymize', 'drop-file']))).toEqual(['send', 'anonymize', 'drop-file'])
      expect(consentOptions(request(['send', 'drop-file']))).not.toContain('anonymize')
    })

    it('a malformed offers list shows nothing it did not offer', () => {
      const bad = { ...request(['send']), offers: ['send', 'wipe-disk', 7] } as unknown as CodingConsentRequest
      expect(consentOptions(bad)).toEqual(['send'])
    })

    it('opens on a request from the main process and answers with its ids', async () => {
      expect(h.consentCallback).toBeTypeOf('function')
      h.consentCallback?.(request(['send', 'drop-file']))
      expect(useCodingStore.getState().consent?.requestId).toBe('q1')
      h.api.codingConsent.respond.mockResolvedValue({ success: true, settled: true })
      await useCodingStore.getState().respondConsent('drop-file')
      expect(h.api.codingConsent.respond).toHaveBeenCalledWith('run_1', 'q1', 'drop-file')
      expect(useCodingStore.getState().consent).toBeNull()
    })

    it('tells the user when the answer settled nothing (the question had expired)', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockResolvedValue({ success: true, settled: false })
      await useCodingStore.getState().respondConsent('send')
      const state = useCodingStore.getState()
      // The question is gone, but the user is told what really happened.
      expect(state.consent).toBeNull()
      expect(state.error).toMatch(/abgelaufen/)
      expect(state.error).toMatch(/ohne diese Datei/)
    })

    it('a reply without a settled flag is not read as settled', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockResolvedValue({ success: true })
      await useCodingStore.getState().respondConsent('send')
      expect(useCodingStore.getState().error).toMatch(/abgelaufen/)
    })

    it('a refused call (success: false) keeps the question open and shows the reason', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockResolvedValue({ success: false, error: 'Rate limit exceeded.' })
      await useCodingStore.getState().respondConsent('send')
      const state = useCodingStore.getState()
      expect(state.consent).not.toBeNull()
      expect(state.error).toContain('Rate limit exceeded.')
    })

    it('a non-Error throw still renders a non-empty error', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockRejectedValue('boom')
      await useCodingStore.getState().respondConsent('send')
      const error = useCodingStore.getState().error
      expect(typeof error).toBe('string')
      expect((error ?? '').length).toBeGreaterThan(0)
    })

    it('does not send a choice the request did not offer', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      await useCodingStore.getState().respondConsent('anonymize')
      expect(h.api.codingConsent.respond).not.toHaveBeenCalled()
      // The question stays open: nothing was answered.
      expect(useCodingStore.getState().consent).not.toBeNull()
    })
  })

  describe('package decision', () => {
    async function withPending(): Promise<void> {
      await ready('propose')
      await useCodingStore.getState().startRun(START)
    }

    it('sends the rejection reason along with the rejection', async () => {
      await withPending()
      h.api.codingEdits.reject.mockResolvedValue({ success: true, outcome: { kind: 'rejected', count: 1 } })
      await useCodingStore.getState().rejectPending('Falsche Datei angepasst')
      expect(h.api.codingEdits.reject).toHaveBeenCalledWith('run_1', 'Falsche Datei angepasst')
      expect(useCodingStore.getState().pending).toBeNull()
    })

    it('accepts with the digest of the package the human was shown', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: true,
        outcome: { kind: 'applied', paths: ['src/a.ts'] }
      })
      await useCodingStore.getState().acceptPending()
      expect(h.api.codingEdits.accept).toHaveBeenCalledWith('run_1', 'd1', 'dig1')
      expect(useCodingStore.getState().pending).toBeNull()
      expect(useCodingStore.getState().applied).toEqual({ runId: 'run_1', directoryId: 'd1', paths: ['src/a.ts'] })
    })

    it('a refused accept keeps the package and shows the reason', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', reason: 'Nothing was written: the package changed.' }
      })
      await useCodingStore.getState().acceptPending()
      expect(useCodingStore.getState().pending).not.toBeNull()
      expect(useCodingStore.getState().error).toContain('Nothing was written')
      expect(useCodingStore.getState().applied).toBeNull()
    })

    it('shows what undo did not restore, with the reason', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({ success: true, outcome: { kind: 'applied', paths: ['src/a.ts', 'src/b.ts'] } })
      await useCodingStore.getState().acceptPending()
      h.api.codingEdits.undo.mockResolvedValue({
        success: true,
        outcome: {
          kind: 'restored',
          restored: ['src/a.ts'],
          skipped: [{ path: 'src/b.ts', reason: 'changed-since-apply' }]
        }
      })
      await useCodingStore.getState().undoLast()
      expect(h.api.codingEdits.undo).toHaveBeenCalledWith('run_1', 'd1')
      const undo = useCodingStore.getState().undo
      expect(undo?.complete).toBe(false)
      expect(undo?.skipped.map((s) => s.path)).toEqual(['src/b.ts'])
    })

    it('exports the audit as CSV text, without a feature gate argument', async () => {
      h.api.codingEdits.exportAudit.mockResolvedValue({ success: true, csv: 'a,b\n1,2\n' })
      const csv = await useCodingStore.getState().exportAudit()
      expect(csv).toBe('a,b\n1,2\n')
      expect(h.api.codingEdits.exportAudit).toHaveBeenCalledTimes(1)
    })

    it('a failed export is an error, not an empty file', async () => {
      h.api.codingEdits.exportAudit.mockResolvedValue({ success: false, error: 'bad since' })
      expect(await useCodingStore.getState().exportAudit()).toBeNull()
      expect(useCodingStore.getState().error).toContain('bad since')
    })
  })
})
